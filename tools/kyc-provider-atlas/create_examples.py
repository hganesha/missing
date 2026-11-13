from pathlib import Path
import sys,json,copy
P=Path(__file__).parent
sys.path.insert(0,str(P))
from adapters.runtime import normalize,ADAPTERS,entity,ident,resolve_identifier_connections,plan_request
def dump(path,x):
 p=P/path;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(json.dumps(x,indent=2,ensure_ascii=False)+'\n')
fixtures={
 'sumsub':{'applicantId':'synthetic-applicant-1','inspectionId':'synthetic-inspection','type':'applicantReviewed','reviewStatus':'completed','externalUserId':'synthetic-customer','reviewResult':{'reviewAnswer':'RED','reviewRejectType':'RETRY','rejectLabels':['BAD_PROOF_OF_IDENTITY'],'clientComment':'INTERNAL ONLY: deliberately not copied to host'}},
 'veriff':{'status':'success','verification':{'id':'synthetic-session-1','status':'approved','code':9001,'person':{'firstName':'Alex','lastName':'Example'},'decisionTime':'2026-10-15T11:59:00Z'}},
 'persona':{'data':{'type':'inquiry','id':'inq_synthetic','attributes':{'status':'completed','fields':{'name-first':{'type':'string','value':'Alex'},'name-last':{'type':'string','value':'Example'}}}}},
 'middesk':{'data':{'object':{'id':'synthetic-business','name':'Example Workshop LLC','status':'in_review','review':{'tasks':[{'key':'name','status':'success'},{'key':'watchlist','status':'success','sub_label':'No Hits'}]}}}},
 'companies_house':{'company_name':'EXAMPLE WORKSHOP LTD','company_number':'00000001','company_status':'active','jurisdiction':'england-wales','date_of_creation':'2020-01-01','registered_office_address':{'address_line_1':'1 Example Street','locality':'London','country':'England','postal_code':'EX1 1AA'}},
 'opencorporates':{'api_version':'0.4','results':{'company':{'name':'EXAMPLE WORKSHOP LTD','company_number':'00000001','jurisdiction_code':'gb','current_status':'Active','inactive':False,'incorporation_date':'2020-01-01'}}},
 'gleif':{'data':{'type':'lei-records','id':'00000000000000000001','attributes':{'lei':'00000000000000000001','entity':{'legalName':{'name':'Example Holding Ltd'},'status':'ACTIVE','jurisdiction':'GB'},'registration':{'status':'ISSUED'}}}},
 'opensanctions':{'responses':{'q':{'status':200,'total':{'value':1,'relation':'eq'},'results':[{'id':'synthetic-candidate','caption':'Alex Example','schema':'Person','score':0.94,'datasets':['synthetic_list_NOT_REAL'],'properties':{'name':['Alex Example'],'topics':['sanction']}}]}}},
 'plaid':{'request_id':'synthetic-plaid-request','accounts':[{'account_id':'synthetic-account','legal_name':{'score':94},'phone_number':{'score':None},'email_address':{'score':73},'address':{'score':88}}]}}
for aid,payload in fixtures.items():
 dump('examples/native/'+aid+'.json',payload);dump('examples/host/'+aid+'.json',normalize(aid,payload,raw_vault_ref='example://examples/native/'+aid+'.json'))
