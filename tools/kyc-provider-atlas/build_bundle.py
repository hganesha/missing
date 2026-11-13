"""Rebuild the published catalog, schemas and documentation. No vendor calls."""
from pathlib import Path
import json,csv,re,collections,html
P=Path(__file__).parent
DATE='2026-10-15'
def dump(path,obj):
 p=P/path;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(json.dumps(obj,indent=2,ensure_ascii=False)+'\n')
def obj(props,req=()): return {'type':'object','properties':props,'required':list(req),'additionalProperties':False}
def arr(items):return {'type':'array','items':items}
def ref(n):return {'$ref':'#/$defs/'+n}
def enum(*v):return {'type':'string','enum':list(v)}
s={'type':'string'}; ns={'type':['string','null']}; number={'type':'number'}; dt={'type':'string','format':'date-time'}; uri={'type':'string','format':'uri'}
idstr={'type':'string','minLength':1}; pct={'type':'number','minimum':0,'maximum':100}
# Every capability has one and only one host result family.
caps={
 'identity.person.verify':'verification','identity.document.verify':'verification','identity.biometric.verify':'verification','identity.address.verify':'verification','identity.digital_id.verify':'verification','identity.tax_id.verify':'verification',
 'business.verify':'business','business.registry.lookup':'business','business.ownership.discover':'ownership','business.officers.lookup':'ownership',
 'screening.sanctions':'screening','screening.pep':'screening','screening.adverse_media':'screening','screening.enforcement':'screening','screening.payment':'screening',
 'risk.device':'risk','risk.email':'risk','risk.phone':'risk','risk.network':'risk','risk.jurisdiction':'risk','risk.customer.assess':'risk',
 'account.ownership.verify':'account','financial.evidence.retrieve':'financial','transaction.monitor':'monitoring','case.manage':'case','regulatory.report':'report','crypto.wallet.screen':'crypto','crypto.transaction.monitor':'crypto','travel_rule.exchange':'travel_rule','edd.report.retrieve':'edd','entity.resolve':'resolution','monitoring.subscribe':'subscription','reference.identifier.lookup':'reference','reference.list.ingest':'reference','workflow.orchestrate':'workflow','credential.verify':'verification','questionnaire.collect':'questionnaire'}
category_caps={
 'identity':['identity.person.verify','identity.document.verify','identity.biometric.verify'],
 'screening':['screening.sanctions','screening.pep','screening.adverse_media'],
 'kyb':['business.verify','business.registry.lookup','business.ownership.discover'],
 'bureau':['identity.person.verify','risk.customer.assess'],
 'fraud':['risk.device','risk.email','risk.phone'],
 'account':['account.ownership.verify','financial.evidence.retrieve'],
 'monitoring':['transaction.monitor','case.manage','risk.customer.assess'],
 'orchestration':['workflow.orchestrate'],
 'crypto':['crypto.wallet.screen','crypto.transaction.monitor'],
 'travel_rule':['travel_rule.exchange'],
 'edd':['edd.report.retrieve'],
 'registry':['business.registry.lookup'],
 'official_lists':['reference.list.ingest'],
 'network':['reference.identifier.lookup']}
