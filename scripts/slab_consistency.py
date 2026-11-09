"""Private QR + PSA consistency audit. Never an authenticity verdict.

Reads partner or source-neutral rows plus previously decoded QR evidence;
does not crawl photos or follow QR URLs. Default PSA budget is zero. Use
--offline to prohibit even client lookups. No authenticity verdict is issued.
"""
import argparse
import csv
import hashlib
import json
import re
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from collections import Counter


RULES_VERSION = 'slab-consistency/2.0'
REPORT_VERSION = 1
QR_RULES = {
    'psa_path_suffix': 'Raw /cert/<cert>/psa payload requires human review; not a fake verdict',
    'unexpected_query': 'QR contains an unexpected query delimiter or parameters',
    'unexpected_fragment': 'QR contains an unexpected fragment delimiter or value',
    'unexpected_destination_or_format': 'QR host, scheme, credentials, port or path is unexpected',
    'surrounding_whitespace': 'Raw QR contains surrounding whitespace',
    'embedded_control_character': 'Raw QR contains a control character',
    'ambiguous_evidence': 'Conflicting cached observations require human review',
}


def cert_number(value):
    if isinstance(value, bool) or not isinstance(value, (str, int)):
        return None
    value = str(value or '').strip()
    return value if re.fullmatch(r'[0-9]{6,10}', value) else None


def qr_check(expected, evidence):
    text = evidence.get('qr_text') if evidence else None
    result = {'raw_qr_text': text, 'signals': [], 'rules_version': RULES_VERSION}
    if not isinstance(text, str) or not text.strip():
        return dict(result, status='not_checked', reason='QR unreadable or not supplied')
    signals = result['signals']
    if text != text.strip():
        signals.append('surrounding_whitespace')
    if any(ord(c) < 32 or ord(c) == 127 for c in text):
        signals.append('embedded_control_character')
    if '?' in text.split('#', 1)[0]:
        signals.append('unexpected_query')
    if '#' in text:
        signals.append('unexpected_fragment')
    try:
        u = urllib.parse.urlsplit(text.strip())
        trusted = (u.scheme == 'https' and u.hostname in ('psacard.com', 'www.psacard.com')
                   and u.username is None and u.password is None and u.port in (None, 443))
        match = re.fullmatch(r'/cert/([0-9]{6,10})/?', u.path)
        suffix = re.fullmatch(r'/cert/([0-9]{6,10})/psa/?', u.path)
        if suffix:
            signals.append('psa_path_suffix')
    except ValueError:
        trusted, match = False, None
        suffix = None
    if not trusted or not match:
        if not (trusted and suffix):
            signals.append('unexpected_destination_or_format')
    actual = (match or suffix).group(1) if (match or suffix) else None
    result.update(status=('review_needed' if signals else
                          'match' if actual == expected else 'mismatch'),
                  reason='Exact cert comparison and format review only; not authentication')
    if actual:
        result.update(qr_cert=actual, cert_comparison='match' if actual == expected else 'mismatch')
    return result


def normalized(value):
    return re.sub(r'[^a-z0-9]', '', str(value or '').lower())


def psa_check(expected, row, payload):
    if not isinstance(payload, dict):
        return {'status': 'not_checked', 'reason': 'Malformed PSA payload'}
    if payload.get('IsValidRequest') is not True:
        return {'status': 'not_checked', 'reason': 'PSA did not confirm a valid request'}
    record = payload.get('PSACert')
    if not isinstance(record, dict) or not record:
        return {'status': 'not_checked', 'reason': 'No PSA record returned'}
    if cert_number(record.get('CertNumber')) != expected:
        return {'status': 'review_needed', 'reason': 'PSA response cert missing or different'}
    fields = {}
    for label, local, remote in (
        ('grade', row.get('gradeNum'), record.get('CardGrade')),
        ('year', row.get('year'), record.get('Year')),
        ('card_number', row.get('serial'), record.get('CardNumber')),
        ('subject', row.get('itemName'), record.get('Subject')),
        ('set', row.get('set'), record.get('Brand')),
    ):
        if local in (None, '') or remote in (None, ''):
            fields[label] = 'not_compared'
        else:
            fields[label] = 'match' if normalized(local) == normalized(remote) else 'review_needed'
    # Different naming conventions need a human; no fuzzy matching auto-pass.
    status = 'record_match' if all(v == 'match' for v in fields.values()) else 'review_needed'
    return {'status': status, 'cert_found': True, 'fields': fields,
            'reason': 'Record consistency only; physical slab authenticity not established'}


