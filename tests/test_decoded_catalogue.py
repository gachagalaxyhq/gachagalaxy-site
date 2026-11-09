"""Exhaustively verify display selections against actual saved status evidence."""
import collections
import hashlib
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]


class DecodedCatalogue(unittest.TestCase):
    def test_selection_is_exact_decoded_subset_and_all_raw_shards_preserved(self):
        directory = ROOT / 'public/data/catalogue'
        manifest = json.loads((directory / 'manifest.json').read_text())
        selection = json.loads((directory / 'decoded.json').read_text())
        expected, statuses, rows_by_ref = set(), collections.Counter(), {}
        for shard, descriptor in enumerate(manifest['shards']):
            payload = (ROOT / 'public' / manifest['base_url'].lstrip('/') / descriptor['file']).read_bytes()
            self.assertEqual(hashlib.sha256(payload).hexdigest(), descriptor['sha256'])
            for offset, row in enumerate(json.loads(payload)):
                statuses[row['scan']['status']] += 1
                if row['scan']['processed'] is True and row['scan']['status'] == 'decoded':
                    expected.add((shard, offset))
                    rows_by_ref[(shard, offset)] = row
        refs = [tuple(ref) for ref in selection['refs']]
        self.assertEqual(set(refs), expected)
        self.assertEqual(len(refs), len(expected))
        self.assertEqual(selection['decoded_records'], 31081)
        self.assertEqual(sum(statuses.values()), 100877)
        self.assertEqual(statuses['failed'], 428)
        self.assertEqual(statuses['unreadable'], 17229)
        self.assertEqual(statuses['not_processed'], 52100)
        self.assertEqual(len({rows_by_ref[ref]['set'] for ref in refs[:40]}), 40)
        for start in range(0, len(refs), 40):
            page = refs[start:start+40]
            self.assertEqual(len(page), min(40, len(refs)-start))
            self.assertTrue(all(rows_by_ref[ref]['scan']['status'] == 'decoded' for ref in page))

    def test_rendered_group_images_and_listing_eligibility_match_saved_shards(self):
        manifest = json.loads((ROOT / 'public/data/catalogue/manifest.json').read_text())
        decoded = set()
        for descriptor in manifest['shards']:
            rows = json.loads((ROOT / 'public' / manifest['base_url'].lstrip('/') / descriptor['file']).read_text())
            decoded.update(row['id'].removeprefix('source_id:') for row in rows if row['scan']['processed'] is True and row['scan']['status'] == 'decoded')
        page = (ROOT / 'public/platform.html').read_text()
        data = json.JSONDecoder().raw_decode(page.split('const D=', 1)[1])[0]
        source = json.loads((ROOT / 'data/cc.json').read_text())
        for rendered in data['cards']:
            group = source['cards'][rendered['i']-1]
            self.assertEqual(rendered['decoded'], group['id'] in decoded)
            for listing in rendered['L']:
                self.assertEqual(listing[6], listing[7] in decoded)
        self.assertEqual(len(data['cards']), 250, 'raw pricing groups are not deleted')


if __name__ == '__main__':
    unittest.main()
