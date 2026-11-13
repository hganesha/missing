import unittest,json,copy,sys
from pathlib import Path
from jsonschema import Draft202012Validator,FormatChecker,ValidationError
P=Path(__file__).resolve().parents[1];sys.path.insert(0,str(P))
from adapters.runtime import normalize,validate_semantics,resolve_identifier_connections,plan_request,entity,ident,ADAPTERS

def read(p):return json.loads((P/p).read_text())
HOST=Draft202012Validator(read('schemas/host.schema.json'),format_checker=FormatChecker())
REQUEST=Draft202012Validator(read('schemas/request.schema.json'),format_checker=FormatChecker())
MANIFEST=Draft202012Validator(read('schemas/adapter.schema.json'),format_checker=FormatChecker())
class ContractTests(unittest.TestCase):
 def test_schema_metaschemas(self):
  for p in (P/'schemas').glob('*.schema.json'):Draft202012Validator.check_schema(json.loads(p.read_text()))
 def test_all_host_examples(self):
  for folder in ['examples/host','examples/capabilities']:
   for f in (P/folder).glob('*.json'):
    with self.subTest(file=f.name):
     v=json.loads(f.read_text());HOST.validate(v);self.assertEqual([],validate_semantics(v));self.assertEqual(v['assessment']['bank_decision'],'not_evaluated')
 def test_requests(self):
  for f in (P/'examples/requests').glob('*.json'):REQUEST.validate(json.loads(f.read_text()))
  Draft202012Validator(read('schemas/event.schema.json'),format_checker=FormatChecker()).validate(read('examples/result-event.json'))
 def test_manifests(self):
  for f in (P/'adapters/manifests').glob('*.json'):
   v=json.loads(f.read_text());MANIFEST.validate(v);self.assertFalse(v['enabled']);self.assertEqual(v['supported_countries'],[])
 def test_all_capabilities_have_example(self):
  for cap in read('catalog/capabilities.json'):self.assertTrue((P/'examples/capabilities'/(cap['capability']+'.json')).exists())
 def test_catalog_references(self):
  rows=read('catalog/providers.json');ids={x['provider_id'] for x in rows};self.assertEqual(len(ids),len(rows));sids={x['source_id'] for x in read('research/sources.json')}
  for op in read('catalog/provider-capabilities.json'):
   self.assertIn(op['provider_id'],ids);self.assertTrue(set(op['source_ids'])<=sids);self.assertIsNone(op['native_path'])
 def test_completed_is_not_approved(self):
  v=normalize('persona',read('examples/native/persona.json'));self.assertEqual(v['assessment']['outcome'],'inconclusive')
 def test_sumsub_retry_not_final_failure(self):
  p=read('examples/native/sumsub.json');v=normalize('sumsub',p);self.assertEqual(v['assessment']['outcome'],'resubmit');self.assertNotIn('INTERNAL ONLY',json.dumps(v))
  p['reviewResult']['reviewRejectType']='FINAL';self.assertEqual(normalize('sumsub',p)['assessment']['outcome'],'failed')
 def test_sumsub_missing_reject_type_is_inconclusive(self):
  p=read('examples/native/sumsub.json');del p['reviewResult']['reviewRejectType'];self.assertEqual(normalize('sumsub',p)['assessment']['outcome'],'inconclusive')
 def test_unknown_status_never_passes(self):
  p=read('examples/native/veriff.json');p['verification']['status']='new_future_status';v=normalize('veriff',p);self.assertEqual(v['assessment']['outcome'],'unknown');HOST.validate(v)
 def test_expired_and_abandoned_not_identity_failures(self):
  for st in ['expired','abandoned']:
   p=read('examples/native/veriff.json');p['verification'].update(status=st,code=9104);v=normalize('veriff',p);self.assertEqual(v['assessment']['outcome'],'inconclusive');self.assertEqual(v['provider']['status_original'],st)
 def test_bad_payload_fails_closed(self):
  for aid in ADAPTERS:
   v=normalize(aid,{'wrong':'shape'});self.assertEqual(v['execution']['status'],'failed');self.assertEqual(v['assessment']['outcome'],'unknown');HOST.validate(v)
 def test_empty_screening_not_clearance(self):
  p=read('examples/native/opensanctions.json');p['responses']['q']['results']=[];p['responses']['q']['total']['value']=0
  v=normalize('opensanctions',p);self.assertEqual(v['assessment']['outcome'],'inconclusive');self.assertEqual(v['coverage']['status'],'unknown')
 def test_screening_candidates_not_confirmed(self):
  v=normalize('opensanctions',read('examples/native/opensanctions.json'));self.assertEqual(v['result']['matches'][0]['disposition'],'unresolved');self.assertEqual(v['relationships'],[])
 def test_partial_screening(self):
  v=read('examples/host/partial-screening.json');self.assertEqual(v['execution']['status'],'partial');self.assertTrue(v['result']['truncated'])
 def test_null_score_is_not_zero(self):
  v=normalize('plaid',read('examples/native/plaid.json'));self.assertNotIn('phone_number',[s['name'] for s in v['result']['accounts'][0]['field_scores']]);self.assertEqual(v['relationships'],[])
 def test_opencorporates_inactive_false_not_active(self):
  v=normalize('opencorporates',read('examples/native/opencorporates.json'));self.assertEqual(v['entities'][0]['status'],'unknown')
 def test_middesk_approved_client_workflow(self):
  p=read('examples/native/middesk.json');p['data']['object']['status']='approved';v=normalize('middesk',p);self.assertEqual(v['assessment']['outcome'],'inconclusive');self.assertEqual(v['provider']['decision_origin'],'client_workflow')
 def test_wrong_result_family_rejected(self):
  v=read('examples/host/persona.json');v['capability']='crypto.wallet.screen'
  with self.assertRaises(ValidationError):HOST.validate(v)
 def test_unknown_field_rejected(self):
  v=read('examples/host/persona.json');v['assessment']['approve']=True
  with self.assertRaises(ValidationError):HOST.validate(v)
 def test_failed_execution_cannot_pass(self):
  v=read('examples/host/veriff.json');v['execution']['status']='failed'
  with self.assertRaises(ValidationError):HOST.validate(v)
 def test_semantic_relationship_checks(self):
  v=read('examples/host/ownership-graph.json');v['relationships'][0]['to_entity_id']='missing';self.assertIn('dangling relationship',validate_semantics(v))
 def test_names_are_not_merged(self):
  self.assertEqual([],resolve_identifier_connections([entity('a','person','Alex Example'),entity('b','person','Alex Example')]))
 def test_identifier_namespace_required(self):
  e=[entity('a',identifiers=[ident('company_registration','1','GB')]),entity('b',identifiers=[ident('company_registration','1','US')])];self.assertEqual([],resolve_identifier_connections(e))
  e[1]['identifiers'][0]['jurisdiction']='GB';v=resolve_identifier_connections(e);self.assertEqual(v[0]['outcome'],'possible')
 def test_request_plans(self):
  for aid in ['persona','companies_house','opencorporates','gleif','opensanctions','plaid']:
   self.assertFalse(plan_request(aid,read('examples/requests/'+aid+'.json'))['executable'])
 def test_request_plan_rejects_capability_mismatch(self):
  r=read('examples/requests/plaid.json');r['capability']='screening.sanctions'
  with self.assertRaises(ValueError):plan_request('plaid',r)
 def test_plaid_requires_consent(self):
  r=read('examples/requests/plaid.json');del r['consent_ref']
  with self.assertRaises(ValueError):plan_request('plaid',r)
 def test_quarantine_no_route(self):
  r=next(r for r in read('catalog/providers.json') if r['name']=='Finantier');self.assertTrue(r['routing_eligibility'].startswith('quarantined'))