# Request/manifest specs: sample wire fields are documented; all transport remains disabled.
sources=json.loads((P/'research/sources.json').read_text())
info={
 'sumsub':(None,None,None,'App token + request signature; webhook signature must be verified before parsing',['S01'],[('/reviewResult/reviewAnswer','/assessment/outcome','GREEN=>passed; RED+RETRY=>resubmit; RED+FINAL=>failed'),('/applicantId','/provider/provider_record_id','copy opaque ID'),('/reviewResult/rejectLabels','/assessment/reason_codes','copy; private clientComment excluded')]),
 'veriff':(None,None,None,'API key + HMAC; provider webhook signature verification required',['S02'],[('/verification/status','/assessment/outcome','map status text; 9104 alone ambiguous'),('/verification/id','/provider/provider_record_id','copy opaque ID'),('/verification/person','/entities/0/names','approved person names; only fields exercised by fixture')]),
 'persona':('GET','/api/v1/inquiries/{inquiry-id}','2026-09-29','Bearer; Persona-Version and Key-Inflection headers',['S03','S04','S05'],[('/data/attributes/status','/assessment/outcome','completed=>inconclusive; approved=>passed; never final bank decision'),('/data/id','/provider/provider_record_id','copy'),('/data/attributes/payload/data','/','unwrap event if data.type is event')]),
 'middesk':(None,None,None,'Basic API key or OAuth depending on integration; webhook verification required',['S06','S07','S08'],[('/data/object/status','/assessment/outcome','in_review=>review; approved/rejected are client workflow, not independent KYC'),('/data/object/review/tasks/*/status','/result/checks/*/outcome','success=>passed task only; no blanket approval'),('/data/object/name','/entities/0/names','organization name; do not infer legal registration number')]),
 'companies_house':('GET','/company/{company_number}',None,'Basic API key with empty password; confirm current contract',['S09'],[('/company_number','/entities/0/identifiers','scheme companies_house_number; GB namespace'),('/company_status','/entities/0/status_original','preserve; canonical status unknown until enum/jurisdiction policy added'),('/company_name','/entities/0/names','copy legal name; data lookup not applicant verification')]),
 'opencorporates':('GET','/v0.4/companies/{jurisdiction_code}/{company_number}','0.4','API token; redact query strings in logs',['S10'],[('/results/company/company_number','/entities/0/identifiers','pair number with jurisdiction_code'),('/results/company/current_status','/entities/0/status_original','preserve; inactive false does not prove active'),('/results/company/name','/entities/0/names','copy legal name')]),
 'gleif':('GET','/api/v1/lei-records/{lei}','v1','Public endpoint; fair-use terms apply',['S11','S12'],[('/data/attributes/lei','/entities/0/identifiers','scheme LEI; example not checksum-valid'),('/data/attributes/entity/legalName/name','/entities/0/names','copy'),('/data/attributes/entity/status','/entities/0/status_original','entity status distinct from LEI registration.status; no UBO inference')]),
 'opensanctions':('POST','/match/{dataset}',None,'Authorization: ApiKey; commercial data license',['S13','S14','S15'],[('/responses/{query}/results/*/id','/entities/*/source_record_ids','create separate candidate entity, never merge automatically'),('/responses/{query}/results/*/score','/result/matches/*/scores','raw provider-specific score; no cross-provider normalization'),('/responses/{query}/results/*/properties/topics','/result/matches/*/categories','retain provider taxonomy; disposition unresolved')]),
 'plaid':('POST','/identity/match',None,'Client credentials and consented access token; never store secrets in manifests',['S17','S18'],[('/accounts/*/legal_name/score','/result/accounts/*/field_scores','0..100 match score; no bank decision or account holder assertion'),('/accounts/*/account_id','/result/accounts/*/account_entity_id','provider-namespaced account entity'),('/accounts/*/phone_number/score','/result/accounts/*/field_scores','null means unavailable; never convert to zero')])}
for aid,(method,path,version,auth,sids,mappings) in info.items():
 provider,cap,_=ADAPTERS[aid]
 manifest={'adapter_id':aid,'provider_id':provider,'adapter_version':'0.1.0','host_schema_version':'1.0.0','capability':cap,'maturity':'fixture_tested','enabled':False,'native':{'method':method,'path':path,'api_version':version,'authentication':auth,'documentation_urls':[s['url'] for s in sources if s['source_id']in sids],'fixture_only':True},'mapping_rules':[{'source_pointer':src,'target_pointer':tgt,'transform':transform,'missing_behavior':'preserve unknown; required shape mismatch=>schema_drift error; no approval','evidence_source_ids':sids} for src,tgt,transform in mappings],'supported_countries':[],'entitlement_ref':None,'secret_ref':None,'transport_requirements':['TLS','approved regional base URL allowlist','secret vault injection','rate limiting and circuit breaker','bounded retry with jitter and idempotency','verify raw webhook signatures before decoding','durable inbox and tenant-bound correlation','replay and stale-event protection','original-byte hash and encrypted evidence storage'],'limitations':['Synthetic representative payload subset only; not vendor-certified','No live HTTP, authentication, webhook signature, or sandbox integration implemented','No proof of contractual dataset coverage, country entitlements, retention rights or bank adoption','Empty country allowlist blocks live routing','Unmapped native properties available only in restricted raw artifact']}
 dump('adapters/manifests/'+aid+'.json',manifest)
 req={'schema_version':'1.0.0','request_id':'demo-'+aid,'tenant_id':'demo-tenant','idempotency_key':'demo-'+aid+'-v1','capability':cap,'subject_entity_id':'subject-001','entities':[entity('subject-001','organization' if aid in ['companies_house','opencorporates','gleif','middesk'] else 'person','Example Workshop Ltd' if aid in ['companies_house','opencorporates','gleif','middesk'] else 'Alex Example')],'purpose':'customer_due_diligence','legal_basis':'example_only_not_a_legal_determination','consent_ref':'example://consent/001','policy':{'policy_id':'example-cdd','policy_version':'1','jurisdictions':['GB'],'data_residency_allowlist':['GB']},'routing':{'provider_allowlist':[provider],'required_datasets':[],'allow_fallback':False},'input':{'provider_record_id':'00000001' if aid=='companies_house' else '00000000000000000001' if aid=='gleif' else 'inq_synthetic' if aid=='persona' else 'synthetic-record'},'extensions':{'synthetic':True}}
 if aid=='opencorporates':req['entities'][0]['identifiers']=[ident('opencorporates_registration','00000001','gb')]
 if aid=='plaid':req['input']['account_token_ref']='example://secrets/plaid/item001'
 dump('examples/requests/'+aid+'.json',req)
 if aid in ['companies_house','opencorporates','gleif','persona','opensanctions','plaid']:dump('examples/request-plans/'+aid+'.json',plan_request(aid,req))
