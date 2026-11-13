import { createHash } from 'node:crypto';
import { describe,it,expect } from 'vitest';
import { canonicalJson,stableDigest } from '@ehf/contracts';
import { importCanonicalCatalog,assignmentFor,FinancialCrimeClient,classifyOutcome,bridgeOutcomeSchema } from './index.js';

const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const artifact=(value:Record<string,unknown>)=>({value,canonical:canonicalJson(value),sha256:stableDigest(value)});
function fixture() {
  const instructions='Use exact arithmetic and admitted evidence.';
  const skill={id:'ownership.ubo.resolve',semver:'0.2.0',description:'Resolve ownership',entrypoint:'financial_crime.skills.ownership:ubo_resolve',
    input_schema:{type:'object',properties:{target:{type:'string'}},required:['target'],additionalProperties:false},
    output_schema:{type:'object',properties:{candidates:{type:'array',items:{type:'string'}}}},instruction_hash:stableDigest(instructions),bundle_code_hash:'a'.repeat(64),
    required_context:[{object_type:'OwnershipInterest',fields:['owner','owned','interest']}],optional_context:[],policy_context_fields:['ownership_threshold'],
    dependencies:{skills:[],capabilities:[],libraries:['financial-crime-skills==0.3.0']},permitted_capabilities:[],effects:'read_only'};
  const agent={id:'agent.identity_ownership',version:'1.0.0',mandate:'Resolve ownership',task_ids:['task.ownership'],
    execution:{allowed_skills:{'ownership.ubo.resolve':'0.2.0'},instructions:'Resolve ownership with sources'}};
  const task={id:'task.ownership',version:'1.0.0',agent_profile:agent.id,steps:[{id:'ubo',skill_id:skill.id,skill_version:skill.semver}]};
  const content=canonicalJson({apiVersion:'fincrime.ehf/catalog-v1',sourceRelease:'0.3.0',contextSchemaVersion:'2.0.0',bundleCodeHash:'a'.repeat(64),
    skills:[{...artifact(skill),instructionContent:instructions}],agents:[artifact(agent)],tasks:[artifact(task)],contextProducts:[]});
  return {apiVersion:'fincrime.ehf/catalog-artifact-v1',content,sha256:sha(content)};
}
function scope() {
  const source=fixture(),{catalog}=importCanonicalCatalog(source,source.sha256);
  return assignmentFor(catalog,{taskId:'task.ownership',skillId:'ownership.ubo.resolve',scope:{tenant_id:'tenant',case_id:'case',run_id:'run',
    node_id:'ubo',work_item_id:'work',execution_id:'execution',work_fencing_epoch:1,run_fencing_epoch:1,case_sequence:3,
    plan_digest:'b'.repeat(64),snapshot_digest:'c'.repeat(64)}});
}
function outcome(status='COMPLETED') {
  return bridgeOutcomeSchema.parse({api_version:'fincrime.ehf/outcome-v1',scope:scope(),status,payload:{candidates:[]},context_manifest:null,
    context_hash:null,evidence_refs:[],proposed_commands:[],provider_captures:[],unresolved_items:[],error_code:null,effects_committed:false,synthetic:true});
}
describe('canonical financial-crime bridge',()=>{
  it('preserves canonical IDs, versions, executable contracts and dependencies',()=>{
    const raw=fixture(),r=importCanonicalCatalog(raw,raw.sha256),s=r.skills[0]!;
    expect(s.id).toBe('ownership.ubo.resolve');expect(s.version).toBe('0.2.0');expect(s.status).toBe('draft');
    expect(s.implementation?.entrypoint).toBe('financial_crime.skills.ownership:ubo_resolve');
    expect(s.implementation?.inputSchema).toEqual((JSON.parse(s.implementation!.canonicalManifest)).input_schema);
    expect(s.implementation?.dependencies.libraries).toEqual(['financial-crime-skills==0.3.0']);
    expect(r.agents[0]!.canonicalProfile?.taskIds).toEqual(['task.ownership']);
  });
  it('requires a pinned source digest and detects artifact modification',()=>{
    const raw=fixture();expect(()=>importCanonicalCatalog(raw,'0'.repeat(64))).toThrow('digest_mismatch');
    expect(()=>importCanonicalCatalog({...raw,content:raw.content+' '},raw.sha256)).toThrow('digest_mismatch');
    const data=JSON.parse(raw.content);data.skills[0].value.entrypoint='arbitrary:code';
    const content=JSON.stringify(data);expect(()=>importCanonicalCatalog({...raw,content,sha256:sha(content)},sha(content))).toThrow('artifact_digest_mismatch');
  });
  it('does not assign a skill outside the selected task',()=>{
    const raw=fixture(),{catalog}=importCanonicalCatalog(raw,raw.sha256);
    expect(()=>assignmentFor(catalog,{taskId:'task.ownership',skillId:'case.close',scope:scope()})).toThrow('assignment_not_declared');
  });
  it.each([['COMPLETED','complete'],['PARTIAL','evidence'],['NEEDS_EVIDENCE','evidence'],['NEEDS_REVIEW','human'],['BLOCKED','blocked'],['FAILED','failed']])('retains %s as %s', (status,kind)=>{
    expect(classifyOutcome(outcome(status))).toBe(kind);
  });
  it('rejects response-scope substitution',async()=>{
    const value=outcome();value.scope.case_id='other';
    const client=new FinancialCrimeClient({endpoint:'http://127.0.0.1/invocations',allowLoopback:true,token:async()=> 'test',fetch:async()=>Response.json(value)});
    await expect(client.execute(scope(),{target:'acme'})).rejects.toThrow('scope_mismatch');
  });
  it('never follows an arbitrary HTTP endpoint or redirects',()=>{
    expect(()=>new FinancialCrimeClient({endpoint:'http://external.invalid',allowLoopback:true,token:async()=>''})).toThrow('endpoint_invalid');
    expect(()=>new FinancialCrimeClient({endpoint:'https://user:password@example.test',token:async()=>''})).toThrow('endpoint_invalid');
  });
});