source_rows=[
 ('S01','Sumsub','https://docs.sumsub.com/docs/receive-and-interpret-results-via-api','reviewed_documentation','reviewResult.reviewAnswer GREEN/RED; RED FINAL versus RETRY; comments restricted'),
 ('S02','Veriff','https://devdocs.veriff.com/docs/verification-session-status-codes-table','reviewed_documentation','Approved 9001; review 9121; expired and abandoned share 9104; map by status not code alone'),
 ('S03','Persona','https://docs.withpersona.com/api-reference/inquiries/retrieve-an-inquiry','reviewed_documentation','JSON API inquiry response; bearer authentication; default version 2026-09-29'),
 ('S04','Persona','https://docs.withpersona.com/model-lifecycle','reviewed_search_excerpt','Completed is user-flow completion, not post-inquiry approved'),
 ('S05','Persona','https://docs.withpersona.com/integration-guide-understanding-a-persona-api-payload','reviewed_search_excerpt','data.attributes.fields typed values; webhook wraps inquiry under data.attributes.payload'),
 ('S06','Middesk','https://docs.middesk.com/quickstart.md','reviewed_documentation','POST /v1/businesses; basic auth sandbox example; asynchronous; HTTP 201 is not verification; tasks'),
 ('S07','Middesk','https://docs.middesk.com/lifecycle-of-business.md','reviewed_documentation','open/pending/in_audit/in_review; approved and rejected are client decisions'),
 ('S08','Middesk','https://docs.middesk.com/llms.txt','reviewed_documentation','Index now includes international businesses; older US-only comparisons are insufficient'),
 ('S09','Companies House','https://developer-specs.company-information.service.gov.uk/companies-house-public-data-api/resources/companyprofile?v=latest','reviewed_documentation','company_name company_number company_status jurisdiction registered_office_address; PSC separate'),
 ('S10','OpenCorporates','https://api.opencorporates.com/documentation/API-Reference','reviewed_documentation','0.4 company lookup results.company; inactive not true does not establish active; jurisdiction namespace'),
 ('S11','GLEIF','https://www.gleif.org/en/lei-data/gleif-api','reviewed_documentation','LEI legal entity and parent relationships, not universal natural-person UBO'),
 ('S12','GLEIF','https://api.gleif.org/docs','reviewed_documentation','JSON API v1 records and linked Level 2 relationships; data examples may be stale'),
 ('S13','OpenSanctions','https://www.opensanctions.org/docs/api/request/','reviewed_documentation','POST /match/{dataset}; queries keyed by caller; ApiKey authorization'),
 ('S14','OpenSanctions','https://www.opensanctions.org/docs/api/response/','reviewed_documentation','responses.<query>.results; candidate schema properties; provenance and matching must be retained'),
 ('S15','OpenSanctions','https://www.opensanctions.org/docs/api/','reviewed_documentation','Match for screening, search not for screening; commercial license required'),
 ('S16','ComplyAdvantage','https://docs.complyadvantage.com/api-docs','reviewed_documentation','Classic API regional endpoints and Token auth; POST /searches; Mesh wire contract not assumed identical'),
 ('S17','Plaid','https://plaid.com/docs/api/products/identity/','reviewed_search_excerpt','/identity/match returns per-field scores; account identity complements KYC'),
 ('S18','Plaid','https://plaid.com/docs/identity/add-to-app/','reviewed_search_excerpt','accounts[].legal_name.score and address/phone/email scores; consent and access token required'),
 ('S19','OFAC Sanctions List Service','https://ofac.treasury.gov/sanctions-list-service','reviewed_documentation','SLS publishes SDN and non-SDN downloadable data and delta archives; not universal clearance'),
 ('S20','LSEG World-Check','https://developers.lseg.com/content/dam/devportal/en_us/product-docs/wc1-api/','reviewed_search_excerpt','World-Check One and Zero Footprint versions; API exists, detailed mapping not implemented'),
 ('S21','LexisNexis Risk Solutions','https://risk.lexisnexis.com/-/media/files/product%20pages/brochure/bridger_infographic_tile-nxr12777-01-0520-en-us.pdf','reviewed_search_excerpt','Bridger Search API and batch; WorldCompliance screening data'),
 ('S22',"Moody's Compliance",'https://www.moodys.com/web/en/us/kyc/products/compliance-catalyst.html','reviewed_search_excerpt','Orbis corporate data and Grid risk database feed Compliance Catalyst'),
 ('S23','Prembly','https://prembly.com/','reviewed_product_page','KYC KYB AML fraud and transaction monitoring marketed; API wire contract not inspected'),
 ('S24','Smile ID','https://www.usesmileid.com/','reviewed_product_page','African identity verification and AML marketed; coverage not uniform'),
 ('S25','MetaMap','https://www.metamap.com/identity-verification-platform/','reviewed_search_excerpt','Latin America and Africa focus; varies by region'),
 ('S26','Signzy','https://www.signzy.com/use-cases/know-your-business','reviewed_search_excerpt','Business verification and UBO API marketed; numeric coverage claims not adopted'),
 ('S27','Market discovery','https://www.gbg.com/en-us/blog/best-kyc-providers/','vendor_comparison_discovery','Discovery only, not independent verification of competitors'),
 ('S28','Market discovery','https://companydata.com/b2b-data-provider-comparisons/best-kyc-api-providers/','vendor_comparison_discovery','Discovery only; no ranking or pricing claim adopted'),
 ('S29','Market discovery','https://bitquery.io/blog/best-blockchain-analysis-tools-and-software','vendor_comparison_discovery','Blockchain vendor discovery only; no chain count adopted')]
