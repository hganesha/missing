"""Offline representative adapters, NOT live vendor clients.
Only the documented fields exercised by synthetic fixtures are mapped.
Transport/authentication/webhook verification are deliberately not implemented.
"""
from pathlib import Path
import copy,json,hashlib,argparse
ROOT=Path(__file__).resolve().parents[1]
ADAPTERS={'sumsub':('sumsub','identity.person.verify','verification'), 'veriff':('veriff','identity.person.verify','verification'),'persona':('persona','identity.person.verify','verification'),'middesk':('middesk','business.verify','business'),'companies_house':('companies-house','business.registry.lookup','business'),'opencorporates':('opencorporates','business.registry.lookup','business'),'gleif':('gleif','reference.identifier.lookup','reference'),'opensanctions':('opensanctions','screening.sanctions','screening'),'plaid':('plaid','account.ownership.verify','account')}
def canonical_bytes(payload):return json.dumps(payload,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()
def digest(payload):return hashlib.sha256(canonical_bytes(payload)).hexdigest()
def entity(eid,kind='person',name=None,identifiers=None):
 return {'entity_id':eid,'entity_type':kind,'names':[{'full':name,'kind':'legal'}] if name else [],'identifiers':identifiers or []}
def ident(scheme,value,jurisdiction=None):
 d={'scheme':scheme,'value':str(value)}
 if jurisdiction:d['jurisdiction']=jurisdiction
 return d

def normalize(adapter_id,payload,*,request_id='demo-request',tenant_id='demo-tenant',subject_entity_id='subject-001',received_at='2026-10-15T12:00:00Z',raw_vault_ref=None):
 """Normalize a decoded, already-authenticated payload. Never infer a bank decision.
 raw_vault_ref is a caller-owned encrypted artifact locator in real deployments.
 The example digest is over canonical JSON, NOT the original HTTP byte stream.
 """
 if adapter_id not in ADAPTERS:raise ValueError('unsupported adapter')
 provider,cap,kind=ADAPTERS[adapter_id];h=digest(payload)
 sid=subject_entity_id; ev='ev-'+h[:16]
 results={'verification':{'kind':kind,'checks':[],'assertion_ids':[]},'business':{'kind':kind,'organization_entity_id':sid,'checks':[],'assertion_ids':[]},'reference':{'kind':kind,'record_entity_ids':[sid],'relationship_ids':[]},'screening':{'kind':kind,'matches':[],'dataset_versions':[],'scope':['configured_scope_unverified'],'truncated':False,'total_candidates':0},'account':{'kind':kind,'accounts':[]}}
 out={'schema_version':'1.0.0','result_id':hashlib.sha256((tenant_id+'|'+request_id+'|'+adapter_id+'|'+h).encode()).hexdigest(),'request_id':request_id,'tenant_id':tenant_id,'subject_entity_id':sid,'capability':cap,'provider':{'provider_id':provider,'adapter_version':'0.1.0','status_original':None,'decision_origin':'unknown'},'execution':{'status':'unknown','received_at':received_at},'assessment':{'outcome':'unknown','reason_codes':[],'bank_decision':'not_evaluated'},'coverage':{'status':'unknown','requested_scope':[cap],'checked_scope':[],'not_checked_scope':[cap],'reason':'Fixture mapping only; entitled datasets and country coverage not established'},'entities':[entity(sid)],'relationships':[],'assertions':[],'evidence':[{'evidence_id':ev,'provider_id':provider,'retrieved_at':received_at,'content_sha256':h,'source_pointer':'/','authority':'unknown','access_classification':'restricted'}],'result':results[kind],'errors':[],'warnings':['SYNTHETIC_FIXTURE_NOT_VENDOR_TESTED','Coverage and bank decision are not inferred from this payload'],'raw_payload':{'vault_ref':raw_vault_ref or 'example://canonical-json/'+h,'sha256':h,'classification':'restricted'},'extensions':{'digest_representation':'canonical JSON UTF-8; not signed HTTP bytes'}}
 def status(original,execution,outcome,origin):
  out['provider'].update(status_original=original,decision_origin=origin);out['execution']['status']=execution;out['assessment']['outcome']=outcome
 def check(name,outcome,reason=None):
  x={'check_id':'check-'+str(len(out['result']['checks'])+1),'name':name,'outcome':outcome,'evidence_ids':[ev]}
  if reason:x['reason_codes']=[str(reason)]
  out['result']['checks'].append(x)
 def assertion(field,value,verification='unknown'):
  if value is None:return
  aid='assert-'+str(len(out['assertions'])+1)
  out['assertions'].append({'assertion_id':aid,'entity_id':sid,'field_path':field,'value':value,'verification':verification,'evidence_ids':[ev]})
  if 'assertion_ids'in out['result']:out['result']['assertion_ids'].append(aid)
 def business(name,number=None,jurisdiction=None,scheme='company_registration',original_status=None):
  ent=entity(sid,'organization',name,[ident(scheme,number,jurisdiction)] if number else [])
  if jurisdiction:ent['jurisdiction']=jurisdiction
  if original_status is not None:ent.update(status_original=str(original_status),status='unknown')
  ent['evidence_ids']=[ev];out['entities'][0]=ent
  assertion('names',ent['names']);assertion('status_original',original_status)
 pristine=copy.deepcopy(out['result'])
 try:
  if not isinstance(payload,dict):raise ValueError('expected JSON object')
  if adapter_id=='sumsub':
   if not payload.get('applicantId'):raise ValueError('missing applicantId')
   out['provider']['provider_record_id']=str(payload['applicantId'])
   rr=payload.get('reviewResult',{});original=rr.get('reviewAnswer');reject=rr.get('reviewRejectType')
   if payload.get('type')=='applicantReviewed' and original in ['GREEN','RED']:
    outcome='passed' if original=='GREEN' else 'resubmit' if reject=='RETRY' else 'failed' if reject=='FINAL' else 'inconclusive'
    status(original,'completed',outcome,'provider_workflow')
    check('applicant_review',{'passed':'passed','failed':'failed'}.get(outcome,'inconclusive'))
    labels=rr.get('rejectLabels') or []
    if not isinstance(labels,list):raise ValueError('rejectLabels must be an array')
    out['assessment']['reason_codes']=[str(x) for x in labels]
   else:status(original,'unknown','unknown','provider_workflow');out['warnings'].append('UNMAPPED_SUMSUB_EVENT_OR_ANSWER')
   # clientComment is never copied into host summaries.
  elif adapter_id=='veriff':
   v=payload.get('verification');
   if not isinstance(v,dict) or not v.get('id'):raise ValueError('missing verification.id')
   st=v.get('status');out['provider']['provider_record_id']=v['id']
   m={'approved':('completed','passed'),'declined':('completed','failed'),'resubmission_requested':('pending','resubmit'),'review':('completed','review'),'expired':('completed','inconclusive'),'abandoned':('completed','inconclusive'),'started':('pending','not_checked'),'submitted':('pending','not_checked')}
   ex,oc=m.get(st,('unknown','unknown'));status(st,ex,oc,'provider_check');check('identity_verification',oc if oc in ['passed','failed','not_checked','unknown'] else 'inconclusive',v.get('reasonCode'))
   p=v.get('person',{});name=' '.join(p.get(k,'') or '' for k in ['firstName','lastName']).strip()
   if name:out['entities'][0]['names']=[{'full':name,'kind':'legal'}];assertion('names',out['entities'][0]['names'],'verified' if st=='approved' else 'unknown')
  elif adapter_id=='persona':
   d=payload.get('data',{})
   if d.get('type')=='event':d=d.get('attributes',{}).get('payload',{}).get('data',{})
   if d.get('type')!='inquiry' or not d.get('id'):raise ValueError('expected inquiry data resource')
   a=d.get('attributes',{});st=a.get('status');out['provider']['provider_record_id']=d['id'];out['provider']['api_version']='2026-09-29 (target; fixture subset)'
   m={'approved':('completed','passed'),'declined':('completed','failed'),'completed':('completed','inconclusive'),'failed':('completed','failed'),'expired':('completed','inconclusive'),'needs-review':('completed','review'),'needs_review':('completed','review'),'created':('pending','not_checked'),'pending':('pending','not_checked'),'started':('pending','not_checked')}
   ex,oc=m.get(st,('unknown','unknown'));status(st,ex,oc,'client_workflow' if st in ['approved','declined','needs-review','needs_review'] else 'provider_workflow')
   check('inquiry_workflow',oc if oc in ['passed','failed','not_checked','unknown'] else 'inconclusive')
   if st=='completed':out['warnings'].append('COMPLETED_IS_NOT_APPROVED')
  elif adapter_id=='middesk':
   b=payload['data'].get('object') if isinstance(payload.get('data'),dict) else payload
   if not isinstance(b,dict):raise ValueError('event envelope missing data.object')
   if not b.get('id'):raise ValueError('missing business.id')
   st=b.get('status');out['provider']['provider_record_id']=b['id'];business(b.get('name'),original_status=st)
   m={'open':('pending','not_checked'),'pending':('pending','not_checked'),'in_audit':('pending','inconclusive'),'in_review':('completed','review'),'approved':('completed','inconclusive'),'rejected':('completed','inconclusive')}
   ex,oc=m.get(st,('unknown','unknown'));status(st,ex,oc,'client_workflow' if st in ['approved','rejected'] else 'provider_workflow')
   if st in ['approved','rejected']:out['warnings'].append('CLIENT_WORKFLOW_STATUS_NOT_INDEPENDENT_VERIFICATION')
   for t in b.get('review',{}).get('tasks',[]):
    check(t.get('key',t.get('name','task')),{'success':'passed','failure':'failed','warning':'inconclusive'}.get(t.get('status'),'unknown'))
  elif adapter_id=='companies_house':
   if not payload.get('company_number'):raise ValueError('missing company_number')
   business(payload.get('company_name'),payload['company_number'],'GB','companies_house_number',payload.get('company_status'))
   out['provider']['provider_record_id']=payload['company_number'];status(payload.get('company_status'),'completed','inconclusive','data_only');out['evidence'][0]['authority']='official'
   assertion('incorporation_date',payload.get('date_of_creation'))
   # Registry existence is not verification of the applicant or sanctioned ownership.
  elif adapter_id=='opencorporates':
   b=payload.get('results',{}).get('company',{})
   if not b.get('company_number') or not b.get('jurisdiction_code'):raise ValueError('missing company identifier namespace')
   business(b.get('name'),b['company_number'],b['jurisdiction_code'],'opencorporates_registration',b.get('current_status'))
   out['provider']['provider_record_id']=b['jurisdiction_code']+'/'+b['company_number'];status(b.get('current_status'),'completed','inconclusive','data_only');assertion('incorporation_date',b.get('incorporation_date'));out['warnings'].append('INACTIVE_FALSE_OR_MISSING_DOES_NOT_PROVE_ACTIVE')
  elif adapter_id=='gleif':
   d=payload.get('data',{});
   if not isinstance(d,dict) or not d.get('id'):raise ValueError('expected single LEI resource')
   a=d.get('attributes',{});e=a.get('entity',{});lei=a.get('lei') or d['id']
   if lei!=d['id']:raise ValueError('attributes.lei disagrees with resource id')
   business(e.get('legalName',{}).get('name'),lei,e.get('jurisdiction'),'LEI',e.get('status'));out['provider']['provider_record_id']=lei;status(e.get('status'),'completed','inconclusive','data_only');out['warnings'].append('LEI_LEVEL2_PARENTS_ARE_NOT_NATURAL_PERSON_UBOS')
   out['result'].update(dataset_id='gleif_lei',record_count=1)
  elif adapter_id=='opensanctions':
   responses=payload.get('responses')
   if not isinstance(responses,dict) or len(responses)!=1:raise ValueError('single query fixture adapter requires exactly one response')
   qid,r=next(iter(responses.items()));out['provider']['provider_request_id']=qid
   if r.get('status')!=200:raise ValueError('query did not succeed')
   candidates=r.get('results')
   if not isinstance(candidates,list):raise ValueError('missing results array')
   total=r.get('total',{})
   total_value=total.get('value') if isinstance(total,dict) else total
   truncated=bool(r.get('next')) or isinstance(total_value,int) and total_value>len(candidates)
   status('query_status_200','partial' if truncated else 'completed','review' if candidates else 'inconclusive','data_only')
   out['result'].update(total_candidates=max(total_value,len(candidates)) if isinstance(total_value,int) and not isinstance(total_value,bool) else len(candidates),truncated=truncated)
   for i,c in enumerate(candidates):
    cid=provider+':'+str(c.get('id',i))
    if any(x['entity_id']==cid for x in out['entities']):raise ValueError('duplicate candidate id')
    e=entity(cid,'person' if c.get('schema')=='Person' else 'organization' if c.get('schema') in ['Company','LegalEntity','Organization'] else 'unknown',c.get('caption'))
    e.update(source_record_ids=[str(c.get('id',i))],evidence_ids=[ev]);out['entities'].append(e)
    score=[]
    if isinstance(c.get('score'),(int,float)) and not isinstance(c.get('score'),bool):score=[{'name':'provider_match_score','value':c['score'],'direction':'higher_is_better_match','semantics':'Provider-specific matching score; not identity certainty or comparable to other vendors'}]
    out['result']['matches'].append({'match_id':'match-'+str(i+1),'subject_entity_id':sid,'candidate_entity_id':cid,'categories':c.get('properties',{}).get('topics',[]),'list_ids':c.get('datasets',[]),'scores':score,'disposition':'unresolved','evidence_ids':[ev]})
   out['warnings'].append('EMPTY_CANDIDATE_SET_DOES_NOT_ESTABLISH_CLEARANCE')
  elif adapter_id=='plaid':
   if not isinstance(payload.get('accounts'),list):raise ValueError('missing accounts array')
   status('response_received','completed','inconclusive','data_only');out['provider']['provider_request_id']=str(payload.get('request_id','unknown'))
   for i,a in enumerate(payload['accounts']):
    aid='plaid:account:'+str(a.get('account_id',i));out['entities'].append(entity(aid,'account'))
    scores=[]
    for k in ['legal_name','phone_number','email_address','address']:
     field=a.get(k) or {};v=field.get('score')
     if v is not None and (isinstance(v,bool) or not isinstance(v,(int,float))):raise ValueError('non-numeric Plaid score')
     if v is not None:scores.append({'name':k,'value':v,'scale_min':0,'scale_max':100,'direction':'higher_is_better_match','semantics':'Plaid field match score; bank policy threshold and account authorization remain separate'})
    out['result']['accounts'].append({'account_entity_id':aid,'field_scores':scores,'ownership_outcome':'inconclusive','checks':[]})
   out['warnings'].append('NO_ACCOUNT_HOLDER_EDGE_CREATED_FROM_SCORES_ALONE')
 except (ValueError,TypeError,KeyError,AttributeError) as e:
  out['execution']['status']='failed';out['assessment']['outcome']='unknown'
  out['errors'].append({'code':'PAYLOAD_CONTRACT_MISMATCH','category':'schema_drift','message':str(e),'retryable':False})
  # Do not leak partially normalized checks, matches, entities or assertions after a malformed result.
  out.update(entities=[entity(sid)],relationships=[],assertions=[],result=pristine)
  out['provider'].update(status_original=None,decision_origin='unknown')
 return out

def validate_semantics(result):
 """Cross-record referential checks that JSON Schema cannot enforce."""
 errors=[];ids=[e['entity_id'] for e in result['entities']];known=set(ids);evs={e['evidence_id'] for e in result['evidence']}
 if len(ids)!=len(known):errors.append('duplicate entity IDs')
 if result['subject_entity_id']not in known:errors.append('unknown subject')
 for e in result['relationships']:
  if e['from_entity_id']not in known or e['to_entity_id']not in known:errors.append('dangling relationship')
  if not set(e['evidence_ids'])<=evs:errors.append('dangling evidence')
  o=e.get('ownership',{});lo=o.get('lower_percent');hi=o.get('upper_percent')
  if lo is not None and hi is not None and lo>hi:errors.append('invalid ownership interval')
  if e['type']=='same_as' and e['assertion_status']!='confirmed':errors.append('same_as requires confirmed assertion')
 for a in result['assertions']:
  if a['entity_id']not in known:errors.append('dangling assertion entity')
  if not set(a['evidence_ids'])<=evs:errors.append('dangling assertion evidence')
 for m in result['result'].get('matches',[]):
  if m['subject_entity_id']not in known or m['candidate_entity_id']not in known:errors.append('dangling match')
 if result['assessment']['bank_decision']!='not_evaluated' and not all(result['assessment'].get(k) for k in ['policy_id','policy_version','actor']):errors.append('bank decision missing policy provenance')
 return errors

def resolve_identifier_connections(entities):
 """Exact identifier CANDIDATES only. Does not merge or confirm. Scheme and jurisdiction required.
 Conflicting names or DOBs, identifier reassignment and shared account identifiers require review.
 """
 buckets={};candidates=[]
 for e in entities:
  for i in e.get('identifiers',[]):
   if i['scheme']!='LEI' and not i.get('jurisdiction'):continue
   key=(i['scheme'],i.get('jurisdiction','GLOBAL'),i['value'])
   for prev in buckets.get(key,[]):
    if prev!=e['entity_id']:candidates.append({'left_entity_id':prev,'right_entity_id':e['entity_id'],'outcome':'possible','method':'exact_namespaced_identifier','evidence_ids':[], 'matched_features':['identifier:'+':'.join(key)]})
   buckets.setdefault(key,[]).append(e['entity_id'])
 return candidates

def plan_request(adapter_id,request):
 """Build a non-executable request plan. No secrets or HTTP client; allowlist and consent checked externally.
 Unknown adapter/capability or missing required input fails closed.
 """
 if adapter_id not in ADAPTERS:raise ValueError('unsupported adapter')
 provider,cap,_=ADAPTERS[adapter_id]
 if request['capability']!=cap:raise ValueError('unsupported capability for representative adapter')
 subject=next((e for e in request['entities'] if e['entity_id']==request['subject_entity_id']),None)
 if subject is None:raise ValueError('subject entity missing from request')
 record=request['input'].get('provider_record_id'); name=next((n['full'] for n in subject['names'] if n['kind']=='legal'),None)
 p={'provider_id':provider,'executable':False,'headers':{},'body':None,'limitations':['Resolve secret references and validate entitlements outside this offline plan']}
 if adapter_id=='companies_house':
  if not record or not (record.isascii() and record.isalnum()):raise ValueError('safe company number required')
  p.update(method='GET',path='/company/'+record,authentication='Basic API key: empty password')
 elif adapter_id=='opencorporates':
  ids=[x for x in subject['identifiers'] if x['scheme']=='opencorporates_registration']
  if not ids:raise ValueError('namespaced registration identifier required')
  from urllib.parse import quote
  p.update(method='GET',path='/v0.4/companies/'+quote(ids[0]['jurisdiction'],safe='')+'/'+quote(ids[0]['value'],safe=''),authentication='API token via secure transport; redact URLs')
 elif adapter_id=='gleif':
  if not record or not re_full_lei(record):raise ValueError('20-character LEI required; checksum validation external')
  p.update(method='GET',path='/api/v1/lei-records/'+record,authentication='public endpoint; verify current terms')
 elif adapter_id=='opensanctions':
  if not name:raise ValueError('legal name required')
  p.update(method='POST',path='/match/default',authentication='ApiKey secret reference',body={'queries':{'q':{'schema':'Person' if subject['entity_type']=='person' else 'Company','properties':{'name':[name]}}}})
 elif adapter_id=='plaid':
  token=request['input'].get('account_token_ref')
  if not token or not request.get('consent_ref') or not name:raise ValueError('account token reference, consent and legal name required')
  p.update(method='POST',path='/identity/match',authentication='client credentials and access token injected securely',body={'access_token':{'secret_ref':token},'user':{'legal_name':name}})
 elif adapter_id=='persona':
  if not record:raise ValueError('inquiry ID required')
  from urllib.parse import quote
  p.update(method='GET',path='/api/v1/inquiries/'+quote(record,safe=''),authentication='Bearer secret reference',headers={'Persona-Version':'2026-09-29','Key-Inflection':'kebab'})
 else:raise NotImplementedError('Only inbound fixture normalization implemented for this adapter; obtain vendor-native request specification')
 return p

def re_full_lei(value):
 import re
 return bool(re.fullmatch('[A-Z0-9]{20}',value))
if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('adapter',choices=ADAPTERS);parser.add_argument('payload');parser.add_argument('--out');args=parser.parse_args()
 value=normalize(args.adapter,json.loads(Path(args.payload).read_text()))
 from jsonschema import Draft202012Validator
 problems=[e.message for e in Draft202012Validator(json.loads((ROOT/'schemas/host.schema.json').read_text())).iter_errors(value)]+validate_semantics(value)
 if problems:raise SystemExit('normalized output failed host schema/semantic validation: '+'; '.join(problems[:5]))
 text=json.dumps(value,indent=2)
 if args.out:Path(args.out).write_text(text+'\n')
 else:print(text)
