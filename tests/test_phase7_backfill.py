import copy, json, shutil, sys, tempfile, unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import phase7_backfill as b


class Phase7BackfillTests(unittest.TestCase):
    def setUp(self):
        self.data, self.digests = b.load(ROOT)
        self.records = b.build_records(self.data, self.digests)

    def test_committed_sql_is_reproducible(self):
        self.assertEqual((ROOT / b.OUT).read_text(), b.generate(ROOT))
        self.assertEqual(b.generate(ROOT), b.generate(ROOT))

    def test_eighteen_distinct_marks_with_onchain_issuance_tx(self):
        self.assertEqual(len(self.records), 18)
        self.assertEqual(len({r['cert'] for r in self.records}), 18)
        onchain = json.loads((ROOT / 'src/onchain.json').read_text())['events']
        for r in self.records:
            first = min(onchain[r['cert']], key=lambda e: e['t'])
            self.assertEqual(r['tx'], first['tx'])
            self.assertEqual({e['tx'] for e in r['payload']['events']},
                             {e['tx'] for e in onchain[r['cert']]})
            self.assertEqual(r['status'], 'published')
            self.assertTrue(r['payload']['receipt_verified'])

    def test_first_six_cite_receipt_check_and_registry_per_event(self):
        first = [r for r in self.records if r['cert'] in b.FIRST_SIX]
        self.assertEqual(len(first), 6)
        for r in first:
            p = r['payload']
            self.assertEqual(p['receipt_source'], 'operations/pre-issuance-receipts-check.json')
            self.assertEqual(r['registry'], b.OLD_REGISTRY)  # issued 2026-09-23 on old registry
            for e in p['events']:
                want = b.OLD_REGISTRY if e['t'].startswith('2026-09-23') else b.CURRENT_REGISTRY
                self.assertEqual(e['registry'], want)
            self.assertEqual(p['events'][-1]['registry'], b.CURRENT_REGISTRY)
        rest = [r for r in self.records if r['cert'] not in b.FIRST_SIX]
        for r in rest:
            self.assertEqual(r['registry'], b.CURRENT_REGISTRY)
            self.assertRegex(r['block_hash'], r'^0x[0-9a-f]{64}$')
            self.assertRegex(r['evidence_sha256'], r'^[0-9a-f]{64}$')

    def test_failed_receipt_aborts(self):
        data = copy.deepcopy(self.data)
        data['first6_receipts']['marks']['100863346'][0]['status'] = '0x0'
        with self.assertRaises(b.BackfillError):
            b.build_records(data, self.digests)

    def test_wrong_registry_aborts(self):
        data = copy.deepcopy(self.data)
        data['first6_receipts']['marks']['109308847'][-1]['to'] = b.CURRENT_REGISTRY
        with self.assertRaises(b.BackfillError):
            b.build_records(data, self.digests)

    def test_journal_tx_mismatch_aborts(self):
        data = copy.deepcopy(self.data)
        data['additional_receipts']['transactions'][0]['tx'] = '0x' + '1' * 64
        with self.assertRaises(b.BackfillError):
            b.build_records(data, self.digests)

    def test_revoked_entry_becomes_revoked_status(self):
        data = copy.deepcopy(self.data)
        data['revoked']['revoked'] = [{'grader': 'PSA', 'cert': '158538600', 'reason': 'test', 'at': '2026-11-10'}]
        recs = {r['cert']: r for r in b.build_records(data, self.digests)}
        self.assertEqual(recs['158538600']['status'], 'revoked')
        self.assertEqual(recs['158538600']['revoked_reason'], 'test')
        data['revoked']['revoked'] = [{'grader': 'PSA', 'cert': '999999999', 'reason': 'x'}]
        with self.assertRaises(b.BackfillError):
            b.build_records(data, self.digests)

    def test_source_digests_embedded(self):
        sql = (ROOT / b.OUT).read_text()
        for path, digest in self.digests.items():
            self.assertIn(f'{digest}  {path}', sql)

    def test_check_mode_detects_stale_file(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            for p in list(b.SOURCES.values()) + [b.OUT]:
                (root / p).parent.mkdir(parents=True, exist_ok=True)
                shutil.copy(ROOT / p, root / p)
            self.assertEqual((root / b.OUT).read_text(), b.generate(root))
            j = json.loads((root / 'src/revoked.json').read_text())
            j['note'] += ' '
            (root / 'src/revoked.json').write_text(json.dumps(j))
            self.assertNotEqual((root / b.OUT).read_text(), b.generate(root))


if __name__ == '__main__':
    unittest.main()