sources=[dict(zip(['source_id','provider','url','evidence_type','observations'],r),review_date=DATE) for r in source_rows]
dump('research/sources.json',sources)
implemented={'Sumsub':'sumsub','Veriff':'veriff','Persona':'persona','Middesk':'middesk','Companies House':'companies_house','OpenCorporates':'opencorporates','GLEIF':'gleif','OpenSanctions':'opensanctions','Plaid':'plaid'}
# Narrow implementation coverage: does not imply all catalog capabilities implemented.
impl_caps={'sumsub':['identity.person.verify'],'veriff':['identity.person.verify'],'persona':['identity.person.verify'],'middesk':['business.verify'],'companies_house':['business.registry.lookup'],'opencorporates':['business.registry.lookup'],'gleif':['reference.identifier.lookup'],'opensanctions':['screening.sanctions'],'plaid':['account.ownership.verify']}
family={
 'Acuant / IDology product family':'gbg','Bureau van Dijk Orbis':'moodys-compliance','kompany':'moodys-compliance','ThreatMetrix / LexisNexis':'lexisnexis-risk-solutions','TruNarrative / LexisNexis':'lexisnexis-risk-solutions','Emailage / LexisNexis':'lexisnexis-risk-solutions','LexisNexis Bankers Almanac':'lexisnexis-risk-solutions','LSEG Due Diligence':'lseg-world-check','Factiva / Dow Jones':'dow-jones-risk-compliance','Coinfirm':'lukka','Oscilar orchestration':'oscilar','GLEIF vLEI ecosystem':'gleif','BAE Systems Digital Intelligence':'sensa-symphonyai','Finicity / Mastercard':'mastercard-open-banking','Ekata / Mastercard':'mastercard-ekata'}
rows=[]; ops=[]
for line in (P/'catalog/provider-seed.txt').read_text().splitlines():
 if not line.strip() or line.startswith('#'):continue
 cat,name,url,market,note=[x.strip() for x in line.split('|')]
 slug=re.sub('[^a-z0-9]+','-',name.lower()).strip('-')
 ev=[x for x in sources if x['provider']==name]
 level='public_docs_reviewed' if any(x['evidence_type']=='reviewed_documentation' for x in ev) else 'public_material_reviewed' if ev else 'candidate_unverified'
 proposed=category_caps[cat][:]
 # Per-provider exceptions prevent treating components as full-stack KYC.
 if name in ['FaceTec','iProov','Aware','TECH5']:proposed=['identity.biometric.verify']
 if name=='GLEIF':proposed=['reference.identifier.lookup','business.ownership.discover']
 if name=='Companies House':proposed=['business.registry.lookup','business.officers.lookup','business.ownership.discover']
 if name in ['UIDAI','SSA eCBSV','Nigeria NIMC','Nigeria NIBSS','AAMVA DLDV','Protean eGov']:proposed=['identity.person.verify']
 if name in ['DigiLocker','Singapore MyInfo / Singpass','UAE PASS','BankID Sweden','Norwegian BankID','itsme','SwissID','ConnectID']:proposed=['identity.digital_id.verify']
 if name=='CERSAI CKYCR':proposed=['identity.person.verify']
 if name=='IRS TIN Matching':proposed=['identity.tax_id.verify']
 if name=='Yoti':proposed=['identity.digital_id.verify','identity.document.verify']
 if name=='OpenSanctions':proposed=['screening.sanctions','screening.pep','screening.enforcement']
 if name=='Plaid':proposed=['account.ownership.verify','identity.person.verify','financial.evidence.retrieve']
 if name in ['FATF high-risk and monitored jurisdictions','Basel AML Index']:proposed=['risk.jurisdiction']
 if name=='Wolfsberg Group':proposed=['questionnaire.collect']
 if name=='Swift KYC Registry':proposed=['questionnaire.collect']
 if name=='Open Ownership':proposed=['business.ownership.discover']
 if name in ['Quantexa','Sayari']:proposed=['entity.resolve','business.ownership.discover','risk.network']
 if name=='AML Intelligence':proposed=['edd.report.retrieve']
 if name=='CAMARA / GSMA Open Gateway':proposed=['risk.phone']
 if name in ['SurePay','Trustpair','iPiD','Swift Payment Pre-validation','LexisNexis Bankers Almanac']:proposed=['account.ownership.verify'] if name!='LexisNexis Bankers Almanac' else ['reference.identifier.lookup']
 aid=implemented.get(name)
 r={'provider_id':slug,'name':name,'category':cat,'record_type':'product_family' if name in family else 'registry_or_network_family' if name in ['US state Secretaries of State','CAMARA / GSMA Open Gateway','EU BRIS','TRISA','TRUST network'] else 'organization_or_service', 'family_id':family.get(name,slug),'market_orientation_unverified':market,'proposed_capabilities':proposed,'capability_claim_status':'routing hypotheses; validate product, country, entitlement and source per capability','evidence_level':level,'source_ids':[e['source_id'] for e in ev],'reference_url':url,'reference_url_status':'reviewed source linked separately' if ev else 'pointer not fetched; current availability unverified','docs_url':next((e['url'] for e in ev if e['evidence_type']=='reviewed_documentation'),None),'api_wire_status':'representative fixture normalizer only' if aid else 'not implemented; native contract required','adapter_id':aid,'access_model':'restricted/contract/consent: verify' if cat in ['registry','network','account'] else 'commercial contract: verify' if cat not in ['official_lists'] else 'publisher terms: verify','review_date':DATE if ev else None,'bank_adoption_evidence':'not assessed; inclusion is not proof of bank usage','notes':note}
 rows.append(r)
 for cap in proposed:
  ops.append({'operation_id':slug+':'+cap,'provider_id':slug,'capability':cap,'host_request_schema':'schemas/request.schema.json','host_response_schema':'schemas/host.schema.json','result_family':caps[cap],'adapter_id':aid if aid and cap in impl_caps[aid] else None,'mapping_maturity':'fixture_tested' if aid and cap in impl_caps[aid] else 'proposed_contract_only','native_method':None,'native_path':None,'native_schema':None,'status':'disabled_until_vendor_contract_and_entitlement_validated','country_allowlist':[],'data_residency_allowlist':[],'auth_secret_ref':None,'source_ids':r['source_ids']})
