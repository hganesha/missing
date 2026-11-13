import { describe,it,expect } from "vitest";
import { applicationContextSchema,validateApplicationContext,applicationContextReferences,productHoldingContextSchema } from "./application-context.js";
const ref=(object_type:string,object_id:string)=>({tenant_id:'t',object_type,object_id,version_id:'v1'});
export const applicationFixture={contract_version:'1.0.0',source_application_id:'app-42',applicants:[{party_ref:ref('Party','p1'),role:'PRIMARY'},{party_ref:ref('Party','p2'),role:'JOINT'}],requested_products:[ref('Product','deposit')],channel:'branch',status:'SUBMITTED',submitted_at:'2026-11-09T12:00:00Z',effective_from:'2026-11-09T12:00:00Z',effective_to:null,evidence_refs:[],historical_decisions:[]};
describe('versioned application semantics',()=>{
 it('preserves joint applicants and explicit product refs without inventing decisions',()=>{
  expect(applicationContextSchema.safeParse(applicationFixture).success).toBe(true);
  expect(validateApplicationContext('Application',applicationFixture)).toEqual([]);
  expect(applicationContextReferences('Application',applicationFixture)).toHaveLength(3);
  expect(applicationContextSchema.safeParse({...applicationFixture,contract_version:'2.0.0'}).success).toBe(false);
  expect(applicationContextSchema.safeParse({...applicationFixture,case_status:'OPEN'}).success).toBe(false);
 });
 it('rejects ambiguous applicant roles, invalid lifetimes and missing submission time',()=>{
  expect(validateApplicationContext('Application',{...applicationFixture,applicants:[applicationFixture.applicants[1]]})).toContain('applicants requires exactly one primary applicant');
  expect(validateApplicationContext('Application',{...applicationFixture,submitted_at:null})).toContain('submitted_at required after draft');
  expect(validateApplicationContext('Application',{...applicationFixture,effective_to:'2026-11-08T00:00:00Z'})).toContain('effective_to must follow effective_from');
  expect(validateApplicationContext('Application',{...applicationFixture,applicants:[...applicationFixture.applicants,applicationFixture.applicants[1]]})).toContain('applicants contains duplicate party/role');
 });
 it('requires attributed evidence and an explicit account for a holding',()=>{
  expect(productHoldingContextSchema.safeParse({contract_version:'1.0.0',party_ref:ref('Party','p1'),product_ref:ref('Product','deposit'),role:'SOLE_HOLDER',status:'ACTIVE',effective_from:'2026-11-09T12:00:00Z',effective_to:null,evidence_refs:[]}).success).toBe(false);
 });
});
