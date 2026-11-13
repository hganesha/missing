/** Disposable local conformance proof: EHF/Postgres -> official Python host -> canonical skills. */
import {execFileSync,spawn,spawnSync,type ChildProcess} from 'node:child_process';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createServer} from 'node:net';
import assert from 'node:assert/strict';
import {createDatabase,postgresInvocationStore,renewExecutionWorkItemLease,completeExecutionWorkItem,getExecutionWorkItem,
  submitHumanWorkDecision,latestExecutionOutcome} from '../packages/persistence/src/index.js';
import {importCanonicalCatalog,FinancialCrimeClient,outcomeCaseCommand,type BridgeOutcome} from '../packages/fincrime-integration/src/index.js';
import {dispatchCanonicalTask} from '../apps/runtime-worker/src/fincrime-dispatch.js';
import {importFinancialCrimeCatalog,readFinancialCrimeCatalog} from '../apps/control-api/src/canonical-catalog.js';
import {buildRuntimeHost} from '../apps/runtime-host/src/app.js';
import {createCaseStore,createKycCase,submitBusinessCommand,verifyCaseLedger} from '../packages/case-store/src/index.js';
import {harnessPlanV2Schema,stableDigest,type RuntimeInvocationV2,type RuntimeInvocationResult} from '../packages/contracts/src/index.js';

