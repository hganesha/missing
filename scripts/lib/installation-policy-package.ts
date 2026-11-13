import { parse, stringify } from "yaml";
import { compilePackage, directorySource } from "../../packages/compiler/src/index.js";
import { compileBusinessPolicy, projectInstallationContent, validateInstallationContent } from "../../packages/policy-engine/src/index.js";

type Object_ = Record<string, any>;
const reserved=new Set(["permissions","version","jurisdiction","synthetic"]);

/**
 * Prepare a new installation release from the current observation flow. Policy source,
 * skill projections, gate bindings and plan digests change together. This does not approve,
 * publish, admit or activate anything.
 */
export function compileInstallationPolicyPackage(options:{
  domainRoot:string;policySource:string;release:"candidate"|"production";modelProfiles?:string;
}) {
  const source=directorySource(options.domainRoot);
  const files=Object.fromEntries([...source.files].map(([path,bytes])=>[path,new TextDecoder().decode(bytes)]));
  const pkg=parse(files["package.yaml"]!) as Object_;
  const workflowPath=String(pkg.workflow);
  const workflow=parse(files[workflowPath]!) as Object_;
  if(!["kyc","kyb"].includes(pkg.metadata?.domain)) throw new Error("policy.installation_onboarding_package_required");
  const compiled=compileBusinessPolicy(options.policySource,{opaVersion:"1.9.0",release:options.release});
  const projections:Object_[]=[];
  const visit=(value:unknown)=>{
    if(!value || typeof value!=="object")return;
    if(Array.isArray(value)){value.forEach(visit);return;}
    const object=value as Object_;
    if(Array.isArray(object.skillPolicies) && object.skillPolicies.length)projections.push(object);
    for(const child of Object.values(object))visit(child);
  };
  visit(workflow);
  const requiredFields=[...new Set(projections.flatMap(object=>object.skillPolicies[0].fields as string[]))].filter(field=>!reserved.has(field));
  const customerType=pkg.metadata.domain==="kyc"?"individual":"corporate";
  for(const set of compiled.policySets) {
    if(set.scope.customerTypes.some(type=>type!==customerType))throw new Error("policy.installation_customer_scope_mismatch");
    const content=validateInstallationContent(set.configuration.content,set.scope.jurisdiction).content;
    for(const field of requiredFields)if(!content.requiredFields.includes(field))throw new Error("policy.installation_skill_demand_missing:"+field);
  }
  for(const object of projections) {
    const fields=object.skillPolicies[0].fields as string[];
    const permissions=object.skillPolicies[0].values.permissions as string[] ?? [];
    object.skillPolicies=compiled.policySets.map(set=>projectInstallationContent(set,fields,permissions));
  }
  const gates=(workflow.spec.nodes as Object_[]).filter(node=>node.kind==="gate");
  if(!gates.length || gates.some(node=>node.config?.businessDecision!=="v2"))throw new Error("policy.installation_business_gates_required");
  for(const gate of gates) {
    // A gate is authored in the policy, or is the diligence block's gate.
    const diligence=compiled.source.diligence;
    const authored=compiled.source.gates[gate.config.gateId] ?? (diligence && diligence.gateId===gate.config.gateId ? {inputProfile:diligence.inputProfile} : undefined);
    if(!authored || authored.inputProfile!==gate.config.inputProfile)throw new Error("policy.installation_gate_profile_mismatch");
    gate.config.policyRef=compiled.manifest.policyId;
    delete gate.config.policyPacks;
    gate.config.effectivePolicySetDigests=compiled.policySets.map(set=>set.setDigest);
  }
  pkg.metadata.version=compiled.source.metadata.version;
  workflow.metadata.version=compiled.source.metadata.version;
  pkg.policies=[{policyId:compiled.manifest.policyId,policyVersion:compiled.manifest.policyVersion,source:"policy.yaml",digest:compiled.manifest.bundleDigest}];
  files["policy.yaml"]=stringify(compiled.source,{aliasDuplicateObjects:false,lineWidth:0});
  files["package.yaml"]=stringify(pkg,{aliasDuplicateObjects:false,lineWidth:0});
  files[workflowPath]=stringify(workflow,{aliasDuplicateObjects:false,lineWidth:0});
  const plan=compilePackage(files,{modelProfiles:options.modelProfiles??new URL("../../config/model-profiles.json",import.meta.url).pathname});
  return {files,compiled,plan};
}
