import { readFileSync } from "node:fs";
import { afterAll, expect, it } from "vitest";
import { bankingPolicySchema, bankingRelationshipSchema, stableDigest } from "@ehf/contracts";
import { compileBankingRequirements, assessBankingRelationship } from "./banking.js";
import { compileBankingRequirementsWithOpa, assessBankingRelationshipWithOpa } from "./banking-opa.js";
import { closeOpaModules } from "./opa-module.js";
const policy=bankingPolicySchema.parse(JSON.parse(readFileSync(new URL("../../../domains/fincrime/banking-policy.json",import.meta.url),"utf8")));
afterAll(closeOpaModules);
it("preserves every corpus banking applicability and product result with real OPA",async()=>{
  for(const hero of ["H01","H02","H03","H04","H05","H06","H07","H10","H12"]) {
    const record=readFileSync(new URL("../../../fixtures/context-corpus/parties/"+hero+"/records.jsonl",import.meta.url),"utf8")
      .split("\n").filter(Boolean).map(l=>JSON.parse(l)).find(r=>r.object_type==="BankingRelationship");
    const relationship=bankingRelationshipSchema.parse(record.data);
    for(const p of [policy,{...policy,status:"APPROVED" as const,accountOpeningReliefAdopted:true}]) {
      const expected=compileBankingRequirements(relationship,p);
      expect(await compileBankingRequirementsWithOpa(relationship,p),hero).toEqual(expected);
      const {asOf:_at,...basis}=relationship;
      const assessments=expected.requirements.map(q=>({assessmentId:q.id,requirementId:q.id,subjectId:q.subjectId,productId:q.productId,policyId:p.id,
        policyVersion:p.version,policyDigest:stableDigest(p),relationshipDigest:stableDigest(basis),outcome:"SATISFIED",evidenceRefs:["ev@v1"],
        assessedBy:"reviewer",authority:"HUMAN",assessedAt:relationship.asOf,validUntil:"2030-01-01T00:00:00Z"}));
      expect(await assessBankingRelationshipWithOpa(relationship,p,[]),hero).toEqual(assessBankingRelationship(relationship,p,[]));
      expect(await assessBankingRelationshipWithOpa(relationship,p,assessments),hero).toEqual(assessBankingRelationship(relationship,p,assessments));
      if(assessments.length) assessments[0]!.subjectId="different";
      expect(await assessBankingRelationshipWithOpa(relationship,p,assessments),hero).toEqual(assessBankingRelationship(relationship,p,assessments));
    }
  }
});