# Availability checks are not promoted to detailed capability verification.
audit_path=P/'research/reference-retrieval.json'
audit=json.loads(audit_path.read_text()) if audit_path.exists() else []
by_url={x['url']:x for x in audit}
metadata_updates={'AuthenticID':('incode','Official homepage metadata says AuthenticID is now part of Incode; contracting and product migration still require verification'), 'Invoid':('bureau','Reference redirects to Bureau; treat as legacy/family candidate, not separate live vendor'), 'NorthRow':('id-pal','Official homepage metadata describes ID-Pal acquisition; verify current contract'), 'CAF':('caf','Official homepage metadata identifies rebrand to Certta; preserve CAF as alias'), 'Intix':('vyntra','Reference now presents Vyntra transaction observability; preserve Intix as legacy/product alias')}
for r in rows:
 a=by_url.get(r['reference_url'],{})
 r['reference_http_status']=a.get('http_status');r['reference_final_url']=a.get('final_url');r['reference_page_title']=a.get('title');r['reference_metadata_claim']=a.get('description');r['reference_checked_at']=a.get('retrieval_date')
 if a:r['reference_url_status']='metadata retrieved only; not capability/API verification' if a.get('http_status') and 200<=a['http_status']<300 else 'retrieval failed or non-2xx; availability unknown'
 r['routing_eligibility']='disabled_unvalidated'
 if r['name'] in metadata_updates:
  fam,note=metadata_updates[r['name']];r['family_id']=fam;r['record_type']='product_family';r['notes']+=' | '+note
 if r['name']=='Finantier':
  r['routing_eligibility']='quarantined_unrelated_reference_content';r['notes']+=' | Retrieved historical domain returned unrelated gambling content. DO NOT use this domain for provider access; historical inventory only.'
 if r['name']=='Acuris Risk Intelligence':r['notes']+=' | Historical reference currently presents KYC6 in page metadata; current entity and product lineage need investigation.'
for op in ops:
 r=next(r for r in rows if r['provider_id']==op['provider_id'])
 if r['routing_eligibility'].startswith('quarantined'):op['status']='quarantined_do_not_connect'
dump('catalog/providers.json',rows);dump('catalog/provider-capabilities.json',ops)
for filename,data in [('providers.csv',rows),('provider-capabilities.csv',ops),('sources.csv',sources)]:
 with (P/'catalog'/filename).open('w',newline='') as f:
  w=csv.DictWriter(f,fieldnames=list(data[0]));w.writeheader();w.writerows([{k:json.dumps(v,ensure_ascii=False) if isinstance(v,(list,dict)) else v for k,v in r.items()} for r in data])
