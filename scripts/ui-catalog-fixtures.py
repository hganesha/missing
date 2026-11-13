"""Refresh catalog-owned UI projections without replacing scenario/document fixtures."""
import importlib.util
import json
from pathlib import Path
import sys

root = Path(__file__).resolve().parents[1]
check = '--check' in sys.argv
sys.argv = [sys.argv[0], str(root)]
generator = root / 'apps/fincrime-host/docs/ui/contracts/gen/fixtures_v2.py'
spec = importlib.util.spec_from_file_location('ui_fixture_catalog', generator)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
fixtures = generator.parents[1] / 'fixtures'

def emit(name, value):
    path = fixtures / name
    output = json.dumps(value, indent=1, ensure_ascii=False) + '\n'
    if check:
        if path.read_text() != output:
            raise SystemExit(f'{name} is stale. Run node scripts/ui-sync.mjs')
    elif path.read_text() != output:
        path.write_text(output)

catalog = json.loads((fixtures / 'fincrime.catalog.json').read_text())
catalog.update(catalog=module.CATALOG_VIEW, skills=module.SKILL_SUMMARIES,
    tasks={task['id']: module.task_composition(task) for task in module.TASKS},
    contextProducts={product['id']: module.product_view(product) for product in module.PRODUCTS},
    readiness=module.MATRIX_VIEW)
emit('fincrime.catalog.json', catalog)
scenario = json.loads((fixtures / 'scenario.kyb-1042.json').read_text())
stores = json.loads((fixtures / 'ehf.kyb-1042.json').read_text())['states']
for name, state in scenario['states'].items():
    state['agents'] = dict(catalogDigest=module.CAT_DIGEST, sourceRelease=module.CC['sourceRelease'],
        agents=module.agent_cards(stores[name]), counts=dict(agents=len(module.AGENTS), tasks=len(module.TASKS),
        skills=len(module.SKILLS), contextProducts=len(module.PRODUCTS)))
emit('scenario.kyb-1042.json', scenario)
print(f'Catalog UI fixtures: {len(module.AGENTS)} agents, {len(module.SKILLS)} skills')
