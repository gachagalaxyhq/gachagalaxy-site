"""Package existing validated six-call preparation into one offline-capable page."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
batch = json.loads((ROOT/'data/additional-mark-preparation.json').read_text())
assert len(batch['records']) == 6 and batch['actual_new_issuance'] == 0
payload = dict(chain=batch['chain'], validation=batch['readonly_chain_validation'], records=batch['records'])
payload['validation'].pop('complete_event_history', None)
template = (ROOT/'operations/mark-signing.template.html').read_text()
library = Path('/tmp/opencode/pub/node_modules/ethers/dist/ethers.umd.min.js').read_text()
output = template.replace('/* EMBED_ETHERS */', library).replace('/* EMBED_BATCH */null', json.dumps(payload, ensure_ascii=True).replace('</', '<\\/'))
(ROOT/'operations/mark-signing.html').write_text(output)
print(json.dumps({'output': 'operations/mark-signing.html', 'records': len(batch['records']), 'bytes': len(output.encode())}))