dump('catalog/capabilities.json',[{'capability':k,'result_family':v,'definition':'Host-controlled capability; provider support must be proven separately'} for k,v in caps.items()])
# Canonical host schema, strict objects with explicit extension points.
D={}
D['partialDate']=obj({'value':s,'precision':enum('year','month','day'),'calendar':enum('gregorian','other'),'original':s},['value','precision'])
D['identifier']=obj({'scheme':idstr,'value':idstr,'issuer':s,'jurisdiction':s,'verified':{'type':'boolean'},'evidence_ids':arr(s)},['scheme','value'])
D['name']=obj({'full':s,'given':s,'middle':arr(s),'family':s,'kind':enum('legal','alias','former','transliteration','trading','unknown'),'language':s,'script':s,'original':s},['full','kind'])
D['address']=obj({'lines':arr(s),'city':s,'region':s,'postal_code':s,'country':{'type':'string','pattern':'^[A-Z]{2}$'},'country_original':s,'full':s,'kind':enum('registered','residential','business','service','unknown')},['kind'])
D['entity']=obj({'entity_id':idstr,'entity_type':enum('person','organization','trust','legal_arrangement','account','wallet','vessel','aircraft','address','device','unknown'),'names':arr(ref('name')),'identifiers':arr(ref('identifier')),'addresses':arr(ref('address')),'birth_date':ref('partialDate'),'incorporation_date':ref('partialDate'),'nationalities':arr(s),'jurisdiction':s,'legal_form':s,'status_original':s,'status':enum('active','inactive','dissolved','unknown'),'source_record_ids':arr(s),'evidence_ids':arr(s),'attributes':{'type':'object'}},['entity_id','entity_type','names','identifiers'])
D['score']=obj({'name':idstr,'value':{'type':['number','string','null']},'scale_min':number,'scale_max':number,'direction':enum('higher_is_riskier','higher_is_better_match','higher_is_better','unknown'),'semantics':s,'model_version':s,'calibration_id':s},['name','value','direction','semantics'])
D['evidence']=obj({'evidence_id':idstr,'provider_id':idstr,'source_record_id':s,'source_url':uri,'source_title':s,'published_at':dt,'retrieved_at':dt,'effective_from':dt,'effective_to':dt,'source_pointer':s,'content_sha256':{'type':'string','pattern':'^[a-f0-9]{64}$'},'authority':enum('official','commercial','customer_supplied','inferred','unknown'),'license_ref':s,'retention_policy_ref':s,'access_classification':enum('public','internal','confidential','restricted')},['evidence_id','provider_id','retrieved_at','authority','access_classification'])
D['relationship']=obj({'relationship_id':idstr,'from_entity_id':idstr,'to_entity_id':idstr,'type':enum('owns','controls','director_of','officer_of','beneficial_owner_of','parent_of','account_holder_of','wallet_attributed_to','same_as','possible_same_as','shares_address','shares_device','associated_with','family_of','close_associate_of','transacts_with','other'),'direction':enum('directed','undirected'),'assertion_status':enum('asserted','inferred','candidate','confirmed','rejected','unknown'),'ownership':obj({'kind':enum('equity','voting','economic','control','unknown'),'lower_percent':pct,'upper_percent':pct,'exact_percent':pct,'directness':enum('direct','indirect','unknown'),'calculation_policy_ref':s,'calculation_path_ids':arr(s)},['kind','directness']),'valid_from':ref('partialDate'),'valid_to':ref('partialDate'),'confidence':{'type':'number','minimum':0,'maximum':1},'confidence_basis':s,'evidence_ids':arr(s),'jurisdiction':s},['relationship_id','from_entity_id','to_entity_id','type','direction','assertion_status','evidence_ids'])
D['assertion']=obj({'assertion_id':idstr,'entity_id':idstr,'field_path':s,'value':{},'verification':enum('verified','not_verified','mismatch','unknown','not_checked'),'evidence_ids':arr(s)},['assertion_id','entity_id','field_path','value','verification','evidence_ids'])
D['match']=obj({'match_id':idstr,'subject_entity_id':idstr,'candidate_entity_id':idstr,'categories':arr(s),'list_ids':arr(s),'programs':arr(s),'matched_fields':arr(s),'conflicting_fields':arr(s),'scores':arr(ref('score')),'disposition':enum('unresolved','true_match','false_positive','inconclusive'),'disposition_actor':s,'disposition_policy_ref':s,'evidence_ids':arr(s)},['match_id','subject_entity_id','candidate_entity_id','categories','disposition','evidence_ids'])
D['check']=obj({'check_id':idstr,'name':s,'outcome':enum('passed','failed','inconclusive','not_checked','not_applicable','unknown'),'reason_codes':arr(s),'scores':arr(ref('score')),'evidence_ids':arr(s)},['check_id','name','outcome','evidence_ids'])
D['alert']=obj({'alert_id':idstr,'subject_entity_ids':arr(s),'transaction_ids':arr(s),'scenario_id':s,'scenario_version':s,'severity':enum('low','medium','high','critical','unknown'),'status':enum('open','in_review','closed','unknown'),'reason_codes':arr(s),'evidence_ids':arr(s),'window_start':dt,'window_end':dt},['alert_id','severity','status','evidence_ids'])
D['money']=obj({'amount':{'type':'string','pattern':'^-?[0-9]+(\\.[0-9]+)?$'},'currency':{'type':'string','pattern':'^[A-Z0-9]{3,12}$'}},['amount','currency'])
D['transaction']=obj({'transaction_id':idstr,'occurred_at':dt,'amount':ref('money'),'originator_entity_id':s,'beneficiary_entity_id':s,'account_ids':arr(s),'rail':s,'direction':enum('inbound','outbound','internal','unknown'),'chain':s,'tx_hash':s},['transaction_id','occurred_at','amount'])
D['error']=obj({'code':idstr,'category':enum('authentication','authorization','rate_limit','validation','not_found','timeout','provider_unavailable','schema_drift','unsupported','unknown'),'message':s,'retryable':{'type':'boolean'},'retry_after_seconds':{'type':'integer','minimum':0},'provider_code':s},['code','category','message','retryable'])
D['coverage']=obj({'status':enum('complete_for_requested_scope','partial','unknown','not_supported'),'requested_scope':arr(s),'checked_scope':arr(s),'not_checked_scope':arr(s),'missing_fields':arr(s),'reason':s},['status','requested_scope','checked_scope','not_checked_scope'])
result_props={
 'verification':{'checks':arr(ref('check')),'assertion_ids':arr(s)},
 'business':{'organization_entity_id':s,'checks':arr(ref('check')),'assertion_ids':arr(s)},
 'ownership':{'root_entity_id':s,'relationship_ids':arr(s),'completeness':enum('complete','partial','unknown'),'legal_test_policy_ref':s,'unresolved_reasons':arr(s)},
 'screening':{'matches':arr(ref('match')),'dataset_versions':arr(s),'scope':arr(s),'truncated':{'type':'boolean'},'total_candidates':{'type':'integer','minimum':0}},
 'risk':{'scores':arr(ref('score')),'signals':arr(obj({'name':s,'value':{},'reason_codes':arr(s),'evidence_ids':arr(s)},['name','value','evidence_ids']))},
 'account':{'accounts':arr(obj({'account_entity_id':s,'field_scores':arr(ref('score')),'ownership_outcome':enum('matched','not_matched','inconclusive','not_checked'),'checks':arr(ref('check'))},['account_entity_id','field_scores','ownership_outcome']))},
 'financial':{'documents':arr(obj({'document_id':s,'type':s,'evidence_id':s,'period_start':ref('partialDate'),'period_end':ref('partialDate'),'extracted_facts':arr(ref('assertion'))},['document_id','type','evidence_id']))},
 'monitoring':{'alerts':arr(ref('alert')),'transactions':arr(ref('transaction')),'window_start':dt,'window_end':dt},
 'case':{'case_id':s,'status':s,'assigned_actor':s,'alert_ids':arr(s),'decision_history':arr(obj({'at':dt,'actor':s,'action':s,'policy_ref':s},['at','actor','action']))},
 'report':{'report_id':s,'jurisdiction':s,'report_type':s,'status':enum('draft','approved','submitted','accepted','rejected','unknown'),'acknowledgement_id':s,'filing_authority':s,'restricted_evidence_ids':arr(s)},
 'crypto':{'wallet_entity_id':s,'chain':s,'asset':s,'scores':arr(ref('score')),'exposures':arr(obj({'category':s,'counterparty_entity_id':s,'direction':enum('incoming','outgoing','both','unknown'),'hops':{'type':'integer','minimum':0},'share_percent':pct,'amount':ref('money'),'evidence_ids':arr(s)},['category','direction','evidence_ids'])),'alerts':arr(ref('alert'))},
 'travel_rule':{'message_id':s,'protocol':s,'protocol_version':s,'originator_vasp_entity_id':s,'beneficiary_vasp_entity_id':s,'transfer_transaction_id':s,'status':enum('pending','delivered','accepted','rejected','failed','unknown'),'pii_vault_ref':s,'counterparty_due_diligence_status':s},
 'edd':{'report_id':s,'summary_internal':s,'findings':arr(obj({'finding_id':s,'category':s,'allegation_status':enum('alleged','charged','convicted','acquitted','dismissed','unknown'),'summary':s,'evidence_ids':arr(s)},['finding_id','category','allegation_status','evidence_ids']))},
 'resolution':{'candidates':arr(obj({'left_entity_id':s,'right_entity_id':s,'outcome':enum('same','different','possible','insufficient'),'method':s,'model_version':s,'matched_features':arr(s),'contradictions':arr(s),'scores':arr(ref('score')),'evidence_ids':arr(s)},['left_entity_id','right_entity_id','outcome','method','evidence_ids'])),'merge_policy_ref':s},
 'subscription':{'subscription_id':s,'subject_entity_ids':arr(s),'status':enum('active','paused','cancelled','unknown'),'capabilities':arr(enum(*caps)),'next_review_at':dt},
 'reference':{'record_entity_ids':arr(s),'dataset_id':s,'dataset_version':s,'record_count':{'type':'integer','minimum':0},'relationship_ids':arr(s)},
 'workflow':{'workflow_id':s,'workflow_version':s,'step_run_ids':arr(s),'status':enum('pending','running','completed','failed','unknown')},
 'questionnaire':{'questionnaire_id':s,'template_version':s,'answers':arr(obj({'question_id':s,'value':{},'evidence_ids':arr(s)},['question_id','value','evidence_ids']))}}
