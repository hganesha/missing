import { readFileSync } from "node:fs";
import { afterAll, expect, it } from "vitest";
import { evaluateSourceAuthorization, type SourceEvaluationInput } from "./source-policy.js";
import { evaluateSourceAuthorizationWithOpa } from "./source-policy-opa.js";
import { closeOpaModules } from "./opa-module.js";

const fixture=JSON.parse(readFileSync(new URL("../../contracts/test-fixtures/source-policy.json",import.meta.url),"utf8"));
const base:SourceEvaluationInput={...fixture,policies:[fixture.policy],capabilityId:fixture.binding.capabilityId,connectorId:fixture.binding.connectorId,
  connectorDigest:fixture.binding.connectorDigest,request:{stage:"acquire",recipientId:"tenant_demo",redistribute:false},evaluatedAt:"2026-11-08T12:00:00Z"};
afterAll(closeOpaModules);
it("matches the reference for acquisition, use, missing authority and each scoped refusal using real OPA",async()=>{
  const variants:SourceEvaluationInput[]=[base];
  const change=(fn:(input:SourceEvaluationInput)=>void)=>{const input=structuredClone(base);fn(input);variants.push(input);};
  change(i=>{i.context=null;}); change(i=>{i.binding=null;}); change(i=>{i.access=null;});change(i=>{i.policies=[];});
  change(i=>{i.binding!.readiness="proposed";});change(i=>{i.binding!.quarantined=true;});change(i=>{i.connectorDigest="0".repeat(64);});
  change(i=>{i.access!.products=["other"];}); change(i=>{i.access!.consentRequired=true;i.context!.consentRef=null;});
  change(i=>{i.context!.subjectCountries=["FR"];}); change(i=>{i.access!.processingRegions=["other"];});
  change(i=>{i.policies[0]!.scope.products=["other"];});change(i=>{i.policies[0]!.rules[0]!.effect="DENY";});
  change(i=>{i.policies[0]!.rules[0]!.effect="REVIEW_REQUIRED";});change(i=>{i.policies[0]!.rules[0]!.capabilityIds=["other"];});
  change(i=>{i.request.recipientId="other";});change(i=>{i.request.redistribute=true;});
  change(i=>{i.policies[0]!.rules[0]!.processingRegions=["other"];});change(i=>{i.policies[0]!.rules[0]!.datasetIds=["missing"];});
  change(i=>{i.context!.policyJurisdictions=["us","gb"];i.policies[0]!.scope.policyJurisdictions=["us","gb"];});
  change(i=>{i.context!.policyJurisdictions=["us","gb"];i.policies.push({...structuredClone(i.policies[0]!),id:"policy.gb",scope:{...i.policies[0]!.scope,policyJurisdictions:["gb"]}});});
  change(i=>{const deny=structuredClone(i.policies[0]!);deny.id="policy.deny";deny.rules[0]!.effect="DENY";i.policies.push(deny);});
  change(i=>{const other=structuredClone(i.policies[0]!);other.id="policy.conflict";other.rules[0]!.evidenceRoles=["supplemental"];i.policies.push(other);});
  for(const observation of [undefined,fixture.observation,{...fixture.observation,complete:false},{...fixture.observation,fields:[]},
    {...fixture.observation,observedAt:"2026-11-01T00:00:00Z"},{...fixture.observation,observedAt:"2026-11-09T00:00:00Z"}])
    change(i=>{i.request={...i.request,stage:"use",...(observation?{observation}: {})};});
  for(const input of variants) {
    const {evaluator,...actual}=await evaluateSourceAuthorizationWithOpa(input);
    expect(evaluator?.kind).toBe("OPA");
    expect(actual,JSON.stringify(input)).toEqual(evaluateSourceAuthorization(input));
  }
});
