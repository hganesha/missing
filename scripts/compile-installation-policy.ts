import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { compileInstallationPolicyPackage } from "./lib/installation-policy-package.js";

const [domain,policy,...args]=process.argv.slice(2);
let output:string|undefined,release:"candidate"|"production"="candidate";
for(let index=0;index<args.length;index++){
  if(args[index]==="--out")output=args[++index];
  else if(args[index]==="--release" && ["candidate","production"].includes(args[index+1]??""))release=args[++index] as typeof release;
  else throw new Error("Usage: compile-installation-policy <domain-root> <policy.yaml> --out <new-directory> [--release candidate|production]");
}
if(!domain || !policy || !output)throw new Error("policy.installation_arguments_required");
const target=resolve(output);
if(existsSync(target))throw new Error("policy.installation_output_exists");
const prepared=compileInstallationPolicyPackage({domainRoot:resolve(domain),policySource:readFileSync(resolve(policy),"utf8"),release});
for(const [path,content]of Object.entries(prepared.files)){
  const file=join(target,"domain",path);mkdirSync(dirname(file),{recursive:true});writeFileSync(file,content);
}
writeFileSync(join(target,"policy-bundle.json"),JSON.stringify(prepared.compiled,null,2)+"\n");
writeFileSync(join(target,"plan.json"),prepared.plan.document);
process.stdout.write(JSON.stringify({output:target,planDigest:prepared.plan.planDigest,bundleDigest:prepared.compiled.manifest.bundleDigest,
  policySets:prepared.compiled.policySets.map(set=>({id:set.id,setDigest:set.setDigest})),productionEligible:prepared.compiled.productionEligible,
  releaseBlockers:prepared.compiled.releaseBlockers},null,2)+"\n");
