"""Run only safe preparation and assert existing catalogue/copy remains intact."""
from pathlib import Path
import hashlib
import json
import runpy

ROOT = Path(__file__).resolve().parents[1]
def payload(page):
    return json.JSONDecoder().raw_decode(page.split('const D=', 1)[1])[0]
paths = [p for directory in ('src', 'data', 'functions', 'static', 'public/data/catalogue')
         for p in (ROOT / directory).rglob('*') if p.is_file()]
paths += [ROOT / 'public/index.html']
before = {p: hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}
old = (ROOT / 'public/platform.html').read_text()
runpy.run_path(str(ROOT / 'preview/prepare_collector.py'))
new = (ROOT / 'public/platform.html').read_text()
assert all(hashlib.sha256(p.read_bytes()).hexdigest() == h for p, h in before.items())
old_data, new_data = payload(old), payload(new)
assert {k: v for k, v in old_data.items() if k not in ('certs', 'oc')} == {k: v for k, v in new_data.items() if k not in ('certs', 'oc')}
source_marks = json.loads((ROOT / 'src/certs.json').read_text())
assert len(source_marks) == len(new_data['certs']) == 18
assert {(m.get('grader', 'PSA'), m['cert']) for m in new_data['certs']} == {(m.get('grader', 'PSA'), m['cert']) for m in source_marks}
# Image localization is the only allowed difference from source Mark evidence.
assert [{k: v for k, v in m.items() if k != 'img'} for m in new_data['certs']] == [{k: v for k, v in m.items() if k != 'img'} for m in source_marks]
assert new_data['oc'] == json.loads((ROOT / 'src/onchain.json').read_text())
# Check visible body copy/markup; only the application script is expected to change.
assert old.split('<body', 1)[1].split('<script', 1)[0] == new.split('<body', 1)[1].split('<script', 1)[0]
print('PASS safe prepare: 18 Marks; cert refs, prices, evidence, catalogue payload, body copy, source/data/functions/static/catalogue/index unchanged')
