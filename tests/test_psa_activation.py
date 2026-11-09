import io, json, sys, tempfile, unittest, urllib.error
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import slab_consistency as m
import psa_activation_check as a


class LedgerTests(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.TemporaryDirectory(); self.p = Path(self.d.name) / 'u.json'
    def tearDown(self):
        self.d.cleanup()

    def test_cap_holds_across_instances(self):
        day = lambda: '2026-11-10'
        for _ in range(3):
            self.assertTrue(m.DailyLedger(self.p, 3, day).take())
        self.assertFalse(m.DailyLedger(self.p, 3, day).take())
        self.assertTrue(m.DailyLedger(self.p, 3, lambda: '2026-11-11').take())

    def test_corrupt_ledger_fails_closed(self):
        self.p.write_text(json.dumps({'2026-11-10': 'x'}))
        self.assertFalse(m.DailyLedger(self.p, 3, lambda: '2026-11-10').take())

    def test_cap_bounds(self):
        for cap in (-1, 51, True):
            with self.assertRaises(ValueError):
                m.DailyLedger(self.p, cap)

    def test_client_respects_ledger(self):
        led = m.DailyLedger(self.p, 0, lambda: '2026-11-10')
        c = m.PSAClient(Path(self.d.name) / 'tok', 5, ledger=led)
        (Path(self.d.name) / 'tok').write_text('synthetic')
        self.assertEqual(c.lookup('12345678'), (None, 'PSA daily call cap reached'))
        self.assertEqual(c.calls, 0)


class ActivationTests(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.TemporaryDirectory()
        self.tok = Path(self.d.name) / 'tok'; self.tok.write_text('synthetic')
        self.led = m.DailyLedger(Path(self.d.name) / 'u.json', 2, lambda: '2026-11-10')
    def tearDown(self):
        self.d.cleanup()

    def test_403_is_not_approved_and_counted(self):
        def opener(*_a, **_k):
            raise urllib.error.HTTPError('u', 403, 'forbidden', {}, None)
        code, r = a.check(self.tok, self.led, opener=opener)
        self.assertEqual((code, r['status'], r['used_today']), (2, 'not_approved', 1))
        self.assertNotIn('synthetic', json.dumps(r))

    def test_active(self):
        body = io.StringIO(json.dumps({'PSACert': {'CertNumber': '109308847', 'CardGrade': 'GEM MT 10'}}))
        code, r = a.check(self.tok, self.led, opener=lambda *_a, **_k: body)
        self.assertEqual((code, r['status']), (0, 'active'))

    def test_cap_and_missing_token(self):
        self.led.take(); self.led.take()
        self.assertEqual(a.check(self.tok, self.led, opener=None)[0], 4)
        self.assertEqual(a.check(Path(self.d.name) / 'none', self.led, opener=None)[0], 5)


if __name__ == '__main__':
    unittest.main()
