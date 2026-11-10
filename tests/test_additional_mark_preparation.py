"""Verify actual saved preparation, not synthetic publication fixtures."""
import base64
import hashlib
import io
import json
from pathlib import Path
import re
import subprocess
import unittest
import sys
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'scripts'))
from prepare_additional_marks import canonical


class ActualPreparation(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.batch = json.loads((ROOT/'data/additional-mark-preparation.json').read_text())

    def test_count_newness_and_no_publication(self):
        b = self.batch
        self.assertEqual((b['existing_distinct_saved_marks'], b['new_candidates'], b['actual_new_issuance']), (6, 6, 0))
        ids = {r['identity'] for r in b['records']}
        self.assertEqual(len(ids), 6)
        self.assertFalse(ids & set(b['existing_identities']))
        self.assertEqual(len(b['readonly_chain_validation']['distinct_issued_identities']), 6)
        self.assertEqual(b['readonly_chain_validation']['additional_existing_issued_identities'], [])
        self.assertFalse(b['public_index_modified'])
        for r in b['records']:
            self.assertEqual(r['issuance'], {'transaction_hash': None, 'published_at': None, 'mark_events': []})
            self.assertFalse(r['public_row_after_issuance']['visible'])

    def test_original_public_schema(self):
        sql = (ROOT/'supabase/migrations/20261026_a5_public_marks.sql').read_text().split('create table if not exists public.mark_events')[0]
        columns = set(re.findall(r'^\s+(\w+)\s+(?:text|numeric|smallint|integer|boolean|timestamptz)\b', sql, re.M))
        required = {'grader', 'cert', 'card_name', 'grade', 'low_usd', 'point_usd', 'high_usd', 'confidence', 'price_basis', 'network'}
        for r in self.batch['records']:
            row = r['public_row_after_issuance']
            self.assertFalse(set(row)-columns)
            self.assertTrue(required <= row.keys())
            self.assertEqual(row['grader'], 'PSA')
            self.assertRegex(row['cert'], r'^[0-9]{6,12}$')
            self.assertEqual(row['network'], 'robinhood-testnet')
            self.assertEqual(row['price_basis'], 'asks')
            self.assertTrue(0 <= row['confidence'] <= 100)
            self.assertTrue(0 < row['low_usd'] <= row['point_usd'] <= row['high_usd'])

    def test_original_evidence_digest_and_photos(self):
        for record in self.batch['records']:
            r = json.loads(json.dumps(record))
            expected = r.pop('evidence_sha256')
            for k in ('cert_key', 'unsigned_transaction'):
                r['contract_proposal'].pop(k)
            self.assertEqual(hashlib.sha256(canonical(r).encode()).hexdigest(), expected)
            image = record['front_image']
            data = base64.b64decode(image['base64'], validate=True)
            self.assertEqual(hashlib.sha256(data).hexdigest(), image['sha256'])
            self.assertEqual(len(data), image['bytes'])
            with Image.open(io.BytesIO(data)) as im:
                self.assertEqual(list(im.size), image['dimensions'])
                im.verify()
            qr = record['slab_qr_evidence']
            self.assertEqual(qr['comparison']['qr_cert'], record['public_row_after_issuance']['cert'])
            self.assertEqual(qr['comparison']['status'], 'match')
            self.assertEqual(qr['comparison']['signals'], [])
            self.assertTrue(qr['observation']['download_succeeded'])
            self.assertTrue(qr['observation']['sha256'])

    def test_pricing_independent_recomputation(self):
        # Load only pure original functions, before its argument/input/output code.
        namespace = {}
        text = (ROOT/'scripts/build_cc.py').read_text()
        pure = text[text.index('MaxDevBps='):text.index('raw=json.load')]
        exec('import re\n'+pure, namespace)
        for r in self.batch['records']:
            comps = r['price_evidence']['comparables']
            self.assertEqual(len({c['cert'] for c in comps}), len(comps))
            self.assertNotIn(r['public_row_after_issuance']['cert'], {c['cert'] for c in comps})
            computed = namespace['appraise']([c['ask_cents'] for c in comps])
            row = r['public_row_after_issuance']
            for k in ('low', 'point', 'high'):
                self.assertEqual(computed[k], row[k+'_usd'])
            self.assertEqual(computed['confidence'], row['confidence'])
            self.assertEqual(computed['prices_used'], row['prices_used'])
            self.assertGreaterEqual(row['prices_used'], 3)

    def test_contract_and_disclosures(self):
        b = self.batch
        self.assertEqual(b['chain']['chain_id'], 46630)
        for r, result in zip(b['records'], b['readonly_chain_validation']['simulations']):
            args = r['contract_proposal']['args']
            self.assertTrue(0 < args[2] <= args[3] <= args[4] < 2**64)
            self.assertEqual((args[5], args[9], args[10]), (0, 0, False))
            self.assertTrue(0 <= args[6] <= 1000)
            self.assertTrue(0 <= args[7] <= 65535)
            self.assertTrue(0 <= args[8] <= 3)
            self.assertEqual(result['identity'], r['identity'])
            self.assertTrue(result['absent_onchain'])
            self.assertEqual(result['eth_call'], 'passed')
            self.assertGreater(int(result['gas_estimate']), 0)
            self.assertEqual(r['checks']['live_grader'], 'not_checked')
            self.assertEqual(r['checks']['authentication'], 'not_determined')
            self.assertEqual(r['checks']['sales_comps'], 'missing')
        # The batch is a dated preparation artifact (its six records were later issued and data/cc.json
        # is refreshed on a schedule), so inputs may legitimately have moved on. Each recorded digest must
        # still resolve to a real tracked revision of that file: the current tree or its git history.
        for p, expected in b['inputs_sha256'].items():
            if hashlib.sha256((ROOT/p).read_bytes()).hexdigest() == expected:
                continue
            revs = subprocess.run(['git', '-C', str(ROOT), 'log', '--all', '--format=%H', '--', p],
                                  capture_output=True, text=True, check=True).stdout.split()
            found = any(hashlib.sha256(subprocess.run(['git', '-C', str(ROOT), 'show', f'{r}:{p}'],
                        capture_output=True, check=True).stdout).hexdigest() == expected for r in revs)
            self.assertTrue(found, f'{p}: recorded input digest matches no tracked revision')


if __name__ == '__main__':
    unittest.main(verbosity=2)
