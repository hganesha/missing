import { sourceUseRequestSchema, sourceContextSchema, sourceBindingSchema, sourceAccessSchema, jurisdictionSourcePolicySchema,
  sourcePolicyDecisionSchema, stableDigest, type SourcePolicyDecision } from "@ehf/contracts";
import type { SourceEvaluationInput } from "./source-policy.js";
import { evaluateOpaModule, opaModuleBundle, POLICY_OPA_VERSION } from "./opa-module.js";

// The v1 source combination semantics run in OPA; the TypeScript function remains an oracle.
const rego = String.raw`package harness.source
import rego.v1
r := input.raw
c := r.context
b := r.binding
a := r.access
now := time.parse_rfc3339_ns(r.evaluatedAt)
subset(values, allowed) if { every value in values { value in allowed } }
current(value) if { time.parse_rfc3339_ns(value.validFrom) <= now; now < time.parse_rfc3339_ns(value.expiresAt) }
artifacts := array.concat([c,b,a], r.policies)
expires := min(array.concat([now+60000000000],[time.parse_rfc3339_ns(v.expiresAt)|some v in artifacts])) if { input.valid }
applicable_policy(p) if {p.scope.institutionId==c.institutionId;c.bookingEntityId in p.scope.bookingEntityIds;
 c.product in p.scope.products;c.purpose in p.scope.purposes;some j in p.scope.policyJurisdictions;j in c.policyJurisdictions}
applicable := [p|some p in r.policies;applicable_policy(p)]
matching := [{"policy":p,"rules":[rule|some rule in p.rules; r.capabilityId in rule.capabilityIds;
  binding_matches(rule.bindingDigests); b.jurisdiction in rule.sourceJurisdictions]}|some p in applicable]
binding_matches(values) if { count(values)==0 }
binding_matches(values) if { input.bindingDigest in values }
rule_ids := sort({sprintf("%s@%s:%s",[m.policy.id,m.policy.version,rule.id])|some m in matching;some rule in m.rules})
allows := [rule|some m in matching;some rule in m.rules;rule.effect=="ALLOW"]
all_values(field) := sort({value|some rule in allows;some value in rule[field]})
common_values(field) := sort({value|some value in allows[0][field]; every rule in allows {value in rule[field]}})
ages := [rule.maxAgeSeconds|some rule in allows;rule.maxAgeSeconds!=null]
default age_limit := null
age_limit := min(ages) if {count(ages)>0}
obligations := {"datasetIds":all_values("datasetIds"),"requiredFields":all_values("requiredFields"),"evidenceRoles":common_values("evidenceRoles"),
  "maxAgeSeconds":age_limit,"maxRetentionSeconds":min([rule.maxRetentionSeconds|some rule in allows]),
  "allowRedistribution":every_redistribution,"recipientIds":common_values("recipientIds")}
default every_redistribution := false
every_redistribution := true if {every rule in allows {rule.allowRedistribution}}
empty_obligations := {"datasetIds":[],"requiredFields":[],"evidenceRoles":[],"maxAgeSeconds":null,"maxRetentionSeconds":null,"allowRedistribution":false,"recipientIds":[]}
subject_jurisdictions := c.registrationJurisdictions if {b.jurisdictionBasis=="registry_authority"}
subject_jurisdictions := c.issuerJurisdictions if {b.jurisdictionBasis=="issuer_authority"}
subject_jurisdictions := c.accountJurisdictions if {b.jurisdictionBasis=="account_servicing"}
default subject_jurisdictions := null
missing_jurisdiction if {subject_jurisdictions!=null;b.jurisdiction!="global";count(subject_jurisdictions)==0}
missing_jurisdiction if {subject_jurisdictions!=null;b.jurisdiction!="global";"unresolved" in subject_jurisdictions}
bad_authority if {subject_jurisdictions!=null;b.jurisdiction!="global";some value in subject_jurisdictions;value!=b.jurisdiction}
bad_data_flow if {not subset(b.approvedEndpoints,a.approvedEndpoints)}
bad_data_flow if {not subset(b.processingRegions,a.processingRegions)}
bad_data_flow if {not subset(b.storageRegions,a.storageRegions)}
bad_data_flow if {not subset(b.subprocessors,a.subprocessors)}
bad_data_flow if {b.transferBasisRef!=a.transferBasisRef}
bad_applicability if {count(applicable)!=count(r.policies)}
bad_applicability if {not subset(c.policyJurisdictions,[v|some p in applicable;some v in p.scope.policyJurisdictions])}
unsupported if {not subset(obligations.datasetIds,b.datasetIds)}
unsupported if {not subset(obligations.datasetIds,a.datasetIds)}
unsupported if {not subset(obligations.requiredFields,b.fields)}
supported_role if {some role in obligations.evidenceRoles;role in b.evidenceRoles}
unsupported if {not supported_role}
observation := object.get(r.request,"observation",null)
complete_observation if {observation!=null;observation.complete;subset(obligations.datasetIds,observation.datasetIds);
  subset(obligations.requiredFields,observation.fields);observation.role in obligations.evidenceRoles;observation.role in b.evidenceRoles;
  subset(observation.datasetIds,b.datasetIds);subset(observation.datasetIds,a.datasetIds);subset(observation.fields,b.fields)}
age := now-time.parse_rfc3339_ns(observation.observedAt)
stale if {age<0}
stale if {age_limit!=null;age>age_limit*1000000000}
failures contains [0,"UNRESOLVED","source_policy.context_or_artifact_missing"] if {not input.valid}
failures contains [1,"DENY","source_policy.artifact_not_current"] if {some v in artifacts;not current(v)}
failures contains [2,"DENY","source_policy.source_quarantined"] if {b.quarantined}
failures contains [3,"UNRESOLVED","source_policy.source_scope_unresolved"] if {b.readiness!="integration_verified"}
failures contains [3,"UNRESOLVED","source_policy.source_scope_unresolved"] if {b.jurisdiction=="unresolved"}
failures contains [4,"DENY","source_policy.binding_changed"] if {b.capabilityId!=r.capabilityId}
failures contains [4,"DENY","source_policy.binding_changed"] if {b.connectorId!=r.connectorId}
failures contains [4,"DENY","source_policy.binding_changed"] if {b.connectorDigest!=r.connectorDigest}
access_ok if {a.bindingDigest==input.bindingDigest;a.institutionId==c.institutionId;c.bookingEntityId in a.bookingEntityIds;c.product in a.products;c.purpose in a.purposes}
failures contains [5,"DENY","source_policy.access_scope_denied"] if {not access_ok}
failures contains [6,"UNRESOLVED","source_policy.consent_missing"] if {a.consentRequired;c.consentRef==null}
failures contains [7,"DENY","source_policy.subject_not_covered"] if {not b.allowAnySubjectCountry;not subset(c.subjectCountries,b.subjectCountries)}
failures contains [8,"UNRESOLVED","source_policy.subject_jurisdiction_missing"] if {missing_jurisdiction}
failures contains [9,"DENY","source_policy.source_authority_mismatch"] if {bad_authority}
failures contains [10,"DENY","source_policy.data_flow_denied"] if {bad_data_flow}
failures contains [11,"UNRESOLVED","source_policy.applicability_unresolved"] if {bad_applicability}
failures contains [12,"DENY","source_policy.explicit_deny"] if {some m in matching;some rule in m.rules;rule.effect=="DENY"}
failures contains [13,"REVIEW_REQUIRED","source_policy.review_required"] if {some m in matching;some rule in m.rules;rule.effect=="REVIEW_REQUIRED"}
has_allow(m) if {some rule in m.rules;rule.effect=="ALLOW"}
failures contains [14,"DENY","source_policy.no_allow_rule"] if {some m in matching;not has_allow(m)}
failures contains [15,"REVIEW_REQUIRED","source_policy.obligations_conflict"] if {count(obligations.evidenceRoles)==0}
failures contains [15,"REVIEW_REQUIRED","source_policy.obligations_conflict"] if {count(obligations.recipientIds)==0}
failures contains [16,"DENY","source_policy.use_denied"] if {not r.request.recipientId in obligations.recipientIds}
failures contains [16,"DENY","source_policy.use_denied"] if {r.request.redistribute;not obligations.allowRedistribution}
failures contains [17,"DENY","source_policy.processing_region_denied"] if {some rule in allows;not subset(b.processingRegions,rule.processingRegions)}
failures contains [17,"DENY","source_policy.processing_region_denied"] if {some rule in allows;not subset(b.storageRegions,rule.storageRegions)}
failures contains [18,"UNRESOLVED","source_policy.required_scope_not_supported"] if {unsupported}
failures contains [19,"UNRESOLVED","source_policy.evidence_incomplete"] if {r.request.stage=="use";not complete_observation}
failures contains [20,"UNRESOLVED","source_policy.evidence_stale"] if {r.request.stage=="use";stale}
failures contains [21,"DENY","source_policy.retention_expired"] if {r.request.stage=="use";age>=obligations.maxRetentionSeconds*1000000000}
selected := min(failures) if {count(failures)>0}
default selected := [999,"ALLOW","source_policy.acquisition_allowed"]
selected := [999,"ALLOW","source_policy.evidence_use_allowed"] if {count(failures)==0;r.request.stage=="use"}
result_rules := rule_ids if {selected[0]>=12}
default result_rules := []
result_obligations := obligations if {selected[0]>=15}
result_obligations := empty_obligations if {selected[0]<15}
valid_until := expires if {input.valid;not_successful_use}
not_successful_use if {selected[0]!=999}
not_successful_use if {r.request.stage!="use"}
valid_until := now+60000000000 if {not input.valid}
valid_until := min(array.concat([expires,time.parse_rfc3339_ns(observation.observedAt)+obligations.maxRetentionSeconds*1000000000],
  [expiry|some v in ages;expiry:=time.parse_rfc3339_ns(observation.observedAt)+v*1000000000])) if {selected[0]==999;r.request.stage=="use"}
result := {"outcome":selected[1],"reasonCodes":[selected[2]],"ruleIds":result_rules,"obligations":result_obligations,"validUntilNs":valid_until}
`;
export const SOURCE_POLICY_OPA_BUNDLE = opaModuleBundle("harness/source/policy.rego", rego);