const library=resolve(process.argv[2]??'apps/fincrime-host'),output=process.argv[3];
// A smoke must never inherit a deployed execution database or the production security profile.
process.env.SECURITY_PROFILE='development';
delete process.env.PLATFORM_MODE;
delete process.env.EXECUTION_DATABASE_URL;
const python=process.env.FINCRIME_PYTHON??resolve(library,'.venv/bin/python');
const name=`ehf-fincrime-${randomBytes(6).toString('hex')}`,password=randomBytes(24).toString('hex'),token=randomBytes(24).toString('hex');
const docker=(...args:string[])=>execFileSync('docker',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
let child:ChildProcess|undefined,db:ReturnType<typeof createDatabase>|undefined;
const apps:Array<{close:()=>Promise<void>}>=[];
const checks:string[]=[];
try {
  execFileSync('docker',['run','--rm','-d','--name',name,'--label','ehf.test=fincrime','-p','127.0.0.1::5432','-e','POSTGRES_PASSWORD',
    '-e','POSTGRES_DB=ehf_fincrime','postgres:16-alpine'],{env:{...process.env,POSTGRES_PASSWORD:password},stdio:['ignore','pipe','pipe']});
  const port=JSON.parse(docker('inspect',name))[0].NetworkSettings.Ports['5432/tcp'][0].HostPort;
  const databaseUrl=`postgresql://postgres:${password}@127.0.0.1:${port}/ehf_fincrime`;
  db=createDatabase(databaseUrl);
  let ready=false;
  for(let i=0;i<80;i++){try{await db.query('select 1');ready=true;break;}catch{await sleep(100);}}
  assert(ready);
  const migration=spawnSync('pnpm',['--filter','@ehf/persistence','migrate'],{encoding:'utf8',env:{...process.env,SECURITY_PROFILE:'development',DATABASE_URL:databaseUrl}});
  assert.equal(migration.status,0,migration.stderr);
  // Vector search is unrelated to this conformance slice and is not installed in postgres:16-alpine.
  for(const file of readdirSync('packages/case-store/migrations').filter(n=>n.endsWith('.sql')&&!n.includes('vector')).sort()) {
    const sql=readFileSync(`packages/case-store/migrations/${file}`,'utf8').replaceAll('{{CASE_CORE_SCHEMA}}','"case_core"')
      .replaceAll('{{CASE_LEDGER_SCHEMA}}','"case_ledger"').replaceAll('{{EVIDENCE_SCHEMA}}','"evidence"');
    await db.query(sql);
  }
  checks.push('fresh Postgres persistence migrations and case-store migrations (vector extension excluded)');
  const artifact=JSON.parse(readFileSync(resolve(library,'catalog/ehf-catalog.json'),'utf8'));
  const {catalog}=importCanonicalCatalog(artifact,artifact.sha256);
  assert.equal(catalog.skills.length,229);assert.equal(catalog.agents.length,7);assert.equal(catalog.tasks.length,7);
  await importFinancialCrimeCatalog(db,'tenant-synthetic','synthetic-author',artifact,artifact.sha256);
  await importFinancialCrimeCatalog(db,'tenant-synthetic','synthetic-author',artifact,artifact.sha256);
  assert.equal((await readFinancialCrimeCatalog(db,'tenant-synthetic',artifact.sha256))!.skills.length,229);
  assert.equal(await readFinancialCrimeCatalog(db,'other-tenant',artifact.sha256),null);
  checks.push('lossless 229-skill catalog (222 canonical plus seven EHF extensions), seven profiles/tasks, immutable tenant-scoped draft import');
  const plan=harnessPlanV2Schema.parse(JSON.parse(readFileSync('packages/contracts/test-fixtures/conformance.plan.json','utf8')));
  const caseStore=createCaseStore({db,artifactBackend:'postgres',schemas:{core:'case_core',ledger:'case_ledger',evidence:'evidence'}});
  const created=await createKycCase(caseStore,{tenantId:'tenant-synthetic',caseType:'kyc_onboarding',schemaVersion:'kyc.case.v1',jurisdiction:'US',
    policySnapshotDigest:'b'.repeat(64),harnessPlanDigest:plan.planDigest,classification:'CONFIDENTIAL',actor:{type:'HUMAN',principalId:'fixture-author',roles:[]}},'fixture-case');
  const caseId=created.case.caseId,caseSequence=created.case.caseSequence;
  const runId='fincrime-fixture-run';
  await db.query(`insert into harness_control.plans(tenant_id,plan_digest,plan_id,name,domain,version,plan) values('tenant-synthetic',$1,'fixture','fixture','test','1',$2::jsonb) on conflict do nothing`,[plan.planDigest,JSON.stringify(plan)]);
  await db.query(`insert into harness_runtime.runs(run_id,tenant_id,idempotency_key,request_digest,plan_digest,status,input,attempt,fencing_epoch,lease_owner,lease_expires_at)
    values($1,'tenant-synthetic','fixture-run','fixture-request',$2,'running',$3::jsonb,1,1,'fixture-worker',clock_timestamp()+interval '10 minutes')`,[runId,plan.planDigest,JSON.stringify({caseId})]);
  const server=createServer();await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));
  const hostPort=(server.address() as {port:number}).port;await new Promise<void>((done,reject)=>server.close(e=>e?reject(e):done()));
  const fixture=JSON.parse(execFileSync(python,['-c',"import json; from financial_crime.ehf import SyntheticAuthority; from financial_crime import synthetic as f; print(json.dumps({'snapshotDigest':SyntheticAuthority().snapshot_digest,'inputs':{k:f.parameters(k) for k in f.load_registry()}}))"],{cwd:library,encoding:'utf8'}));
  child=spawn(python,['-c',"from financial_crime.ehf import configured_bridge_host; configured_bridge_host().run(host='127.0.0.1')"],{
    cwd:library,env:{...process.env,PORT:String(hostPort),FC_EHF_SYNTHETIC:'true',FC_EHF_CASE_ID:caseId,FC_EHF_CASE_SEQUENCE:String(caseSequence),
      FC_EHF_BEARER_SHA256:createHash('sha256').update(token).digest('hex')},stdio:['ignore','pipe','pipe']});
  let serverLog='';child.stdout?.on('data',d=>{serverLog+=String(d);});child.stderr?.on('data',d=>{serverLog+=String(d);});
  const endpoint=`http://127.0.0.1:${hostPort}/invocations`;
  ready=false;
  for(let i=0;i<200;i++){try{if((await fetch(`http://127.0.0.1:${hostPort}/readiness`)).ok){ready=true;break;}}catch{}await sleep(100);}
  assert(ready,'Python official host failed: '+serverLog.slice(-2000));
  assert.equal((await fetch(endpoint,{method:'POST',body:'{}'})).status,401);
  const client=new FinancialCrimeClient({endpoint,allowLoopback:true,token:async()=>token});
  const base={tenant_id:'tenant-synthetic',case_id:caseId,case_sequence:caseSequence,snapshot_digest:fixture.snapshotDigest,
    run_id:runId,run_fencing_epoch:1,plan_digest:plan.planDigest,admitted_catalog_digest:artifact.sha256};
  const completed:Record<string,string>={};let observation:BridgeOutcome|undefined;
  for(const t of catalog.tasks) {
    const task=t.value as {id:string;steps:Array<{id:string;skill_id:string;input_bindings:Record<string,string>}>};
    const inputs:Record<string,unknown>={};
    for(const step of task.steps)for(const [parameter,name]of Object.entries(step.input_bindings)) inputs[name]=fixture.inputs[step.skill_id][parameter];
    const taskPlan=await client.plan(catalog,task.id,inputs);
    const opts={db,catalog,catalogDigest:artifact.sha256,client,plan:taskPlan,owner:'fixture-worker',instanceId:task.id,maxConcurrency:3,authorize:async()=>base,
      commitObservation:async (value:BridgeOutcome)=>{
        if(value.scope.skill_id!=='ownership.ubo.resolve')return null;
        const command=outcomeCaseCommand(value,{actor:{type:'SYSTEM',principalId:'fixture-worker',roles:[]},authority:{planDigest:plan.planDigest,
          permissionEnvelopeDigest:'c'.repeat(64),policySnapshotDigest:'b'.repeat(64)},preconditions:{caseSequence}});
        const authority={tenant_id:base.tenant_id,case_id:caseId,run_id:base.run_id,plan_digest:plan.planDigest,attempt:1,fencing_epoch:1,
          work_item_id:value.scope.work_item_id,work_fencing_epoch:value.scope.work_fencing_epoch};
        await assert.rejects(submitBusinessCommand(caseStore,command));
        const receipt=await submitBusinessCommand(caseStore,command,authority);assert.equal(receipt.outcome,'ACCEPTED');
        assert.equal((await submitBusinessCommand(caseStore,command,authority)).replayed,true);
        await assert.rejects(submitBusinessCommand(caseStore,{...command,commandId:'altered-observation',idempotencyKey:'altered-observation',
          payload:{outcome:{...value,payload:{forged:true}}}},authority),/unrecorded_outcome/);
        return {commandRef:String(receipt.eventId)};
      }};
    const result=await dispatchCanonicalTask(opts);
    if(task.id==='task.decision_support') {
      assert.equal(result.state,'WAITING');
      const workItemId=result.workIds.decision_human_review!;
      const decision=(principalId:string)=>({decisionId:randomUUID(),tenantId:base.tenant_id,caseId,workItemId,principalId,
        decision:'APPROVE' as const,reasonCode:'fixture.independent_review',rationale:'Synthetic fixture review',evidenceRefs:[],decidedAt:new Date().toISOString()});
      assert.equal((await submitHumanWorkDecision(db,decision('reviewer-a'))).effective,false);
      assert.equal((await submitHumanWorkDecision(db,decision('reviewer-b'))).effective,true);
      assert.equal((await dispatchCanonicalTask({...opts,owner:'restarted-worker'})).state,'COMPLETED');
      completed[task.id]='COMPLETED_AFTER_INDEPENDENT_REVIEW';
    } else {
      assert.equal(result.state,'COMPLETED',task.id+' '+JSON.stringify(Object.fromEntries(Object.entries(result.outcomes).map(([k,v])=>[k,{status:(v as BridgeOutcome)?.status,error:(v as BridgeOutcome)?.error_code}]))));
      assert.equal((await dispatchCanonicalTask({...opts,owner:'restarted-worker'})).state,'COMPLETED');
      completed[task.id]='COMPLETED';
    }
    if(task.id==='task.identity_ownership')observation=result.outcomes.ownership_ubo_resolve as BridgeOutcome;
  }
  checks.push('all seven tasks execute through real HTTP and EHF/Postgres; completed work resumes under a new worker');
  checks.push('independent two-reviewer human suspension and durable resume');
  const missingPlan=await client.plan(catalog,'task.identity_ownership',{entity_id:'acme',name:'Acme',identifiers:['SYN-0001']});
  const unavailable=new FinancialCrimeClient({endpoint,allowLoopback:true,token:async()=>token,fetch:async(_url,init)=>{
    const request=JSON.parse(String(init?.body));return Response.json({api_version:'fincrime.ehf/outcome-v1',scope:request.scope,status:'NEEDS_EVIDENCE',payload:{},
      context_manifest:null,context_hash:null,evidence_refs:[],proposed_commands:[],provider_captures:[],unresolved_items:[],error_code:'SOURCE_UNAVAILABLE',effects_committed:false,synthetic:true});
  }});
  const blocked=await dispatchCanonicalTask({db,catalog,catalogDigest:artifact.sha256,client:unavailable,plan:missingPlan,owner:'fixture-worker',
    instanceId:'missing-provider',maxConcurrency:2,authorize:async()=>base});
  assert.equal(blocked.state,'WAITING');
  const blockedWork=await getExecutionWorkItem(db,base.tenant_id,blocked.workIds.entity_resolve!);
  assert.equal(blockedWork?.status,'SUSPENDED');assert.equal(blockedWork?.reasonCode,'fincrime.blocked');
  checks.push('HTTP success with unavailable evidence suspends work under the task failure policy');
  assert(observation);assert.equal(observation.effects_committed,false);
  const workId=observation.scope.work_item_id;
  await db.query(`update workflow.work_items set status='RUNNING',terminal_at=null,execution_id=$3,lease_owner='fixture-worker',lease_until=clock_timestamp()+interval '1 minute',fencing_epoch=$4 where tenant_id=$1 and work_item_id=$2`,[base.tenant_id,workId,observation.scope.execution_id,observation.scope.work_fencing_epoch]);
  const row=(await db.query('select outcome_digest from case_core.financial_crime_outcomes where tenant_id=$1 and case_id=$2',[base.tenant_id,caseId])).rows[0];
  assert.equal(row.outcome_digest,stableDigest(observation));
  const ledger=await verifyCaseLedger(caseStore,base.tenant_id,caseId);assert.equal(ledger.valid,true);
  checks.push('authorized outcome writeback, idempotent receipt and hash-chained case ledger; proposed actions stay uncommitted');
  // Regression: expiry must deny both renewal and completion before a reconciler moves the fence.
  await db.query("update workflow.work_items set lease_until=clock_timestamp()-interval '1 second' where tenant_id=$1 and work_item_id=$2",[base.tenant_id,workId]);
  assert.equal(await renewExecutionWorkItemLease(db,{tenantId:base.tenant_id,workItemId:workId,executionId:observation.scope.execution_id,fencingEpoch:observation.scope.work_fencing_epoch,leaseSeconds:60}),false);
  await assert.rejects(completeExecutionWorkItem(db,{tenantId:base.tenant_id,workItemId:workId,executionId:observation.scope.execution_id,fencingEpoch:observation.scope.work_fencing_epoch,
    actor:{type:'SYSTEM',principalId:'fixture',roles:[]},output:{},result:{agentResultRef:null,acceptedCommandRefs:[],outputRefs:[],failureCode:null,failureDetailRef:null}}),/lease_expired/);
  checks.push('expired leases cannot renew or complete before reconciliation');
  // Two replicas share actual SQL state; a completed response survives either replica disappearing.
  const request:RuntimeInvocationV2={contractVersion:'runtime.invocation.v2',invocationId:'fixture-invocation',runId:base.run_id,attempt:1,workerId:'fixture-worker',
    leaseId:'fixture-lease',fencingEpoch:1,deadlineAt:new Date(Date.now()+60000).toISOString(),planDigest:plan.planDigest,executionProfileDigest:'d'.repeat(64),executionGrant:'fixture-grant',plan,input:{}};
  let calls=0;
  const execute=async()=>{calls++;await sleep(30);return {contractVersion:'runtime.result.v1',invocationId:request.invocationId,runId:request.runId,
    status:'completed',output:{synthetic:true},errorCode:null,checkpointId:null,providerMetadata:{}} satisfies RuntimeInvocationResult;};
  const a=buildRuntimeHost({authToken:token,invocationStore:postgresInvocationStore(db,base.tenant_id),execute});
  const b=buildRuntimeHost({authToken:token,invocationStore:postgresInvocationStore(db,base.tenant_id),execute});apps.push(a,b);
  const replies=await Promise.all([a,b].map(app=>app.inject({method:'POST',url:'/invocations',payload:request,headers:{authorization:`Bearer ${token}`}})));
  assert.equal(calls,1);assert(replies.some(r=>r.statusCode===200));
  const replay=await b.inject({method:'POST',url:'/invocations',payload:request,headers:{authorization:`Bearer ${token}`}});assert.equal(replay.statusCode,200);
  assert.equal((await b.inject({method:'GET',url:'/invocations/'+request.invocationId,headers:{authorization:`Bearer ${token}`}})).json().state,'completed');
  assert.equal(await postgresInvocationStore(db,'other-tenant').read(request.invocationId),null);
  checks.push('two runtime replicas execute one logical invocation; SQL status/result replay is tenant-scoped');
  const report={synthetic:true,libraryRelease:catalog.sourceRelease,ehfBaseline:'63874109c2ad9c4405e9337c66ec3c87886ddce7',catalogDigest:artifact.sha256,
    bundleCodeHash:catalog.bundleCodeHash,tasks:completed,checks,cloudDeployment:false,liveProviders:false};
  if(output)writeFileSync(output,JSON.stringify(report,null,2)+'\n');process.stdout.write(JSON.stringify(report,null,2)+'\n');
} finally {
  for(const app of apps)await app.close();
  child?.kill('SIGTERM');
  if(child)await Promise.race([new Promise(r=>child!.once('exit',r)),sleep(2000)]);
  if(child && child.exitCode===null)child.kill('SIGKILL');
  await db?.end().catch(()=>undefined);try{docker('rm','-f',name);}catch{}
}