# One illustrative host event for EVERY capability; typed result families are instantiated.
schema=json.loads((P/'schemas/host.schema.json').read_text());defs=schema['$defs']
def default(node):
 if '$ref'in node:return default(defs[node['$ref'].split('/')[-1]])
 if 'const'in node:return node['const']
 if 'enum'in node:return 'unknown' if 'unknown'in node['enum'] else node['enum'][0]
 t=node.get('type')
 if t=='object':return {k:default(node['properties'][k]) for k in node.get('required',[])}
 if t=='array':return []
 if t=='integer':return 0
 if t=='number':return 0
 if t=='boolean':return False
 return 'synthetic-example'
for c in json.loads((P/'catalog/capabilities.json').read_text()):
 out=normalize('persona',fixtures['persona']);out['capability']=c['capability'];out['provider']={'provider_id':'illustrative-host-not-a-vendor','adapter_version':'example-1','status_original':None,'decision_origin':'unknown'}
 out['assessment']['outcome']='not_checked';out['execution']['status']='pending';out['coverage']['requested_scope']=[c['capability']];out['coverage']['not_checked_scope']=[c['capability']];out['evidence']=[];out['result']=default(defs[c['result_family']+'Result']);out['warnings']=['ILLUSTRATIVE_HOST_CONTRACT_ONLY_NOT_PROVIDER_OUTPUT'];out['result_id']='illustrative-'+c['capability']
 if c['result_family']=='business':out['result']['organization_entity_id']='subject-001';out['entities'][0]['entity_type']='organization'
 if c['result_family']=='ownership':out['result']['root_entity_id']='subject-001';out['result']['completeness']='unknown'
 if c['result_family']=='screening':out['result']['scope']=[];out['result']['truncated']=False
 dump('examples/capabilities/'+c['capability']+'.json',out)
# Rich ownership and identity graph; synthetic, not a real registry extract.
g=normalize('companies_house',fixtures['companies_house']);g['capability']='business.ownership.discover';g['provider']['provider_id']='illustrative-host-not-a-vendor';g['assessment']['outcome']='review';g['warnings']=['ILLUSTRATIVE_GRAPH_NOT_PROVIDER_OUTPUT','Ownership percentages are direct shares; natural-person UBO rule is policy dependent']
ev=g['evidence'][0]['evidence_id'];g['entities']=[entity('subject-001','organization','Example Operating Ltd',[ident('company_registration','00000001','GB')]),entity('holding-001','organization','Example Holding Ltd',[ident('company_registration','00000002','GB')]),entity('person-001','person','Alex Example'),entity('other-source-company','organization','EXAMPLE OPERATING LIMITED',[ident('company_registration','00000001','GB')])];g['assertions']=[]
g['relationships']=[{'relationship_id':'edge-1','from_entity_id':'holding-001','to_entity_id':'subject-001','type':'owns','direction':'directed','assertion_status':'asserted','ownership':{'kind':'equity','exact_percent':60,'directness':'direct'},'evidence_ids':[ev]},{'relationship_id':'edge-2','from_entity_id':'person-001','to_entity_id':'holding-001','type':'owns','direction':'directed','assertion_status':'asserted','ownership':{'kind':'equity','lower_percent':25,'upper_percent':50,'directness':'direct'},'evidence_ids':[ev]}]
g['result']={'kind':'ownership','root_entity_id':'subject-001','relationship_ids':['edge-1','edge-2'],'completeness':'partial','legal_test_policy_ref':'example://policies/jurisdiction-specific-ubo','unresolved_reasons':['Remaining shareholders unavailable','Control rights unknown','Ownership interval does not establish exact indirect UBO share']}
dump('examples/host/ownership-graph.json',g)
dump('examples/identifier-resolution-candidates.json',resolve_identifier_connections(g['entities']))
# Failure and partial data never approve.
dump('examples/host/schema-drift-error.json',normalize('veriff',{'unexpected':'new shape'}))
p=copy.deepcopy(fixtures['opensanctions']);p['responses']['q']['total']['value']=200
dump('examples/host/partial-screening.json',normalize('opensanctions',p))
print('Created 9 native fixtures, 9 requests, 9 manifests, 6 non-executable plans, 37 capability examples, graph and failure examples')