for family_name,props in result_props.items():
 D[family_name+'Result']=obj({'kind':{'const':family_name},**props},['kind',*props.keys()] if family_name in ['verification','business','screening','account','risk','ownership'] else ['kind'])
D['result']={'oneOf':[ref(k+'Result') for k in result_props]}
props={'schema_version':{'const':'1.0.0'},'result_id':idstr,'request_id':idstr,'tenant_id':idstr,'subject_entity_id':idstr,'capability':enum(*caps),'provider':obj({'provider_id':idstr,'product':s,'api_version':s,'adapter_version':idstr,'provider_request_id':s,'provider_record_id':s,'status_original':ns,'decision_origin':enum('provider_check','provider_workflow','client_workflow','data_only','unknown')},['provider_id','adapter_version','status_original','decision_origin']), 'execution':obj({'status':enum('pending','completed','partial','failed','cancelled','unknown'),'received_at':dt,'provider_observed_at':dt,'duration_ms':{'type':'integer','minimum':0}},['status','received_at']), 'assessment':obj({'outcome':enum('passed','failed','review','resubmit','inconclusive','not_checked','not_applicable','unknown'),'reason_codes':arr(s),'bank_decision':enum('not_evaluated','approve','reject','hold','escalate'),'policy_id':s,'policy_version':s,'actor':s},['outcome','reason_codes','bank_decision']), 'coverage':ref('coverage'),'entities':arr(ref('entity')),'relationships':arr(ref('relationship')),'assertions':arr(ref('assertion')),'evidence':arr(ref('evidence')),'result':ref('result'),'errors':arr(ref('error')),'warnings':arr(s),'raw_payload':obj({'vault_ref':idstr,'sha256':{'type':'string','pattern':'^[a-f0-9]{64}$'},'retention_policy_ref':s,'classification':enum('confidential','restricted')},['vault_ref','sha256','classification']),'extensions':{'type':'object'}}
host={'$schema':'https://json-schema.org/draft/2020-12/schema','$id':'https://example.invalid/kyc/host/1.0.0','title':'KYC Host Result 1.0.0 — proposed bank-owned model',**obj(props,props.keys()),'$defs':D}
host['allOf']=[{'if':{'properties':{'capability':{'const':c}}},'then':{'properties':{'result':ref(f+'Result')}}} for c,f in caps.items()]
host['allOf'] += [{'if':{'properties':{'execution':{'properties':{'status':{'const':'failed'}}}}},'then':{'properties':{'errors':{'minItems':1},'assessment':{'properties':{'outcome':{'enum':['unknown','inconclusive','not_checked']}}}}}}]
host['allOf'].append({'if':{'properties':{'assessment':{'properties':{'bank_decision':{'not':{'const':'not_evaluated'}}}}}},'then':{'properties':{'assessment':{'required':['policy_id','policy_version','actor'],'properties':{'policy_id':idstr,'policy_version':idstr,'actor':idstr}}}}})
dump('schemas/host.schema.json',host)
request=obj({'schema_version':{'const':'1.0.0'},'request_id':idstr,'tenant_id':idstr,'idempotency_key':idstr,'capability':enum(*caps),'subject_entity_id':idstr,'entities':arr(ref('entity')),'purpose':idstr,'legal_basis':idstr,'consent_ref':s,'policy':obj({'policy_id':idstr,'policy_version':idstr,'jurisdictions':arr(s),'ownership_threshold_percent':pct,'threshold_inclusive':{'type':'boolean'},'data_residency_allowlist':arr(s),'maximum_data_age_seconds':{'type':'integer','minimum':0}},['policy_id','policy_version','jurisdictions','data_residency_allowlist']),'routing':obj({'provider_allowlist':arr(s),'required_datasets':arr(s),'deadline_at':dt,'allow_fallback':{'type':'boolean'}},['provider_allowlist','required_datasets','allow_fallback']),'input':obj({'document_vault_refs':arr(s),'account_token_ref':s,'transaction':ref('transaction'),'questionnaire_ref':s,'query':s,'provider_record_id':s},[]),'extensions':{'type':'object'}},['schema_version','request_id','tenant_id','idempotency_key','capability','subject_entity_id','entities','purpose','legal_basis','policy','routing','input','extensions'])
request.update({'$schema':host['$schema'],'$id':'https://example.invalid/kyc/request/1.0.0','title':'Canonical host request','$defs':D})
dump('schemas/request.schema.json',request)
manifest=obj({'adapter_id':idstr,'provider_id':idstr,'adapter_version':idstr,'host_schema_version':{'const':'1.0.0'},'capability':enum(*caps),'maturity':enum('proposed','documented','fixture_tested','sandbox_tested','production_validated'),'enabled':{'type':'boolean'},'native':obj({'method':ns,'path':ns,'api_version':ns,'authentication':s,'documentation_urls':arr(uri),'fixture_only':{'type':'boolean'}},['method','path','api_version','authentication','documentation_urls','fixture_only']),'mapping_rules':arr(obj({'source_pointer':s,'target_pointer':s,'transform':s,'missing_behavior':s,'evidence_source_ids':arr(s)},['source_pointer','target_pointer','transform','missing_behavior','evidence_source_ids'])),'supported_countries':arr(s),'entitlement_ref':ns,'secret_ref':ns,'transport_requirements':arr(s),'limitations':arr(s)},['adapter_id','provider_id','adapter_version','host_schema_version','capability','maturity','enabled','native','mapping_rules','supported_countries','entitlement_ref','secret_ref','transport_requirements','limitations'])
manifest.update({'$schema':host['$schema'],'$id':'https://example.invalid/kyc/adapter/1.0.0'})
dump('schemas/adapter.schema.json',manifest)
# Data dictionary from all schema objects.
dictionary=[]
def walk(node,path):
 if not isinstance(node,dict):return
 for k,v in node.get('properties',{}).items():
  dictionary.append({'path':path+'.'+k,'type':v.get('type',v.get('$ref','const' if 'const'in v else 'union')),'required':k in node.get('required',[]),'enum_or_const':v.get('enum',v.get('const',''))})
  walk(v,path+'.'+k)
  if 'items'in v:walk(v['items'],path+'.'+k+'[]')
