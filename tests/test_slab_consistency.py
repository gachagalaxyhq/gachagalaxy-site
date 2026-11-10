"""Synthetic fixtures test logic, not real PSA access or authenticity."""
import importlib.util
import csv
import io
import json
import tempfile
import sys
from pathlib import Path
import unittest
from unittest.mock import patch
import urllib.error

spec = importlib.util.spec_from_file_location('checker', Path(__file__).parents[1] / 'scripts/slab_consistency.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class ConsistencyTests(unittest.TestCase):
    def row(self, **changes):
        return dict(dict(gradingCompany='PSA', gradingID='12345678', id='a',
                         source='Synthetic', backImage='https://images.example/a'), **changes)

    def test_qr_exact_match(self):
        self.assertEqual(m.qr_check('12345678', {'qr_text': 'https://www.psacard.com/cert/12345678/'})['status'], 'match')

    def test_qr_substring_is_not_match(self):
        self.assertEqual(m.qr_check('12345678', {'qr_text': 'https://www.psacard.com/cert/912345678/'})['status'], 'mismatch')

    def test_qr_spoof_host(self):
        for url in ('https://psacard.com.evil.example/cert/12345678',
                    'https://www.psacard.com@evil.example/cert/12345678',
                    'https://evil.example/?cert=12345678',
                    'https://www.psacard.com/cert/12345678/extra'):
            self.assertEqual(m.qr_check('12345678', {'qr_text': url})['status'], 'review_needed')

    def test_unreadable_is_not_pass(self):
        self.assertEqual(m.qr_check('12345678', {})['status'], 'not_checked')

    def test_no_record_is_not_pass(self):
        self.assertEqual(m.psa_check('12345678', {}, {'IsValidRequest': True})['status'], 'not_checked')

    def test_missing_fields_need_review(self):
        p = {'IsValidRequest': True, 'PSACert': {'CertNumber': '12345678'}}
        self.assertEqual(m.psa_check('12345678', {}, p)['status'], 'review_needed')

    def test_full_record_match(self):
        row = dict(gradeNum=10, year=1999, serial='4', itemName='Charizard', set='Pokemon')
        p = {'IsValidRequest': True, 'PSACert': dict(CertNumber='12345678', CardGrade=10,
             Year=1999, CardNumber='4', Subject='CHARIZARD', Brand='Pokemon')}
        self.assertEqual(m.psa_check('12345678', row, p)['status'], 'record_match')
        p['PSACert']['CardGrade'] = 9
        self.assertEqual(m.psa_check('12345678', row, p)['status'], 'review_needed')

    def test_wrong_returned_cert_needs_review(self):
        p = {'IsValidRequest': True, 'PSACert': {'CertNumber': '87654321'}}
        self.assertEqual(m.psa_check('12345678', {}, p)['status'], 'review_needed')

    def test_forbidden_stops_batch_calls(self):
        client = m.PSAClient('/not-a-real-key', 50)
        with patch.object(m.Path, 'is_file', return_value=True), patch.object(m.Path, 'read_text', return_value='synthetic'), \
             patch.object(m.urllib.request, 'urlopen', side_effect=urllib.error.HTTPError('test', 403, 'forbidden', {}, None)) as call:
            self.assertIsNone(client.lookup('12345678')[0])
            self.assertIsNone(client.lookup('87654321')[0])
            self.assertEqual(call.call_count, 1)

    def test_incomplete_never_authenticates(self):
        class Blocked:
            def lookup(self, cert):
                return None, 'PSA HTTP 403'
        result = m.run([dict(gradingCompany='PSA', gradingID='12345678')],
                       [dict(cert='12345678', qr_text='https://www.psacard.com/cert/12345678/')], Blocked())[0]
        self.assertEqual(result['overall'], 'incomplete')
        self.assertEqual(result['authenticity'], 'not_determined')

    def test_exact_host_security_matrix(self):
        invalid = ('http://psacard.com', 'https://psacard.com.', 'https://psacard.com.evil.test',
                   'https://evil.test@psacard.com', 'https://@psacard.com',
                   'https://psacard.com:444', 'https://psacard.com:bad', 'https://[bad',
                   'https://www.psacard.com\\@evil.test', 'https://psacard%2ecom',
                   'https://psаcard.com')
        for host in invalid:
            with self.subTest(host=host):
                self.assertEqual(m.qr_check('12345678', {'qr_text': host + '/cert/12345678'})['status'], 'review_needed')
        for host in ('https://psacard.com', 'https://www.psacard.com', 'https://psacard.com:443'):
            self.assertEqual(m.qr_check('12345678', {'qr_text': host + '/cert/12345678'})['status'], 'match')

    def test_raw_suffix_is_named_review_not_fake(self):
        raw = '  https://www.psacard.com/cert/12345678/psa?x=1#raw\n'
        result = m.qr_check('12345678', {'qr_text': raw})
        self.assertEqual(result['raw_qr_text'], raw)
        self.assertEqual(result['status'], 'review_needed')
        self.assertEqual(result['cert_comparison'], 'match')
        self.assertTrue({'psa_path_suffix', 'unexpected_query', 'unexpected_fragment',
                         'surrounding_whitespace', 'embedded_control_character'} <= set(result['signals']))
        self.assertEqual(result['rules_version'], m.RULES_VERSION)
        self.assertNotIn('fake', result['reason'])

    def test_empty_query_fragment_and_controls(self):
        for tail, signal in [('?', 'unexpected_query'), ('#', 'unexpected_fragment'),
                             ('?a=b', 'unexpected_query'), ('#x', 'unexpected_fragment')]:
            r = m.qr_check('12345678', {'qr_text': 'https://psacard.com/cert/12345678' + tail})
            self.assertEqual(r['status'], 'review_needed')
            self.assertIn(signal, r['signals'])
        raw = 'https://psa\tcard.com/cert/12345678'
        r = m.qr_check('12345678', {'qr_text': raw})
        self.assertIn('embedded_control_character', r['signals'])
        self.assertEqual(r['raw_qr_text'], raw)

    def test_wrong_cert_with_suffix_is_still_visible(self):
        r = m.qr_check('12345678', {'qr_text': 'https://psacard.com/cert/87654321/psa'})
        self.assertEqual(r['cert_comparison'], 'mismatch')
        self.assertEqual(r['status'], 'review_needed')

    def test_missing_qr_values(self):
        for raw in (None, '', '  ', 123):
            self.assertEqual(m.qr_check('12345678', {'qr_text': raw})['status'], 'not_checked')

    def test_cert_validation(self):
        for invalid in (True, False, 123456.0, [], {}, '12345', '12345678901', '１２３４５６', '=123456'):
            self.assertIsNone(m.cert_number(invalid))
        self.assertEqual(m.cert_number(' 00123456 '), '00123456')

    def test_default_client_zero_calls_no_credential_read(self):
        client = m.PSAClient('/not-a-real-key')
        with patch.object(m.Path, 'is_file', side_effect=AssertionError('credential check')), \
             patch.object(m.urllib.request, 'urlopen', side_effect=AssertionError('network')):
            self.assertIsNone(client.lookup('12345678')[0])
        self.assertEqual(client.calls, 0)

    def test_offline_never_uses_client_or_credentials(self):
        client = m.PSAClient('/not-a-real-key', 50, offline=True)
        with patch.object(m.Path, 'is_file', side_effect=AssertionError('credential check')), \
             patch.object(m.urllib.request, 'urlopen', side_effect=AssertionError('network')):
            self.assertIsNone(client.lookup('12345678')[0])
        with patch.object(client, 'lookup', side_effect=AssertionError('lookup')):
            results = m.run([self.row()], [], client, offline=True)
        self.assertEqual(results[0]['psa']['status'], 'not_checked')
        self.assertEqual(client.calls, 0)

    def test_budget_validation_and_invalid_lookup(self):
        for budget in (-1, 51, True, 1.5):
            with self.assertRaises(ValueError):
                m.PSAClient('/unused', budget)
        client = m.PSAClient('/unused', 1)
        with patch.object(m.Path, 'is_file', side_effect=AssertionError('credential check')):
            self.assertIsNone(client.lookup('../invalid')[0])

    def test_client_cache_and_budget_with_synthetic_response(self):
        response = io.StringIO(json.dumps({'IsValidRequest': True, 'PSACert': {'CertNumber': '12345678'}}))
        client = m.PSAClient('/synthetic-only', 1)
        with patch.object(m.Path, 'is_file', return_value=True), \
             patch.object(m.Path, 'read_text', return_value='synthetic'), \
             patch.object(m.urllib.request, 'urlopen', return_value=response) as call:
            first = client.lookup('12345678')
            self.assertEqual(first, client.lookup('12345678'))
            self.assertIsNone(client.lookup('87654321')[0])
            self.assertEqual(call.call_count, 1)
        self.assertEqual(client.calls, 1)

    def test_distinct_listings_same_cert_not_collapsed(self):
        rows = [self.row(), self.row(id='b', backImage='https://images.example/b')]
        evidence = [dict(cert='12345678', back_url=r['backImage'], dimensions=[10, 20],
                         qr_text='https://psacard.com/cert/' + cert) for r, cert in zip(rows, ['12345678', '87654321'])]
        results = m.run(rows, evidence, offline=True)
        self.assertEqual(len(results), 2)
        self.assertEqual([r['qr']['status'] for r in results], ['match', 'mismatch'])
        self.assertNotEqual(results[0]['record_id'], results[1]['record_id'])
        self.assertEqual(results[0]['qr_evidence'][0]['dimensions'], [10, 20])
        reversed_results = m.run(list(reversed(rows)), list(reversed(evidence)), offline=True)
        self.assertEqual({r['source_metadata']['item_id']: r['record_id'] for r in results},
                         {r['source_metadata']['item_id']: r['record_id'] for r in reversed_results})

    def test_unscoped_evidence_not_reused_for_duplicate_cert(self):
        rows = [self.row(), self.row(id='b')]
        results = m.run(rows, [dict(cert='12345678', qr_text='https://psacard.com/cert/12345678')], offline=True)
        self.assertEqual([r['qr']['status'] for r in results], ['not_checked', 'not_checked'])

    def test_all_evidence_locators_must_match(self):
        row = self.row(listing_id='listing-a')
        for changes in ({'source': 'Other'}, {'listing_id': 'b'}, {'back_url': 'wrong'}, {'image_url': 'wrong'}):
            ev = dict(cert='12345678', qr_text='https://psacard.com/cert/12345678',
                      source='Synthetic', listing_id='listing-a', back_url=row['backImage'])
            ev.update(changes)
            self.assertEqual(m.run([row], [ev], offline=True)[0]['qr']['status'], 'not_checked')

    def test_conflicting_evidence_retained_without_picking_last(self):
        ev = [dict(cert='12345678', qr_text=text) for text in
              ('https://psacard.com/cert/12345678', 'https://evil.test/cert/12345678')]
        result = m.run([self.row()], ev, offline=True)[0]
        self.assertEqual(result['qr']['status'], 'review_needed')
        self.assertEqual(len(result['qr_evidence']), 2)
        self.assertIn('ambiguous_evidence', result['qr']['signals'])
        self.assertEqual(m.run([self.row()], [ev[0], ev[0]], offline=True)[0]['qr']['status'], 'match')

    def test_record_ids_duplicate_identity_and_exact_duplicates(self):
        rows = [self.row(), self.row(itemName='different'), self.row()]
        a = m.run(rows, [], offline=True)
        b = m.run(list(reversed(rows)), [], offline=True)
        self.assertEqual(len({r['record_id'] for r in a}), 3)
        self.assertEqual(sorted(r['record_id'] for r in a), sorted(r['record_id'] for r in b))

    def test_source_neutral_and_partner_inputs(self):
        neutral = {'source': 'Independent', 'rows': [dict(grading_company='PSA', cert='12345678',
                   listing_id='neutral-1', images={'back': 'https://images.example/a'},
                   captured_at='2026-01-01T00:00:00Z', subject='Synthetic') ]}
        result = m.run(neutral, [dict(cert='12345678', image_url='https://images.example/a', qr_text=None)], offline=True)[0]
        self.assertEqual(result['source'], 'Independent')
        self.assertEqual(result['source_metadata']['timestamps']['captured_at'], '2026-01-01T00:00:00Z')
        partner = m.run({'filterNFtCard': [dict(gradingCompany='PSA', gradingID='12345678')]}, [], offline=True)[0]
        self.assertEqual(partner['source'], 'Collector Crypt')
        self.assertEqual(m.normalize_rows([self.row(grade='GEM MINT 10', gradeNum=10)])[0]['gradeNum'], 10)
        self.assertEqual(m.run([dict(gradingCompany='PSA', gradingID='12345678')], [], offline=True)[0]['source'], 'unspecified')

    def test_invalid_rows_and_evidence(self):
        bad_rows = ({}, 'text', [None], [{}], [self.row(images=[])], [self.row(listing=[])],
                    [self.row(source=3)], [self.row(cert='87654321')], [self.row(id={})])
        for rows in bad_rows:
            with self.subTest(rows=rows), self.assertRaises(ValueError):
                m.run(rows, [], offline=True)
        for ev in ({}, [None], [{}], [dict(cert='12345678', qr_text=3)],
                   [dict(cert='12345678', dimensions=[0, 3])], [dict(cert='12345678', back_url=1)]):
            with self.subTest(ev=ev), self.assertRaises(ValueError):
                m.run([self.row()], ev, offline=True)

    def test_all_psa_rows_retained_and_not_checked_summary(self):
        rows = [self.row(), self.row(id='b', gradingID='invalid'), self.row(id='c', gradingCompany='CGC')]
        results = m.run(rows, [], offline=True, checked_at='2026-01-01T00:00:00+00:00')
        totals = m.summary(rows, results, 0)
        self.assertEqual(totals['rows'], 2)
        self.assertEqual(totals['skipped_non_psa'], 1)
        self.assertEqual(totals['invalid_cert'], 1)
        self.assertEqual(totals['not_checked'], {'qr': 2, 'psa': 2})
        self.assertTrue(all(r['authenticity'] == 'not_determined' for r in results))
        self.assertTrue(all(r['checked_at'] == '2026-01-01T00:00:00+00:00' for r in results))

    def test_csv_formula_safety_and_raw_json_preservation(self):
        for text in ('=1+1', '+SUM(1)', '-1', '@SUM(1)', '  =1', '\t=1', '\r=1', '\n=1', '\x00=1', '\ufeff=1'):
            self.assertTrue(m.csv_safe(text).startswith("'"))
        self.assertEqual(m.csv_safe('https://example.test/?x=1'), 'https://example.test/?x=1')
        raw = '=HYPERLINK("https://example.test", "x")\n'
        results = m.run([self.row(source='@source', listing_id='=listing', listing_url='+url')],
                        [dict(cert='12345678', qr_text=raw)], offline=True)
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'out.csv'
            m.export_csv(path, results)
            with path.open(newline='') as stream:
                output = list(csv.DictReader(stream))
        self.assertEqual(len(output), 1)
        for field in ('source', 'listing_id', 'listing_url', 'raw_qr_text'):
            self.assertTrue(output[0][field].startswith("'"))
        self.assertEqual(json.loads(json.dumps(results))[0]['qr']['raw_qr_text'], raw)

    def test_cli_offline_json_csv_round_trip(self):
        with tempfile.TemporaryDirectory() as folder:
            base = Path(folder)
            rows, evidence, output, csv_output = [base / name for name in ('rows.json', 'evidence.json', 'out.json', 'out.csv')]
            rows.write_text(json.dumps({'filterNFtCard': [dict(gradingCompany='PSA', gradingID='12345678')]}))
            evidence.write_text(json.dumps([dict(cert='12345678', qr_text='https://psacard.com/cert/12345678')]))
            argv = ['checker', '--rows', str(rows), '--qr-evidence', str(evidence), '--output', str(output),
                    '--csv-output', str(csv_output), '--offline',
                    # Never let the default ~/.secrets/psa_token path be touched, even just resolved.
                    '--token-file', str(base / 'no-token')]
            with patch.object(sys, 'argv', argv), patch.object(sys, 'stdout', io.StringIO()), \
                 patch.object(m.urllib.request, 'urlopen', side_effect=AssertionError('network')), \
                 patch.object(m.PSAClient, 'lookup', side_effect=AssertionError('lookup')):
                m.main()
            report = json.loads(output.read_text())
            self.assertEqual(report['psa_calls'], 0)
            self.assertEqual(report['summary']['not_checked'], {'qr': 0, 'psa': 1})
            self.assertTrue(report['offline'])
            self.assertEqual(len(report['inputs']), 2)
            self.assertEqual(len(report['inputs'][0]['sha256']), 64)
            self.assertEqual(report['results'][0]['rules_version'], report['rules_version'])
            self.assertEqual(len(list(csv.DictReader(io.StringIO(csv_output.read_text())))), 1)
            for extra in (['--max-psa-calls', '1'], ['--csv-output', str(rows)]):
                with patch.object(sys, 'argv', argv + extra), patch.object(sys, 'stderr', io.StringIO()), self.assertRaises(SystemExit):
                    m.main()

    def test_malformed_psa_payload(self):
        for payload in (None, [], 'invalid'):
            self.assertEqual(m.psa_check('12345678', {}, payload)['status'], 'not_checked')

    def test_empty_batch_summary_has_explicit_zero_not_checked(self):
        self.assertEqual(m.summary([], m.run([], [], offline=True), 0)['not_checked'], {'qr': 0, 'psa': 0})


if __name__ == '__main__':
    unittest.main()
