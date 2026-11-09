"""Full offline publication-boundary verification; never opens the source writable."""
import collections
import hashlib
import importlib.util
import itertools
import json
from pathlib import Path
import sqlite3
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('exporter', ROOT / 'scripts/export_cc_catalogue.py')
exporter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(exporter)
SOURCE = Path('/tmp/opencode/cc_catalogue_audit_by_id/audit.sqlite')


class PublicCatalogue(unittest.TestCase):
    def test_full_export_matches_source_and_only_public_projection(self):
        m = json.loads((ROOT / 'public/data/catalogue/manifest.json').read_text())
        base = ROOT / 'public' / m['base_url'].lstrip('/')
        db = sqlite3.connect(SOURCE.as_uri() + '?mode=ro&immutable=1', uri=True)
        db.row_factory = sqlite3.Row
        sql = db.execute('''SELECT l.id,l.company,l.cert,l.front_url,l.captured_at,l.raw,
            r.listing_id AS result_id,r.status AS scan_status,r.qr_status,r.comparison,r.checked_at
            FROM listings l LEFT JOIN results r ON r.listing_id=l.id AND r.checked_at<=?
            ORDER BY l.first_page,l.rowid''', (m['scan_checkpoint'],))
        seen = set()
        counts = collections.Counter()
        missing = collections.Counter()
        graders = collections.Counter()
        def search_rows():
            for entry in m['search_shards']:
                payload = (base / entry['file']).read_bytes()
                self.assertEqual(hashlib.sha256(payload).hexdigest(), entry['sha256'])
                self.assertEqual(len(payload), entry['bytes'])
                rows = json.loads(payload)
                self.assertEqual(len(rows), entry['count'])
                self.assertLessEqual(len(rows), exporter.SEARCH_SIZE)
                yield from rows
        search = iter(search_rows())
        for number, entry in enumerate(m['shards']):
            payload = (base / entry['file']).read_bytes()
            self.assertEqual(hashlib.sha256(payload).hexdigest(), entry['sha256'])
            self.assertEqual(len(payload), entry['bytes'])
            rows = json.loads(payload)
            self.assertEqual(len(rows), entry['count'])
            self.assertLessEqual(len(rows), exporter.SHARD_SIZE)
            self.assertLess(len(payload), 1024 * 1024)
            for offset, row in enumerate(rows):
                source = next(sql)
                self.assertEqual(row, exporter.project(source))
                self.assertEqual(set(row), set(exporter.PUBLIC_FIELDS))
                self.assertEqual(set(row['scan']), set(exporter.SCAN_FIELDS))
                self.assertNotIn(row['id'], seen)
                seen.add(row['id'])
                self.assertEqual(next(search), [row[k] for k in exporter.SEARCH_FIELDS[:7]] + [number, offset, row['scan']['processed']])
                counts['processed'] += row['scan']['processed']
                counts['priced'] += row['ask'] is not None
                counts['images'] += row['image'] is not None
                graders[row['grader'] or 'Not supplied'] += 1
                for key in exporter.PUBLIC_FIELDS:
                    missing[key] += row[key] is None
                for key, value in row.items():
                    if key not in ('image', 'scan') and isinstance(value, str):
                        self.assertNotRegex(value, r'https?://|[^\s@]+@[^\s@]+\.[^\s@]+')
                if row['image']:
                    self.assertEqual(exporter.image_url(row['image']), row['image'])
                    self.assertEqual(row['image'], source['front_url'])
                if source['result_id'] is None:
                    self.assertFalse(row['scan']['processed'])
                    self.assertEqual(row['scan']['status'], 'not_processed')
                    self.assertIsNone(row['scan']['cert_comparison'])
        self.assertIsNone(next(sql, None))
        self.assertIsNone(next(search, None))
        self.assertEqual(len(seen), db.execute('SELECT COUNT(*) FROM listings').fetchone()[0])
        self.assertEqual(len(seen), m['total_records'])
        self.assertEqual(counts['processed'], m['processed_records'])
        self.assertEqual(counts['priced'], m['priced_records'])
        self.assertEqual(counts['images'], m['image_records'])
        self.assertEqual(dict(graders), m['graders'])
        self.assertEqual({k:v for k,v in missing.items() if v}, m['missing_fields'])
        self.assertEqual(m['pending_records'], len(seen)-counts['processed'])
        order = m['browse_first_shard_order']
        self.assertEqual(sorted(order), list(range(m['shards'][0]['count'])))
        first = json.loads((base / m['shards'][0]['file']).read_text())
        opening = [first[i] for i in order[:40]]
        self.assertEqual(len({r['set'] for r in opening}), 40)
        self.assertEqual(len({r['id'] for r in opening}), 40)
        self.assertTrue(all(r['image'] and r['name'] for r in opening))
        # Explicit counts are expectations from the supplied immutable summary.
        self.assertEqual((len(seen), counts['processed']), (100877, 48777))
        db.close()

    def test_adversarial_values_fail_closed(self):
        for url in ('https://user:secret@arweave.net/image', 'https://arweave.net/image?token=secret',
                    'https://arweave.net/image#secret', 'http://arweave.net/image',
                    'https://evil.example/image', 'https://arweave.net.evil.example/image',
                    'javascript:alert(1)', 'https://arweave.net:444/image'):
            self.assertIsNone(exporter.image_url(url))
        for value in ('https://private.example/qr', 'person@example.invalid', {'token':'secret'}, 'x'*501):
            self.assertIsNone(exporter.text(value))
        self.assertIsNone(exporter.timestamp('not-a-date'))
        self.assertIsNone(exporter.timestamp('2026-11-06'))
        row = dict(id='source_id:test', raw=json.dumps({'itemName':'Public title', 'listing':{'price':0,'currency':'USDC','sellerId':'SECRET'}, 'owner':'SECRET', 'authenticated':True}),
                   company=None,cert='',front_url=None,captured_at=None,result_id=None,
                   scan_status=None,qr_status=None,comparison=None,checked_at=None)
        result = exporter.project(row)
        self.assertEqual(result['ask'], 0)
        self.assertIsNone(result['cert'])
        self.assertNotIn('SECRET', json.dumps(result))
        row['raw'] = json.dumps({'listing': {'price':'99'}})
        self.assertIsNone(exporter.project(row)['ask'])


if __name__ == '__main__':
    unittest.main()
