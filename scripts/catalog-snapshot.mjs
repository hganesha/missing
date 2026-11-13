// Deterministic catalog projection. No network or runtime credentials. Source definitions
// are discoverable; they do not become an admitted release through this projection.
import {createHash} from 'node:crypto';
import {readFileSync, writeFileSync, readdirSync} from 'node:fs';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parse} from 'yaml';
import {capabilityDiscovery} from './lib/capability-discovery.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const read=path=>readFileSync(resolve(root,path),'utf8');
const json=path=>JSON.parse(read(path));
const hash=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const presentation=json('config/catalog-presentation.json');
const source='apps/fincrime-host/catalog/ehf-catalog.json';
const artifact=json(source);
if(hash(artifact.content)!==artifact.sha256) throw new Error('Catalog artifact digest mismatch');
const catalog=JSON.parse(artifact.content);
const agents=catalog.agents.map(e=>e.value??JSON.parse(e.canonical));
const skills=catalog.skills.map(e=>e.value??JSON.parse(e.canonical));
const products=catalog.contextProducts;
const entries=[];
const title=value=>String(value).replaceAll('_',' ').replace(/\bubo\b/gi,'beneficial owners').replace(/\bkyc\b/gi,'KYC').replace(/\bpep\b/gi,'PEP').replace(/\bedd\b/gi,'EDD').replace(/\baml\b/gi,'AML').replace(/\bus\b/gi,'US').replace(/^\w/,c=>c.toUpperCase());
const verbs=new Set(['resolve','verify','assess','build','expand','calculate','classify','compare','check','reconcile','evaluate','generate','compose','extract','detect','screen','search','match','normalize','validate','compile','create','profile']);
const skillTitle=id=>{const parts=id.split('.');const verb=parts.at(-1);return presentation.skills[id]??(verbs.has(verb)?`${title(verb)} ${title(parts.slice(0,-1).join(' ')).replace(/^\w/,c=>c.toLowerCase())}`:title(id.replaceAll('.',' ')));};
const label=(kind,id)=>kind==='agents'?presentation.agents[id]??title(id.replace('agent.','')):kind==='context'?presentation.context[id]??title(id):kind==='skills'?skillTitle(id):title(id);
const relation=(kind,id)=>({kind,id,label:label(kind,id)});
const facts=values=>Object.entries(values).map(([label,value])=>({label,value:String(value)}));
const base=(kind,id,name,description,group,status,statusLabel,version,contract,path=source)=>({
  kind,id,entryType:'definition',title:name,description:description??'',group,status,statusLabel,version:String(version??'Not versioned'),tags:[],facts:[],
  source:path,digest:hash(contract),relationships:[],fields:[],contract,notice:null,workspace:null,
});
for(const product of products){
  const consumers=agents.filter(a=>a.context_products.includes(product.id));
  const objects=Object.keys(product.objects);
  const used=skills.filter(s=>[...(s.required_context??[]),...(s.optional_context??[])].some(r=>objects.includes(r.object_type)));
  const group=['identity.intelligence','ownership.intelligence','party360','network.intelligence'].includes(product.id)?'Subject intelligence':['risk.intelligence','case.intelligence','policy.intelligence'].includes(product.id)?'Governance':'Sources and evidence';
  entries.push({...base('context',product.id,label('context',product.id),product.description,group,'defined','Defined',catalog.contextSchemaVersion,product),
    tags:objects,facts:facts({Objects:objects.length,Fields:Object.values(product.objects).flat().length,Consumers:consumers.length}),
    relationships:[...consumers.map(a=>relation('agents',a.id)),...used.map(s=>relation('skills',s.id))],
    fields:Object.entries(product.objects).flatMap(([object,fields])=>fields.map(field=>({name:`${object}.${field}`,description:`Declared field on ${object}.`,key:false}))),
    notice:'Declared fields describe the product contract. Runtime availability and data quality are evaluated for a specific case and consumer.',
    workspace:`/context?product=${encodeURIComponent(product.id)}`});
}
for(const skill of skills){
  const required=skill.required_context??[];
  const contextIds=products.filter(p=>[...required,...(skill.optional_context??[])].some(r=>r.object_type in p.objects)).map(p=>p.id);
  const consumers=agents.filter(a=>skill.id in a.execution.allowed_skills);
  entries.push({...base('skills',skill.id,skillTitle(skill.id),skill.business_outcome,title(skill.id.split('.')[0]),skill.maturity,title(skill.maturity),skill.semver,skill),
    tags:[skill.execution_mode,skill.effects,...(skill.jurisdiction_scope??[])].filter(Boolean),
    facts:facts({Execution:title(skill.execution_mode),Effect:title(skill.effects),'Used by':`${consumers.length} ${consumers.length===1?'agent':'agents'}`}),
    relationships:[...contextIds.map(id=>relation('context',id)),...consumers.map(a=>relation('agents',a.id)),...(skill.dependencies?.skills??[]).map(s=>relation('skills',typeof s==='string'?s:s.skill_id??s.id))],
    fields:required.map(r=>({name:r.object_type,description:`Required context${r.min_count?` · minimum ${r.min_count}`:''}`,key:true})),
    notice:skill.maturity==='implemented_synthetic'?'Implemented with synthetic sources. This maturity does not establish production qualification.':null,
    workspace:`/agents/skills/${encodeURIComponent(skill.id)}`});
}
for(const agent of agents){
  entries.push({...base('agents',agent.id,label('agents',agent.id),agent.mandate,'Business agents','defined','Defined',agent.version,agent),
    tags:agent.personas,facts:facts({Tasks:agent.task_ids.length,Skills:Object.keys(agent.execution.allowed_skills).length,'Context products':agent.context_products.length}),
    relationships:[...Object.keys(agent.execution.allowed_skills).map(id=>relation('skills',id)),...agent.context_products.map(id=>relation('context',id))],
    fields:agent.human_gates.map(gate=>({name:title(gate),description:'Requires accountable human review when this gate applies.',key:true})),
    notice:'This is a source profile. Publication and active work are shown in Agent Studio for the admitted release.',
    workspace:`/agents/${encodeURIComponent(agent.id)}`});
}
const definitionPath='tools/kyc-provider-atlas/capability-model/registry/capability-definitions.json';
const definitions=json(definitionPath);
const bindingPath='tools/kyc-provider-atlas/capability-model/registry/capability-bindings.json';
const bindings=json(bindingPath).records;
const providerRecords=json('tools/kyc-provider-atlas/catalog/providers.json');
const discovery=capabilityDiscovery(providerRecords,definitions.records,bindings,json('config/provider-priorities.json'),json('config/capability-collections.json'));
const definitionByPath=new Map(definitions.records.map(definition=>[definition.capability_path,definition]));
// Functional domains come from canonical capability paths. Inventory type remains a
// separate dimension, so definitions and provider bindings share the same taxonomy.
const capabilityDomain=path=>title(path.split('.')[0]);
for(const definition of definitions.records){
  entries.push({...base('external-capabilities',definition.capability_path,title(definition.capability_path.replaceAll('.',' ')),definition.definition,capabilityDomain(definition.capability_path),definition.status,title(definition.status),definition.definition_version,definition,definitionPath),
    collection:discovery.collectionByPath.get(definition.capability_path),
    tags:[definition.kind,definition.jurisdiction_basis,...definition.allowed_actions],
    facts:facts({Kind:title(definition.kind),'Jurisdiction basis':title(definition.jurisdiction_basis),Schemas:title(definition.schema_status)}),
    notice:'Proposed capability definition. Discovery does not grant permission to execute it.'});
}
const providerNames=new Map(providerRecords.map(provider=>[provider.provider_id,provider.name]));
for(const binding of bindings){
  const definition=definitionByPath.get(binding.capability_path);
  if(!definition) throw new Error(`Missing capability definition for ${binding.binding_id}: ${binding.capability_path}`);
  const safe={capability_id:binding.capability_id,provider_record_id:binding.provider_record_id,actions:binding.actions,jurisdiction:binding.jurisdiction,coverage:binding.coverage,implementation:binding.implementation,governance:binding.governance,versions:binding.versions};
  entries.push({...base('external-capabilities',binding.binding_id,`${providerNames.get(binding.provider_record_id)??title(binding.provider_record_id)} · ${title(binding.capability_path.replaceAll('.',' '))}`,
    definition.definition,capabilityDomain(binding.capability_path),binding.governance.quarantine?'quarantined':'disabled',binding.governance.quarantine?'Quarantined':'Not enabled',binding.model_version,safe,bindingPath),
    collection:discovery.collectionByPath.get(binding.capability_path),
    entryType:'binding',tags:[binding.provider_record_id,binding.jurisdiction.code,binding.implementation.validation],
    facts:facts({Jurisdiction:binding.jurisdiction.code==='unresolved'?'Not established':binding.jurisdiction.code,'Jurisdiction basis':title(definition.jurisdiction_basis),'Jurisdiction status':title(binding.jurisdiction.resolution_status),Coverage:title(binding.coverage.status),Validation:title(binding.implementation.validation)}),
    relationships:[{kind:'external-capabilities',id:binding.capability_path,label:title(binding.capability_path.replaceAll('.',' '))}],
    fields:binding.governance.blockers.map(code=>({name:title(code),description:'Must be resolved before this binding can be enabled.',key:true})),
    notice:`${binding.jurisdiction.code==='unresolved'?'The capability is defined; this provider binding’s semantic jurisdiction is not established. It cannot be used for live execution. ':'Jurisdiction describes proposed source scope, not approved coverage. '}Not enabled for execution. Coverage, entitlement, contract approval and acceptance evidence must be established separately.`});
}
const documentPath='apps/fincrime-host/src/kyc_documents/resources/catalog.json';
const documents=json(documentPath);
const fieldPath='apps/fincrime-host/src/kyc_documents/resources/field-library.json';
const fieldLibrary=json(fieldPath);
const fieldByName=new Map(fieldLibrary.fields.map(field=>[field.name,field]));
for(const doc of documents.document_types){
  entries.push({...base('documents',doc.id,doc.display_name,doc.extraction_notes,title(doc.family),doc.maturity,'Draft extraction contract',doc.version,{...doc,field_definitions:doc.field_names.map(name=>fieldByName.get(name)).filter(Boolean)},documentPath),
    tags:[...doc.use_cases,...doc.origins],facts:facts({Fields:doc.field_names.length,'Key fields':doc.key_fields.length,Kind:title(doc.artifact_kind)}),
    relationships:[...skills.filter(s=>s.id.startsWith('document.')).map(s=>relation('skills',s.id)),...doc.field_names.map(name=>({kind:'documents',id:`field:${name}`,label:title(name)}))],
    fields:doc.field_names.map(field=>({name:field,description:fieldByName.get(field)?.description??'Field declared in the extraction contract.',key:doc.key_fields.includes(field)})),
    notice:'Key fields guide extraction and review. They do not establish a legal obligation to collect this document.'});
}
for(const field of fieldLibrary.fields){
  const consumers=documents.document_types.filter(doc=>doc.field_names.includes(field.name));
  entries.push({...base('documents',`field:${field.name}`,title(field.name),field.description,fieldLibrary.sections[field.section]??title(field.section),'field_definition','Field definition',fieldLibrary.version,field,fieldPath),
    entryType:'field',tags:[field.value_type,field.sensitivity],facts:facts({Type:title(field.value_type),Sensitivity:title(field.sensitivity),'Used by':`${consumers.length} ${consumers.length===1?'document type':'document types'}`}),
    relationships:consumers.map(doc=>({kind:'documents',id:doc.id,label:doc.display_name})),notice:field.normalization});
}
const policyRoot='domains/kyc/policy/catalog';
const files=['domains/kyc/policy/policy.yaml',...readdirSync(resolve(root,policyRoot)).filter(n=>n.endsWith('.yaml')).map(n=>`${policyRoot}/${n}`),...readdirSync(resolve(root,policyRoot,'decision-tables')).filter(n=>n.endsWith('.yaml')).map(n=>`${policyRoot}/decision-tables/${n}`)];
for(const path of files){
  const policy=parse(read(path));
  const meta=policy.metadata??{};
  const id=meta.id??path.split('/').at(-1).replace('.yaml','');
  const name=presentation.policies?.[id]??meta.name??title((meta.gate??id).replace(/^table\.kyc\./,'').replaceAll('-',' ').replaceAll('.',' '));
  const requirements=policy.requirements??[];
  const tables=Object.values(policy.spec?.gates??{}).flatMap(gate=>{
    const source=`domains/kyc/policy/${gate.table}`;
    if(!files.includes(source)) return [];
    const table=parse(read(source));
    return [{kind:'policies',id:table.metadata.id,label:table.metadata.name??table.metadata.id}];
  });
  entries.push({...base('policies',id,name,meta.description??({ 'document-requirements':'Accepted document types mapped to documentary evidence obligations.','evidence-obligations':'Evidence needed to support policy decisions.','rules':'Source rules for customer due diligence and risk assessment.'}[id]??'Versioned KYC policy definitions and governance inputs.'),path.includes('decision-tables')?'Decision tables':'Policy definitions',policy.status??'source_definition',title(policy.status??'Source definition'),meta.version,policy,path),
    tags:['KYC',meta.domain??'kyc'],facts:facts({Owner:meta.owner??'Policy owner',Scope:meta.gate??'KYC',Authority:'Source definition'}),
    relationships:[...tables,...requirements.flatMap(r=>(r.anyOf??[]).map(id=>({kind:'documents',id,label:documents.document_types.find(d=>d.id===id)?.display_name??id})))],
    fields:requirements.map(r=>({name:r.obligation??r.id??'Requirement',description:r.description??'Documentary evidence requirement.',key:true})),
    notice:policy.status==='draft_pending_owner_review'?'Draft pending policy-owner review. This source is not an approved acceptance policy.':'Source definitions are shown here. Approval and publication are managed in Policy Studio.',
    workspace:'/platform/policies'});
}
// The canonical product taxonomy (artifacts/products, compiled by scripts/sync-product-taxonomy.ts).
const productTaxonomy=json('artifacts/products/taxonomy.json');
const productNames=new Map(productTaxonomy.nodes.map(node=>[node.id,node.name]));
const levelLabel={domain:'Domain',class:'Class',type:'Type'};
const enumLabel=value=>title(String(value).toLowerCase());
const capabilityLabel=value=>value===true?'Offered':value===false?'Not offered':'Set per institution offering';
for(const node of productTaxonomy.nodes){
  const domain=node.id.split('.')[0];
  const domainEntry=productTaxonomy.domains.find(entry=>entry.code===domain);
  entries.push({...base('products',node.id,node.name,node.definition,productNames.get(domain),productTaxonomy.status==='APPROVED'?'approved':'candidate',productTaxonomy.status==='APPROVED'?'Approved':'Candidate',
      domainEntry?.version??productTaxonomy.version,node,`domains/products/taxonomy/${domain}.yaml`),
    tags:[levelLabel[node.level],...node.sectors.map(enumLabel),...node.aliases],
    facts:facts({Level:levelLabel[node.level],Sectors:node.sectors.map(enumLabel).join(', '),'Regulated activities':node.regulatedActivities.length?node.regulatedActivities.map(enumLabel).join(', '):'Inherited',
      [node.level==='type'?'Parent':'Children']:node.level==='type'?productNames.get(node.parent):node.children.length}),
    relationships:[...(node.parent?[{kind:'products',id:node.parent,label:productNames.get(node.parent)}]:[]),...node.children.map(id=>({kind:'products',id,label:productNames.get(id)})),
      ...[...node.alsoClassifiedAs,...node.bundle].map(id=>({kind:'products',id,label:productNames.get(id)}))],
    fields:[...Object.entries(node.capabilities).map(([name,value])=>({name:title(name),description:capabilityLabel(value),key:value===true})),
      ...node.riskDimensions.map(name=>({name:enumLabel(name),description:'Inherent risk dimension; weights and thresholds are institution policy.',key:false})),
      ...node.eligiblePartyTypes.map(name=>({name:`Eligible: ${enumLabel(name)}`,description:'Party classification this product may serve.',key:false}))],
    notice:`Canonical product taxonomy ${productTaxonomy.version} (${productTaxonomy.status.toLowerCase()}). A product supplies facts to policy; it never decides a due-diligence level. Not an official regulatory classification.`});
}
// Make relationship navigation bidirectional without inventing a semantic dependency.
for(const entry of entries.filter(e=>e.kind==='policies')) for(const link of entry.relationships){
  const target=entries.find(e=>e.kind===link.kind&&e.id===link.id);
  target?.relationships.push({kind:'policies',id:entry.id,label:entry.title});
}
const identities=new Set(entries.map(e=>`${e.kind}:${e.id}`));
for(const entry of entries){
  entry.relationships=[...new Map(entry.relationships.filter(l=>identities.has(`${l.kind}:${l.id}`)).map(l=>[`${l.kind}:${l.id}`,l])).values()];
  entry.relationships=entry.relationships.map(link=>({...link,entryType:entries.find(target=>target.kind===link.kind&&target.id===link.id).entryType}));
  if(entry.tags.some(tag=>typeof tag!=='string')) throw new Error(`Invalid tags for ${entry.id}`);
}
entries.sort((a,b)=>a.kind.localeCompare(b.kind)||a.id.localeCompare(b.id));
const snapshot={digest:hash({entries,providers:discovery.providers}),sourceRelease:catalog.sourceRelease,scope:'source_definitions',note:'Versioned source definitions. Runtime admission, publication and readiness are evaluated separately.',entries,providers:discovery.providers};
const out=resolve(root,'apps/fincrime-host/docs/ui/contracts/fixtures/catalogs.json');
const text=JSON.stringify(snapshot,null,2)+'\n';
// A service-owned authoring index, shipped with config/ for validation in bundled services.
const authoring={
  definitions:definitions.records.map(d=>({path:d.capability_path,name:title(d.capability_path.replaceAll('.',' ')),description:d.definition,jurisdictionBasis:d.jurisdiction_basis,actions:d.allowed_actions})),
  jurisdictions:json('tools/kyc-provider-atlas/capability-model/registry/jurisdictions.json').records.map(j=>({code:j.token,name:j.name,kind:j.kind})),
  bindings:json(bindingPath).records.map(b=>({bindingId:b.binding_id,sourceDigest:entries.find(e=>e.kind==='external-capabilities'&&e.id===b.binding_id).digest,
    definition:{capabilityPath:b.capability_path,actions:b.actions,jurisdiction:{code:b.jurisdiction.code,evidenceRefs:b.jurisdiction.evidence_refs},coverage:{status:b.coverage.status,
      eligibleSubjectCountries:b.coverage.eligible_subject_countries,eligibleAccountCountries:b.coverage.eligible_account_countries,issuingAuthorities:b.coverage.issuing_authorities,
      datasetRefs:b.coverage.dataset_refs,excludedScopes:b.coverage.excluded_scopes,evidenceRefs:b.coverage.coverage_evidence_refs,freshnessPolicyRef:b.coverage.freshness_policy_ref}}})),
};
const authoringOut=resolve(root,'config/external-capability-bindings.json');
const authoringText=JSON.stringify(authoring,null,2)+'\n';
if(process.argv.includes('--check')){
  if(readFileSync(out,'utf8')!==text) throw new Error('Catalog snapshot is stale. Run node scripts/catalog-snapshot.mjs');
  if(readFileSync(authoringOut,'utf8')!==authoringText) throw new Error('Binding authoring index is stale. Run node scripts/catalog-snapshot.mjs');
}else {writeFileSync(out,text);writeFileSync(authoringOut,authoringText);}
console.log(`Catalog snapshot: ${entries.length} definitions and bindings; ${snapshot.digest.slice(0,12)}`);
