"""Derive visible selections from saved public shards; never open or alter SQL.

The full immutable snapshot and compact search projection remain unchanged.
Run before render.py after publishing a new catalogue snapshot.
"""
import collections
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def build(root=ROOT):
    directory = root / 'public/data/catalogue'
    manifest = json.loads((directory / 'manifest.json').read_text())
    refs, graders, decoded_ids = [], collections.Counter(), set()
    first = []
    for shard, descriptor in enumerate(manifest['shards']):
        rows = json.loads((root / 'public' / manifest['base_url'].lstrip('/') / descriptor['file']).read_text())
        for offset, row in enumerate(rows):
            if row['scan']['processed'] is True and row['scan']['status'] == 'decoded':
                refs.append([shard, offset])
                decoded_ids.add(row['id'])
                graders[row['grader'] or 'Not supplied'] += 1
                if shard == 0:
                    first.append((offset, row))
    # Curate only eligible rows, then append every remaining eligible ref once.
    opening, sets = [], set()
    for offset, row in first:
        if row['name'] and row['set'] and row['image'] and row['set'] not in sets:
            opening.append([0, offset])
            sets.add(row['set'])
            if len(opening) == manifest['page_size']:
                break
    chosen = {tuple(ref) for ref in opening}
    result = dict(version=manifest['version'], criterion='scan.processed === true && scan.status === decoded',
                  total_records=manifest['total_records'], decoded_records=len(refs),
                  graders=dict(sorted(graders.items())), opening_page_sets=len(sets),
                  refs=opening + [ref for ref in refs if tuple(ref) not in chosen])
    (directory / 'decoded.json').write_text(json.dumps(result, separators=(',', ':')))
    return result, decoded_ids


if __name__ == '__main__':
    result, _ = build()
    print(json.dumps({k: result[k] for k in ('version', 'decoded_records', 'total_records', 'opening_page_sets')}))
