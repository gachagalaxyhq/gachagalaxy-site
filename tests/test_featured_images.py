"""Offline image identity, corrupt/missing asset and safe-prepare regression checks."""
import ast
import json
import tempfile
import unittest
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]

class FeaturedImages(unittest.TestCase):
    def test_audited_group_assets_and_evidence_match_original_saved_records(self):
        payload, _ = json.JSONDecoder().raw_decode((ROOT / 'public/platform.html').read_text().split('const D=', 1)[1])
        source = json.loads((ROOT / 'data/cc.json').read_text())
        evidence = json.loads((ROOT / 'public/data/collector-evidence.json').read_text())
        self.assertEqual(evidence['observed_at'], source['updated'])
        # Group numbers move with each Collector Crypt refresh (old 11/71 are now other cards). Audit every
        # decoded CGC group that ships a local asset; Venusaur 2025110440C70775 must remain one of them.
        audited = [(c['i'], c['cn'], c['im'][len('/cards/'):-len('.webp')]) for c in payload['cards']
                   if c['decoded'] and c['g'].startswith('CGC ') and (c['im'] or '').startswith('/cards/')]
        self.assertIn('2025110440C70775', [a for _, _, a in audited])
        for number, name, asset in audited:
            card = next(c for c in payload['cards'] if c['i'] == number)
            original = source['cards'][number-1]
            self.assertTrue(card['decoded'])
            self.assertEqual(card['cn'], name)
            self.assertEqual(original['id'], asset)
            self.assertEqual(card['im'], '/cards/' + asset + '.webp')
            self.assertTrue(any(row[6] is True and row[7] == asset for row in card['L']))
            self.assertEqual(evidence['cards'][str(number)], {key: original[key] for key in ('name', 'set', 'grade', 'point', 'listings')})
            with Image.open(ROOT / 'public/cards' / (asset + '.webp')) as image:
                image.load()
                self.assertGreater(image.width, 100); self.assertGreater(image.height, 100)
                if asset == '2025110440C70775':
                    self.assertEqual(image.size, (299, 504))

    def test_exact_featured_assets_are_readable_and_decoded(self):
        page = (ROOT / 'public/platform.html').read_text()
        payload, _ = json.JSONDecoder().raw_decode(page.split('const D=', 1)[1])
        source = json.loads((ROOT / 'data/cc.json').read_text())['cards']
        manifest = json.loads((ROOT / 'public/data/catalogue/manifest.json').read_text())
        decoded = json.loads((ROOT / 'public/data/catalogue/decoded.json').read_text())
        wanted = {c['L'][0][7] for c in payload['cards'] if c['decoded'] and c['f']}
        matches = {}
        for index in {ref[0] for ref in decoded['refs']}:
            rows = json.loads((ROOT / 'public' / manifest['base_url'].lstrip('/') / manifest['shards'][index]['file']).read_text())
            for row in rows:
                if row['id'].removeprefix('source_id:') in wanted:
                    matches[row['id'].removeprefix('source_id:')] = row
        featured = [c for c in payload['cards'] if c['decoded'] and c['f']]
        self.assertTrue(any(c['im'] for c in featured))
        for card in featured:
            record = source[card['i'] - 1]
            # prepare_collector.matching_image never substitutes another card's photo: with no checked-in
            # asset for this exact listing the image is None (and featuredGroups() hides the tile).
            if not (ROOT / 'public/cards' / (record['id'] + '.webp')).is_file():
                self.assertIsNone(card['im'], card['cn'])
                continue
            self.assertEqual(card['im'], '/cards/' + record['id'] + '.webp')
            row = matches[record['id']]
            self.assertTrue(row['scan']['processed'])
            self.assertEqual(row['scan']['status'], 'decoded')
            self.assertEqual(row['cert'], card['L'][0][5])
            self.assertEqual(row['set'], card['s'])
            self.assertEqual(int(row['number']), int(card['no']))
            self.assertEqual(row['ask'], card['L'][0][2])
            with Image.open(ROOT / 'public' / card['im'].lstrip('/')) as image:
                image.load()
                self.assertGreater(image.width, 100)
                self.assertGreater(image.height, 100)

    def test_prepare_excludes_missing_corrupt_or_mismatched_images(self):
        tree = ast.parse((ROOT / 'preview/prepare_collector.py').read_text())
        function = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'matching_image')
        with tempfile.TemporaryDirectory() as directory:
            public = Path(directory)
            (public / 'cards').mkdir()
            scope = {'Image': Image, 'public': public}
            exec(compile(ast.Module(body=[function], type_ignores=[]), '<matching_image>', 'exec'), scope)
            card = {'s': 'Set', 'no': '1', 'g': 'PSA 10', 'L': [['Source', 'PSA 10', 5, None, None, '12345678', True, 'exact']]}
            source = {'set': 'Set', 'no': '1', 'grade': 'PSA 10', 'id': 'exact', 'listings': [{'id': 'exact', 'cert': '12345678'}]}
            check = scope['matching_image']
            self.assertIsNone(check(card, source))
            asset = public / 'cards/exact.webp'
            asset.write_bytes(b'not an image')
            self.assertIsNone(check(card, source))
            Image.new('RGB', (120, 180), 'white').save(asset, 'WEBP')
            self.assertEqual(check(card, source), '/cards/exact.webp')
            card['L'][0][6] = False
            self.assertIsNone(check(card, source))
            card['L'][0][6] = True
            card['L'][0][5] = '99999999'
            self.assertIsNone(check(card, source))
            card['L'][0][5] = '12345678'
            source['set'] = 'Other set'
            self.assertIsNone(check(card, source))

if __name__ == '__main__':
    unittest.main()
