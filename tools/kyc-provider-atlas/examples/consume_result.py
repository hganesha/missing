"""Minimal safe offline consumer. This queues work; it does not decide onboarding."""
from pathlib import Path
import sys,json
from jsonschema import Draft202012Validator,FormatChecker
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT))
from adapters.runtime import validate_semantics

def consume(result,expected_tenant):
 schema=json.loads((ROOT/'schemas/host.schema.json').read_text())
 Draft202012Validator(schema,format_checker=FormatChecker()).validate(result)
 if result['tenant_id']!=expected_tenant:raise PermissionError('tenant mismatch')
 errors=validate_semantics(result)
 if errors:raise ValueError(errors)
 execution=result['execution']['status'];outcome=result['assessment']['outcome']
 if execution=='failed':return {'action':'operations_exception','errors':result['errors']}
 if execution in ['pending','unknown']:return {'action':'await_or_reconcile'}
 if result['coverage']['status']!='complete_for_requested_scope':return {'action':'coverage_review','result_id':result['result_id']}
 if result['result']['kind']=='screening' and any(m['disposition']=='unresolved' for m in result['result']['matches']):return {'action':'screening_investigation','result_id':result['result_id']}
 if outcome in ['failed','review','resubmit','inconclusive','not_checked','unknown']:return {'action':'policy_or_manual_review','outcome':outcome}
 return {'action':'evaluate_bank_policy','result_id':result['result_id'],'note':'A passed capability is not a customer approval'}
if __name__=='__main__':
 p=ROOT/'examples/host/persona.json' if len(sys.argv)<2 else Path(sys.argv[1])
 print(json.dumps(consume(json.loads(p.read_text()),'demo-tenant'),indent=2))