walk(host,'HostResult')
for k,v in D.items():walk(v,k)
dump('schemas/data-dictionary.json',dictionary)
# Catalog workbook with normalized capability table and evidence sheets.
from openpyxl import Workbook
from openpyxl.styles import Font,PatternFill,Alignment
from openpyxl.worksheet.table import Table,TableStyleInfo
from openpyxl.utils import get_column_letter
wb=Workbook();wb.remove(wb.active)
counts=collections.Counter(r['category'] for r in rows)
summary=[{'metric':'Catalog records (organizations, services, products and families; not unique active vendors)','value':len(rows)}, {'metric':'Proposed provider-capability contracts','value':len(ops)},{'metric':'Host capability types','value':len(caps)},{'metric':'Representative fixture normalizers','value':len(implemented)},{'metric':'Sources inspected or search excerpts reviewed','value':len(sources)},{'metric':'Records with reviewed public material','value':sum(r['evidence_level']!='candidate_unverified' for r in rows)},{'metric':'Candidate records not individually researched','value':sum(r['evidence_level']=='candidate_unverified' for r in rows)},{'metric':'Live vendor integrations tested','value':0},{'metric':'Scope date','value':DATE},{'metric':'Exhaustiveness','value':'Broad global discovery inventory; not a certified exhaustive or procurement-ready list'}]
for title,data in [('Read me',summary),('Providers',rows),('Provider capabilities',ops),('Capabilities',[{'capability':k,'result_family':v} for k,v in caps.items()]),('Evidence sources',sources),('Reference checks',audit if audit else [{'status':'not run'}]),('Data dictionary',dictionary),('Coverage',[{'category':k,'record_count':v} for k,v in counts.items()])]:
 ws=wb.create_sheet(title); keys=list(data[0]);ws.append(keys)
 for r in data:ws.append([json.dumps(r.get(k),ensure_ascii=False) if isinstance(r.get(k),(list,dict)) else r.get(k) for k in keys])
 ws.freeze_panes='B2';ws.auto_filter.ref=ws.dimensions;ws.row_dimensions[1].height=30
 for c in ws[1]:c.font=Font(color='FFFFFF',bold=True);c.fill=PatternFill('solid',fgColor='16324F');c.alignment=Alignment(wrap_text=True)
 for idx,k in enumerate(keys,1):
  ws.column_dimensions[get_column_letter(idx)].width=min(62,max(17,len(k)+3))
  for c in list(ws.columns)[idx-1][1:]:c.alignment=Alignment(vertical='top',wrap_text=True)
 for i in range(2,ws.max_row+1):
  ws.row_dimensions[i].height=46
  if i%2==0:
   for c in ws[i]:c.fill=PatternFill('solid',fgColor='F0F5FA')
 ws.sheet_view.showGridLines=False
wb.save(P/'Provider_Catalog.xlsx')
dump('catalog/stats.json',{'records':len(rows),'contracts':len(ops),'capabilities':len(caps),'result_families':len(result_props),'fixture_normalizers':len(implemented),'categories':dict(counts),'evidence_levels':dict(collections.Counter(r['evidence_level'] for r in rows))})
print(json.dumps(json.loads((P/'catalog/stats.json').read_text()),indent=2))
