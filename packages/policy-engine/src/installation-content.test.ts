import { expect, it } from "vitest";
import { INSTALLATION_CONTENT_SCHEMA_VERSION, validateInstallationContent, projectInstallationContent } from "./installation-content.js";

it("distinguishes absent policy content from an explicit reviewed empty list",()=>{
  const raw={apiVersion:"harness.factory/installation-policy-content-v2",requiredFields:["edd_triggers"],fields:{}};
  expect(validateInstallationContent(raw,"US").unresolved).toEqual(["edd_triggers"]);
  const resolved={...raw,fields:{edd_triggers:{status:"RESOLVED",owner:"owner",basis:"Explicit installation decision",schemaVersion:INSTALLATION_CONTENT_SCHEMA_VERSION,value:[]}}};
  expect(validateInstallationContent(resolved,"US").unresolved).toEqual([]);
  expect(()=>validateInstallationContent({...resolved,fields:{edd_triggers:{...resolved.fields.edd_triggers,value:"anything"}}},"US")).toThrow("policy.content_invalid");
});
it("uses the closed library contract, including schema version, unknown fields and reserved authority fields",()=>{
  const raw={apiVersion:"harness.factory/installation-policy-content-v2",requiredFields:[],fields:{} as Record<string,unknown>};
  for(const [field,value,version] of [["invented_policy",{},INSTALLATION_CONTENT_SCHEMA_VERSION],["risk_weights",{a:"bad"},INSTALLATION_CONTENT_SCHEMA_VERSION],
    ["profile_fields",[],"wrong"],["permissions",[],INSTALLATION_CONTENT_SCHEMA_VERSION]]){
    raw.fields={[String(field)]:{status:"RESOLVED",owner:"owner",basis:"reviewed",schemaVersion:version,value}};
    expect(()=>validateInstallationContent(raw,"US")).toThrow();
  }
});