class PSAClient:
    def __init__(self, token_file, max_calls=0, offline=False):
        if type(max_calls) is not int or not 0 <= max_calls <= 50:
            raise ValueError('PSA batch call budget must be between zero and 50')
        self.token_file = Path(token_file)
        self.max_calls = max_calls
        self.calls = 0
        self.blocked = None
        self.cache = {}
        self.offline = offline

    def lookup(self, cert):
        if self.offline:
            return None, 'Offline mode; PSA not checked'
        if not cert_number(cert):
            return None, 'Invalid cert; PSA not checked'
        if cert in self.cache:
            return self.cache[cert]
        if self.blocked:
            return None, self.blocked
        if self.calls >= self.max_calls:
            return None, 'Batch API call budget reached'
        if not self.token_file.is_file():
            return None, 'PSA credential unavailable'
        self.calls += 1
        req = urllib.request.Request(
            'https://api.psacard.com/publicapi/cert/GetByCertNumber/' + cert,
            headers={'Authorization': 'bearer ' + self.token_file.read_text().strip()})
        try:
            with urllib.request.urlopen(req, timeout=30) as response:
                result = json.load(response), None
        except urllib.error.HTTPError as exc:
            reason = 'PSA HTTP ' + str(exc.code)
            if exc.code in (401, 403, 429):
                self.blocked = reason + '; further calls stopped'
                reason = self.blocked
            result = None, reason
        except (OSError, ValueError):
            result = None, 'PSA request failed; no verification performed'
        self.cache[cert] = result
        return result


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':'), allow_nan=False)


def normalize_rows(value):
    """Accept legacy partner envelopes, lists, or {rows: [...]} neutral input.

    Neutral fields: source, listing_id, listing_url, grading_company, cert,
    grade/year/card_number/subject/set, images, listing, captured_at. No URLs
    are fetched. Full source rows are intentionally not copied into reports.
    """
    partner = isinstance(value, dict) and 'filterNFtCard' in value
    default_source = 'Collector Crypt' if partner else 'unspecified'
    if isinstance(value, dict):
        default_source = value.get('source', default_source)
        value = value.get('filterNFtCard') if partner else value.get('rows')
    if not isinstance(default_source, str) or not default_source.strip():
        raise ValueError('source must be a nonempty string')
    if not isinstance(value, list):
        raise ValueError('Rows must be a list or a rows/filterNFtCard envelope')
    rows = []
    for i, raw in enumerate(value):
        if not isinstance(raw, dict):
            raise ValueError(f'Row {i} must be an object')
        row = dict(raw)
        for neutral, legacy in [('grading_company', 'gradingCompany'), ('cert', 'gradingID'),
                                ('grade', 'gradeNum'), ('card_number', 'serial'), ('subject', 'itemName')]:
            if neutral in raw:
                # Partner rows already use `grade` for descriptive text alongside
                # gradeNum. The established numeric field remains authoritative.
                if neutral == 'grade' and legacy in raw:
                    continue
                if legacy in raw and str(raw[neutral]) != str(raw[legacy]):
                    raise ValueError(f'Row {i} has conflicting {neutral}/{legacy}')
                row[legacy] = raw[neutral]
        row['source'] = raw.get('source', default_source)
        if not isinstance(row['source'], str) or not row['source'].strip():
            raise ValueError(f'Row {i} source must be a nonempty string')
        if not isinstance(row.get('gradingCompany'), str) or not row['gradingCompany'].strip():
            raise ValueError(f'Row {i} requires grading_company/gradingCompany')
        for key in ('listing', 'images'):
            if key in row and row[key] is not None and not isinstance(row[key], dict):
                raise ValueError(f'Row {i} {key} must be an object')
        for key in ('listing_id', 'id'):
            if key in row and row[key] is not None and (isinstance(row[key], bool) or not isinstance(row[key], (str, int))):
                raise ValueError(f'Row {i} {key} must be a string or integer')
        for key in ('listing_url', 'frontImage', 'backImage'):
            if row.get(key) is not None and not isinstance(row[key], str):
                raise ValueError(f'Row {i} {key} must be a string')
        rows.append(row)
    canonical(rows)  # Reject non-JSON and nonfinite input before processing.
    return rows


def validate_evidence(value):
    if not isinstance(value, list):
        raise ValueError('QR evidence must be a list')
    for i, item in enumerate(value):
        if not isinstance(item, dict) or not cert_number(item.get('cert')):
            raise ValueError(f'Evidence {i} requires a valid cert')
        if item.get('qr_text') is not None and not isinstance(item['qr_text'], str):
            raise ValueError(f'Evidence {i} qr_text must be a string or null')
        for key in ('source', 'back_url', 'image_url'):
            if key in item and item[key] is not None and not isinstance(item[key], str):
                raise ValueError(f'Evidence {i} {key} must be a string')
        if item.get('listing_id') is not None and (isinstance(item['listing_id'], bool) or not isinstance(item['listing_id'], (str, int))):
            raise ValueError(f'Evidence {i} listing_id must be a string or integer')
        if 'dimensions' in item and item['dimensions'] is not None:
            dims = item['dimensions']
            if not isinstance(dims, list) or len(dims) != 2 or any(type(n) is not int or n <= 0 for n in dims):
                raise ValueError(f'Evidence {i} dimensions must be two positive integers')
    canonical(value)
    return value


