import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { compileBusinessPolicy, projectInstallationContent } from "../../packages/policy-engine/src/index.js";
import { compileInstallationPolicyPackage } from "./installation-policy-package.js";
const root=new URL("../../",import.meta.url).pathname;
const template=()=>parse(readFileSync(root+"domains/kyc-agentic/policy.yaml","utf8"));
it("rebinds installation policy, every skill projection, and actual gates into one new plan",()=>{
  const source=template(),prepared=compileInstallationPolicyPackage({domainRoot:root+"domains/kyc-agentic",policySource:stringify(source),release:"candidate"});
  const plan=prepared.plan.plan as any;
  expect(plan.policyBundles).toEqual([{policyId:prepared.compiled.manifest.policyId,bundleDigest:prepared.compiled.manifest.bundleDigest}]);
  for(const gate of plan.graph.nodes.filter((node:any)=>node.kind==="gate"))expect(gate.config.effectivePolicySetDigests).toEqual(prepared.compiled.policySets.map(set=>set.setDigest));
  const node=plan.graph.nodes.find((node:any)=>node.config.skillPolicies?.length);
  expect(node.config.skillPolicies[0]).toEqual(projectInstallationContent(prepared.compiled.policySets[0]!,node.config.skillPolicies[0].fields,node.config.skillPolicies[0].values.permissions));
  expect(compileInstallationPolicyPackage({domainRoot:root+"domains/kyc-agentic",policySource:stringify(source),release:"candidate"}).plan.document).toBe(prepared.plan.document);
  source.policySets[0].configuration.automatic_approval_enabled=true;
  const changed=compileInstallationPolicyPackage({domainRoot:root+"domains/kyc-agentic",policySource:stringify(source),release:"candidate"});
  expect(changed.plan.planDigest).not.toBe(prepared.plan.planDigest);
});
it("blocks production candidates and cannot erase an enabled skill's content demand",()=>{
  const source=template();
  expect(()=>compileBusinessPolicy(source,{opaVersion:"1.9.0",release:"production"})).toThrow("policy.production_blocked");
  source.policySets[0].configuration.content.requiredFields=[];
  expect(()=>compileInstallationPolicyPackage({domainRoot:root+"domains/kyc-agentic",policySource:stringify(source),release:"candidate"})).toThrow("policy.installation_skill_demand_missing");
});
