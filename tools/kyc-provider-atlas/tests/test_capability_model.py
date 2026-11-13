"""Proposed v2 capability model: registry integrity, backfill rules and schema enforcement."""
import collections, copy, json, re, sys, unittest
from pathlib import Path
from jsonschema import Draft202012Validator, FormatChecker

P = Path(__file__).resolve().parents[1]; sys.path.insert(0, str(P))
import build_capability_model as gen

DOC = P.parent / 'docs/CANONICAL_EXTERNAL_CAPABILITY_MODEL.md'
def read(p): return json.loads((P / p).read_text())
def validator(name): return Draft202012Validator(read('schemas/v2/' + name), format_checker=FormatChecker())
DEFS = read('capability-model/registry/capability-definitions.json')
JURS = read('capability-model/registry/jurisdictions.json')
BINDS = read('capability-model/registry/capability-bindings.json')
CROSS = read('capability-model/registry/legacy-crosswalk.json')
LEGACY = read('catalog/provider-capabilities.json')
PROVIDERS = {p['provider_id']: p for p in read('catalog/providers.json')}
FAM = {d['capability_path']: d for d in DEFS['records']}

class CapabilityModelTests(unittest.TestCase):
    def test_generated_outputs_are_current(self):
        out = gen.build()
        stale = [k for k, v in out.items() if (P / k).read_text() != v]
        self.assertEqual([], stale, 'run python build_capability_model.py')

    def test_v2_schemas_are_valid(self):
        for f in (P / 'schemas/v2').glob('*.schema.json'):
            with self.subTest(schema=f.name): Draft202012Validator.check_schema(json.loads(f.read_text()))

    def test_registry_envelopes_and_records_validate(self):
        env = validator('registry-envelope.schema.json')
        for reg in [DEFS, JURS, BINDS, CROSS]:
            with self.subTest(registry=reg['registry']):
                env.validate(reg); self.assertEqual(reg['record_count'], len(reg['records']))
                v = validator(Path(reg['record_schema']).name)
                for r in reg['records']: v.validate(r)

    def test_registry_sources_match_inputs(self):
        for reg in [DEFS, JURS, BINDS, CROSS]:
            for s in reg['sources']:
                with self.subTest(registry=reg['registry'], source=s['path']): self.assertEqual(gen.sha(s['path']), s['sha256'])

    def test_definitions_cover_every_legacy_capability_once(self):
        self.assertEqual(56, len(FAM)); self.assertEqual(56, len(DEFS['records']))
        aliases = [a for d in DEFS['records'] for a in d['legacy_aliases']]
        self.assertEqual(sorted(c['capability'] for c in read('catalog/capabilities.json')), sorted(aliases))
        self.assertEqual(collections.Counter({'legacy_compatible': 37, 'native_inventory_addition': 19}), collections.Counter(d['group'] for d in DEFS['records']))
        for d in DEFS['records']:
            with self.subTest(path=d['capability_path']):
                self.assertNotIn(d['capability_path'], d['not_substitutable_for'])
                self.assertEqual(gen.BASIS_SCOPE_FIELDS[d['jurisdiction_basis']], d['required_scope_fields'])
                self.assertIsNone(d['input_schema_ref']); self.assertEqual('proposed', d['status'])
                self.assertIn('owner_unassigned', d['governance']['blockers'])

    def test_profile_extraction_and_lists_cannot_substitute_for_checks(self):
        for weak, strong in [('account.profile', 'account.ownership'), ('identity.document.extraction', 'identity.document'), ('financial.transactions', 'transaction.monitoring'),
                             ('document.evidence', 'credential.verification'), ('reference.list', 'screening.sanctions'), ('screening.watchlist', 'screening.sanctions'),
                             ('identity.profile', 'identity.person'), ('reference.identifier', 'business.ownership'), ('questionnaire.template', 'questionnaire.collection')]:
            with self.subTest(weak=weak): self.assertIn(strong, FAM[weak]['not_substitutable_for'])
        for p in ['platform.integration', 'platform.testing', 'case.management']:
            self.assertIn('control_success_produces_no_intelligence_assertion', FAM[p]['invariants'])

    def test_jurisdiction_registry(self):
        tokens = {j['token']: j for j in JURS['records']}
        self.assertEqual(len(tokens), len(JURS['records']))
        self.assertFalse(tokens['unresolved']['live_routable_when_approved'])
        self.assertEqual(0, tokens['global']['used_by_binding_count'], 'no binding is promoted to global')
        self.assertNotIn('uk', tokens); self.assertEqual('GB', tokens['gb']['iso_3166_1_alpha2'])
        for j in JURS['records']:
            if j['kind'] == 'iso_3166_1': self.assertEqual(j['token'].upper(), j['iso_3166_1_alpha2'])
            else: self.assertIsNone(j['iso_3166_1_alpha2'])
        used = collections.Counter(b['jurisdiction']['code'] for b in BINDS['records'])
        self.assertTrue(set(used) <= set(tokens))
        for t, n in used.items(): self.assertEqual(n, tokens[t]['used_by_binding_count'])

    def test_every_legacy_binding_survives_with_lineage(self):
        legacy_ids = [b['operation_id'] for b in LEGACY]
        self.assertEqual(sorted(legacy_ids), sorted(x['legacy_binding_id'] for x in CROSS['records']))
        lineage = collections.Counter(b['lineage']['legacy_binding_id'] for b in BINDS['records'])
        self.assertEqual(set(legacy_ids), set(lineage))
        self.assertEqual(825, len(BINDS['records']))
        self.assertEqual([('brazil-receita-federal:business.registry.lookup', 2)], [(k, n) for k, n in lineage.items() if n != 1])
        self.assertEqual(set(PROVIDERS), {b['provider_record_id'] for b in BINDS['records']})
        ids = {b['binding_id'] for b in BINDS['records']}
        for x in CROSS['records']: self.assertTrue(set(x['binding_ids']) <= ids)

    def test_migration_counts(self):
        self.assertEqual(collections.Counter({'vocabulary_mapping': 811, 'semantic_correction': 12, 'conditional_split': 1}), collections.Counter(x['migration'] for x in CROSS['records']))
        self.assertEqual(collections.Counter({'alias_pending_approval': 809, 'migration_required': 13, 'quarantined': 2}), collections.Counter(x['legacy_runtime_disposition'] for x in CROSS['records']))
        rows = collections.Counter('unresolved' if all(c.endswith('.unresolved') for c in x['capability_ids']) else 'concrete' for x in CROSS['records'])
        self.assertEqual({'unresolved': 748, 'concrete': 76}, dict(rows))

    def test_backfill_upgrades_no_evidence_or_readiness(self):
        for b in BINDS['records']:
            with self.subTest(binding=b['binding_id']):
                d = FAM[b['capability_path']]
                self.assertFalse(b['governance']['enabled']); self.assertIsNone(b['governance']['approval_ref'])
                self.assertEqual('proposed', b['jurisdiction']['resolution_status']); self.assertEqual(d['jurisdiction_basis'], b['jurisdiction']['basis'])
                self.assertEqual(f"{b['capability_path']}.intelligence.{b['jurisdiction']['code']}", b['capability_id'])
                self.assertEqual(d['subject_types'], b['subject_types']); self.assertEqual([d['default_action']], b['actions'])
                self.assertEqual('unknown', b['coverage']['status']); self.assertEqual([], b['coverage']['eligible_subject_countries'])
                self.assertFalse(b['implementation']['v2_validated']); self.assertEqual([], b['access']['tenant_ids'])
                self.assertIn('jurisdiction_unresolved' if b['jurisdiction']['code'] == 'unresolved' else 'jurisdiction_not_approved', b['governance']['blockers'])
                if b['lineage']['migration'] != 'vocabulary_mapping':
                    self.assertEqual('none', b['implementation']['validation'], 'fixture evidence never carries over to corrected semantics')
        fixture = [b for b in BINDS['records'] if b['implementation']['validation'] == 'legacy_v1_synthetic_fixture']
        self.assertEqual(9, len(fixture)); self.assertTrue(all(b['lineage']['legacy_mapping_maturity'] == 'fixture_tested' for b in fixture))

    def test_quarantine_is_retained(self):
        q = [b for b in BINDS['records'] if b['governance']['quarantine']]
        self.assertEqual({'finantier'}, {b['provider_record_id'] for b in q}); self.assertEqual(2, len(q))
        for b in q: self.assertIn('provider_quarantined', b['governance']['blockers'])

    def test_semantic_corrections_applied(self):
        by = {x['legacy_binding_id']: x for x in CROSS['records']}
        self.assertEqual(['business.ownership.intelligence.us'], by['fincen-boi:business.registry.lookup']['capability_ids'])
        self.assertEqual(['identity.person.intelligence.mx'], by['mexico-renapo:business.registry.lookup']['capability_ids'])
        self.assertEqual(['questionnaire.template.intelligence.unresolved'], by['wolfsberg-group:questionnaire.collect']['capability_ids'])
        self.assertEqual(['business.registry.intelligence.br', 'identity.tax_id.intelligence.br'], by['brazil-receita-federal:business.registry.lookup']['capability_ids'])
        split = [b for b in BINDS['records'] if b['lineage']['migration'] == 'conditional_split']
        self.assertEqual([['cnpj'], ['cpf', 'cnpj']], [b['selectors']['identifier_schemes'] for b in split])

    def test_binding_schema_rejects_unsafe_enablement(self):
        v = validator('provider-capability-binding.schema.json')
        b = next(x for x in BINDS['records'] if x['jurisdiction']['code'] == 'unresolved')
        bad = copy.deepcopy(b); bad['governance']['enabled'] = True
        self.assertFalse(v.is_valid(bad))
        bad = copy.deepcopy(b); bad['jurisdiction']['code'] = 'uk'
        self.assertFalse(v.is_valid(bad), 'unregistered jurisdiction token')
        bad = copy.deepcopy(b); bad['unexpected'] = 1
        self.assertFalse(v.is_valid(bad), 'unknown fields are rejected')
        concrete = copy.deepcopy(next(x for x in BINDS['records'] if x['capability_id'] == 'business.registry.intelligence.gb'))
        concrete['governance'].update(enabled=True, blockers=[])
        self.assertFalse(v.is_valid(concrete), 'a proposed jurisdiction cannot be enabled')
        concrete['jurisdiction']['resolution_status'] = 'approved'
        self.assertTrue(v.is_valid(concrete))

    def test_v2_envelopes(self):
        req, res = validator('capability-request.schema.json'), validator('capability-result.schema.json')
        r = read('examples/v2/capability-request.json'); req.validate(r)
        bad = copy.deepcopy(r); bad['capability_id'] = 'business.registry.intelligence.unresolved'
        self.assertFalse(req.is_valid(bad), 'unresolved cannot be requested')
        bad = copy.deepcopy(r); bad['scope']['requested_jurisdictions'] = ['unresolved']
        self.assertFalse(req.is_valid(bad))
        x = read('examples/v2/capability-result.json'); res.validate(x)
        bad = copy.deepcopy(x); bad['assessment']['bank_decision'] = 'approved'; self.assertFalse(res.is_valid(bad))
        bad = copy.deepcopy(x); bad['execution']['status'] = 'pending'; bad['assertions'] = [{'claim': 'x'}]; self.assertFalse(res.is_valid(bad))
        bad = copy.deepcopy(x); bad['coverage']['status'] = 'complete'; self.assertFalse(res.is_valid(bad), 'complete coverage with unchecked scope')
        bindings = {b['binding_id'] for b in BINDS['records']}
        self.assertIn(x['binding_id'], bindings)

    @unittest.skipUnless(DOC.exists(), 'design document not in this checkout')
    def test_registry_matches_reviewed_design_document(self):
        text = DOC.read_text().split('## Appendix A')[1].split('## Appendix B')[0]
        rows = {m.group(1): (re.findall(r'`([^`]+)`', m.group(2)), m.group(3)) for m in re.finditer(r'^\| `([^`]+:[^`]+)` \| (.+?) \| `(\w+)` \|', text, re.M)}
        self.assertEqual(824, len(rows))
        for x in CROSS['records']:
            with self.subTest(binding=x['legacy_binding_id']): self.assertEqual(rows[x['legacy_binding_id']], (x['capability_ids'], x['migration']))

if __name__ == '__main__':
    unittest.main()