class FailClosedTests(unittest.TestCase):
 def failed(self,aid,payload):
  out=normalize(aid,payload);HOST.validate(out);self.assertEqual([],validate_semantics(out))
  self.assertEqual(out['execution']['status'],'failed');self.assertEqual(out['assertions'],[]);self.assertIsNone(out['provider']['status_original'])
  return out
 def test_partial_mapping_does_not_leak(self):
  v=read('examples/native/veriff.json');v['verification']['status']='approved';v['verification']['person']=None
  self.assertEqual(self.failed('veriff',v)['result']['checks'],[])
  o=read('examples/native/opensanctions.json');r=next(iter(o['responses'].values()));r['results'].append('not-an-object')
  out=self.failed('opensanctions',o);self.assertEqual(out['result']['matches'],[]);self.assertEqual(len(out['entities']),1)
 def test_null_identifiers_and_bad_types(self):
  s=read('examples/native/sumsub.json');s['applicantId']=None;self.failed('sumsub',s)
  s=read('examples/native/sumsub.json');s.setdefault('reviewResult',{})['rejectLabels']='DOC';self.failed('sumsub',s)
  g=read('examples/native/gleif.json');g['data']['attributes']['lei']='X'*20;self.failed('gleif',g)
  self.failed('middesk',{'data':{'id':'evt_1'}})
  pl=read('examples/native/plaid.json');pl['accounts'][0]['legal_name']={'score':'95'};self.failed('plaid',pl)
 def test_screening_duplicates_and_bool_scores(self):
  o=read('examples/native/opensanctions.json');r=next(iter(o['responses'].values()))
  if r['results']:
   dup=copy.deepcopy(o);d=next(iter(dup['responses'].values()));d['results'].append(copy.deepcopy(d['results'][0]));self.failed('opensanctions',dup)
   b=copy.deepcopy(o);next(iter(b['responses'].values()))['results'][0]['score']=True;out=normalize('opensanctions',b);HOST.validate(out)
 def test_plan_request_input_validation(self):
  r=read('examples/requests/companies_house.json');r['subject_entity_id']='missing'
  with self.assertRaises(ValueError):plan_request('companies_house',r)
  r=read('examples/requests/companies_house.json');r['input']['provider_record_id']='\uff10\uff11AB'
  with self.assertRaises(ValueError):plan_request('companies_house',r)
if __name__=='__main__':unittest.main(verbosity=2)