def metadata(row):
    listing = row.get('listing') or {}
    images = dict(row.get('images') or {})
    for key in ('frontImage', 'backImage'):
        if row.get(key) is not None:
            images[key] = row[key]
    return {'listing_id': row.get('listing_id', listing.get('id', listing.get('receiptId', row.get('id')))),
            'item_id': row.get('id'), 'listing_url': row.get('listing_url'),
            'listing': {k: listing[k] for k in ('id', 'receiptId', 'marketplace', 'price', 'currency', 'createdAt', 'updatedAt') if k in listing},
            'images': images,
            'timestamps': {k: row[k] for k in ('captured_at', 'listedAt', 'createdAt', 'updatedAt') if k in row}}


def select_evidence(row, candidates, cert_rows):
    """All supplied locators must agree; cert-only evidence cannot select duplicates."""
    meta = metadata(row)
    urls = {v for v in meta['images'].values() if isinstance(v, str)}
    matches = []
    for item in candidates:
        if item.get('source') is not None and item['source'] != row['source']:
            continue
        if item.get('listing_id') is not None and str(item['listing_id']) != str(meta['listing_id']):
            continue
        image_urls = [item[k] for k in ('back_url', 'image_url') if item.get(k) is not None]
        if any(url not in urls for url in image_urls):
            continue
        if item.get('listing_id') is None and not image_urls and cert_rows != 1:
            continue
        matches.append(item)
    # Exact duplicates are harmless, but conflicting observations must remain visible.
    unique = {canonical(item): item for item in matches}
    return [unique[k] for k in sorted(unique)]


def run(rows, evidence, client=None, *, offline=False, checked_at=None):
    rows = normalize_rows(rows)
    evidence = validate_evidence(evidence)
    checked_at = checked_at or datetime.now(timezone.utc).isoformat()
    index = {}
    for item in evidence:
        index.setdefault(cert_number(item['cert']), []).append(item)
    counts = Counter(cert_number(r.get('gradingID')) for r in rows if r['gradingCompany'] == 'PSA')
    results = []
    occurrences = Counter()
    identity_counts = Counter()
    identities = []
    for row in rows:
        meta = metadata(row)
        identity = {'source': row['source'], 'listing_id': meta['listing_id'], 'item_id': meta['item_id'],
                    'listing_url': meta['listing_url']}
        if all(identity[k] is None for k in ('listing_id', 'item_id', 'listing_url')):
            identity['row'] = row
        identities.append(identity)
        identity_counts[canonical(identity)] += 1
    for row, identity in zip(rows, identities):
        if row.get('gradingCompany') != 'PSA':
            continue
        cert = cert_number(row.get('gradingID'))
        matches = select_evidence(row, index.get(cert, []), counts[cert]) if cert else []
        qr = qr_check(cert, matches[0] if len(matches) == 1 else None)
        if len(matches) > 1:
            qr.update(status='review_needed', reason='Multiple conflicting cached QR observations', signals=['ambiguous_evidence'])
        elif not cert:
            qr.update(reason='Invalid or missing listing cert; QR not checked')
        elif not matches and cert in index:
            qr.update(reason='Cached evidence cannot be uniquely associated with this listing/image')
        if offline or client is None or not cert:
            payload, reason = None, ('Invalid or missing cert' if not cert else
                                    'Offline mode; PSA not checked' if offline else 'No PSA client; PSA not checked')
        else:
            payload, reason = client.lookup(cert)
        psa = psa_check(cert, row, payload) if payload else {'status': 'not_checked', 'reason': reason}
        review = not cert or qr['status'] in ('mismatch', 'review_needed') or psa['status'] == 'review_needed'
        meta = metadata(row)
        if identity_counts[canonical(identity)] > 1:
            identity = dict(identity, duplicate_row=row)
        base_id = hashlib.sha256(canonical(identity).encode()).hexdigest()[:24]
        occurrences[base_id] += 1
        result = {'record_id': base_id + '-' + str(occurrences[base_id]),
                  'rules_version': RULES_VERSION, 'checked_at': checked_at,
                  'cert': cert, 'input_cert': row.get('gradingID'), 'source': row['source'],
                  'source_metadata': meta, 'qr_evidence': matches,
                  'qr': qr, 'psa': psa,
                  'overall': 'review_needed' if review else (
                      'checks_consistent' if qr['status'] == 'match' and psa['status'] == 'record_match'
                      else 'incomplete'), 'authenticity': 'not_determined'}
        results.append(result)
    return results