export async function evaluateSourceAuthorizationWithOpa(input: SourceEvaluationInput): Promise<SourcePolicyDecision> {
  if (!Number.isFinite(Date.parse(input.evaluatedAt))) throw new Error("source_policy.evaluation_time_invalid");
  const policies=[...input.policies].sort((a,b)=>stableDigest(a).localeCompare(stableDigest(b)));
  const bindingDigest=input.binding?stableDigest(input.binding):null;
  const valid=sourceUseRequestSchema.safeParse(input.request).success && sourceContextSchema.safeParse(input.context).success
    && sourceBindingSchema.safeParse(input.binding).success && sourceAccessSchema.safeParse(input.access).success
    && policies.length>0 && policies.every(p=>jurisdictionSourcePolicySchema.safeParse(p).success);
  const evaluated=await evaluateOpaModule(SOURCE_POLICY_OPA_BUNDLE,"data.harness.source.result",{raw:{...input,policies},bindingDigest,valid}) as Record<string,unknown>;
  const {validUntilNs,...result}=evaluated;
  return sourcePolicyDecisionSchema.parse({...result,schemaVersion:"source.decision.v1",inputDigest:stableDigest({...input,policies}),
    contextDigest:input.context?stableDigest(input.context):null,policyDigests:[...new Set(policies.map(stableDigest))].sort(),bindingDigest,
    accessDigest:input.access?stableDigest(input.access):null,evaluatedAt:input.evaluatedAt,validUntil:new Date(Number(validUntilNs)/1e6).toISOString(),
    evaluator:{kind:"OPA",version:POLICY_OPA_VERSION,bundleDigest:SOURCE_POLICY_OPA_BUNDLE.bundleDigest}});
}
