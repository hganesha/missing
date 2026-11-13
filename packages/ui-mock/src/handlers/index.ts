import { users } from "./users.js";
import {workbench} from "./workbench.js";
import ontology from '../../../library-contracts/src/vendor/ontology.schema.json' with { type: 'json' };
import contextLock from '../../../library-contracts/src/vendor/lock.json' with { type: 'json' };
import relationships from '../../../library-contracts/src/vendor/context-relationships.json' with { type: 'json' };
import { ok } from '../http.js';
import { OPERATIONS } from '@ehf/ui-contracts';
import { fail } from '../http.js';
import { contextSources } from "./context-sources.js";
import { externalProviders } from "./external-providers.js";
import { externalBindings } from "./external-bindings.js";
import { intelligence } from "./intelligence.js";
import { documentFactory } from "./document-factory.js";
import type { Impl } from "../http.js";
import { authoring } from "./authoring.js";
import { documents } from "./documents.js";
import { catalogs } from './catalogs.js';
import { cases } from "./cases.js";
import { fincrime } from "./fincrime.js";
import { humanWork } from "./human-work.js";
import { admin, gateway, integrations, releases } from "./platform.js";
import { policies } from "./policies.js";
import { institutions } from "./institutions.js";
import { impact } from "./impact.js";
import { runs } from "./runs.js";
import { shell } from "./shell.js";
import { sourcePolicies } from "./source-policies.js";

/** Handler implementations by operationId; one per contract operation. */
export const IMPLEMENTATIONS: Record<string, Impl> = {
  getDocumentStudioConfiguration: ctx => ok(ctx, { model: null, unavailableReason: "document_studio.http_services_required" }),
  postDocumentStudioTests: ctx => fail(ctx, 503, "document_studio.http_services_required", "Open HTTP mode to test documents with the configured model and skills."),
  getDocumentStudioTests: ctx => ok(ctx, { items: [] }),
  getDocumentStudioTestsTestId: ctx => fail(ctx, 404, "document_studio.test_not_found", "No live document test is available in mock mode."),
  ...workbench,
  // Source execution is service-backed. Mock mode must not fabricate live qualification.
  ...Object.fromEntries(OPERATIONS.filter(op => op.path.startsWith('/v1/context/')).map(op => [op.operationId, ((ctx) => fail(ctx,503,'context.service_required','Open HTTP mode with the context source service to configure and test sources.')) as Impl])),
  getContextCasesCaseIdBindings: ctx => ok(ctx,{items:[]}),
  getContextCasesCaseIdPulls: ctx => ok(ctx,{items:[]}),
  getContextMappingTemplates: ctx => fail(ctx,404,'fincrime.not_available','Select a real saved source resource to create a mapping template.'),
  getContextRefreshSchedules: ctx => ok(ctx,{schedules:[]}),
  getContextDefinitions: ctx => ok(ctx,{items:[]}),
  getContextSampleRuns: ctx => ok(ctx,{items:[]}),
  getContextMappingsIdEnablement: ctx => ok(ctx,{enablement:null}),
  getContextSchema: ctx => ok(ctx,{schemaVersion:contextLock.context_schema_version,lock:contextLock,objectTypes:ontology['x-context-types'],definitions:ontology.$defs}),
  getContextRelationships: ctx => ok(ctx, relationships),
  getContextSampleRunsId: ctx => fail(ctx,404,'fincrime.not_available','No source sample exists in this mock scenario.'),
  ...contextSources,
  ...intelligence,
  ...documentFactory,
  ...sourcePolicies,
  ...shell,
  ...authoring,
  ...policies,
  ...institutions,
  ...impact,
  ...runs,
  ...cases,
  ...humanWork,
  ...releases,
  ...integrations,
  ...gateway,
  ...admin,
  ...users,
  ...fincrime,
  ...documents,
  ...catalogs,
  ...externalProviders,
  ...externalBindings,
};