def summary(rows, results, calls):
    return {'input_rows': len(rows), 'rows': len(results),
            'skipped_non_psa': len(rows) - len(results),
            'invalid_cert': sum(r['cert'] is None for r in results), 'psa_calls': calls,
            **{key: dict(Counter(r[key]['status'] if key != 'overall' else r[key] for r in results))
               for key in ('qr', 'psa', 'overall')},
            'not_checked': {key: sum(r[key]['status'] == 'not_checked' for r in results) for key in ('qr', 'psa')},
            'signals': dict(Counter(s for r in results for s in r['qr']['signals']))}


def csv_safe(value):
    text = '' if value is None else str(value)
    # Quote dangerous spreadsheet prefixes, including whitespace/control-prefixed formulas.
    prefix_stripped = re.sub(r'^[\s\x00-\x1f\ufeff]+', '', text)
    return "'" + text if prefix_stripped.startswith(('=', '+', '-', '@')) or text.startswith(('\t', '\r', '\n')) else text


def export_csv(path, results):
    fields = ('record_id', 'source', 'listing_id', 'listing_url', 'cert', 'raw_qr_text',
              'qr_status', 'qr_signals', 'psa_status', 'overall', 'authenticity', 'checked_at', 'rules_version')
    with Path(path).open('w', encoding='utf-8', newline='') as stream:
        writer = csv.DictWriter(stream, fieldnames=fields)
        writer.writeheader()
        for r in results:
            values = dict(record_id=r['record_id'], source=r['source'],
                          listing_id=r['source_metadata']['listing_id'], listing_url=r['source_metadata']['listing_url'],
                          cert=r['input_cert'], raw_qr_text=r['qr']['raw_qr_text'], qr_status=r['qr']['status'],
                          qr_signals=';'.join(r['qr']['signals']), psa_status=r['psa']['status'], overall=r['overall'],
                          authenticity=r['authenticity'], checked_at=r['checked_at'], rules_version=r['rules_version'])
            writer.writerow({k: csv_safe(v) for k, v in values.items()})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--rows', required=True)
    parser.add_argument('--qr-evidence', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--csv-output')
    parser.add_argument('--offline', action='store_true', help='Never read credentials or call PSA/network')
    parser.add_argument('--token-file', default=str(Path.home() / '.secrets/psa_token'))
    parser.add_argument('--max-psa-calls', type=int, default=0)
    args = parser.parse_args()
    if not 0 <= args.max_psa_calls <= 50:
        parser.error('PSA batch call budget must be between zero and 50')
    if args.offline and args.max_psa_calls:
        parser.error('--offline requires a zero PSA call budget')
    # Reject output/input collisions, including aliases, before any write.
    inputs = {Path(p).resolve() for p in (args.rows, args.qr_evidence, args.token_file)}
    outputs = [Path(p).resolve() for p in (args.output, args.csv_output) if p]
    if inputs.intersection(outputs) or len(set(outputs)) != len(outputs):
        parser.error('Output paths must be distinct and must not overwrite inputs')
    try:
        row_bytes = Path(args.rows).read_bytes()
        evidence_bytes = Path(args.qr_evidence).read_bytes()
        rows = normalize_rows(json.loads(row_bytes))
        evidence = validate_evidence(json.loads(evidence_bytes))
        client = PSAClient(args.token_file, args.max_psa_calls, offline=args.offline)
        checked_at = datetime.now(timezone.utc).isoformat()
        results = run(rows, evidence, client, offline=args.offline, checked_at=checked_at)
        totals = summary(rows, results, client.calls)
        output = {'report_version': REPORT_VERSION, 'rules_version': RULES_VERSION,
                  'checked_at': checked_at, 'offline': args.offline,
                  'basis': 'Supplied listing rows and cached QR observations; no image fetching or QR URL following',
                  'rules': QR_RULES,
                  'inputs': [{'path': p, 'sha256': hashlib.sha256(data).hexdigest()} for p, data in
                             ((args.rows, row_bytes), (args.qr_evidence, evidence_bytes))],
                  'limitations': ['Consistency review only; authenticity not determined',
                                  'No live images, ownership or listing freshness verified',
                                  'Cert-only evidence is not assigned to multiple listings',
                                  'CSV formula protection changes dangerous cell prefixes; JSON retains raw QR text'],
                  'psa_calls': client.calls, 'summary': totals, 'results': results}
        Path(args.output).write_text(json.dumps(output, indent=2, ensure_ascii=False, allow_nan=False), encoding='utf-8')
        if args.csv_output:
            export_csv(args.csv_output, results)
    except (ValueError, OSError, TypeError) as exc:
        parser.error(str(exc))
    print(json.dumps(totals, indent=2))


if __name__ == '__main__':
    main()
