"""Build six evidence-backed NEW-cert proposals. Offline source reads only.

Does not import scanner/signing/intake code or modify public indexes. A separate
read-only RPC validation adds contract identities, simulations and gas estimates.
"""
import base64
import hashlib
import io
import json
from pathlib import Path
import re
import sqlite3
from decimal import Decimal
from urllib.parse import urlsplit
import urllib.request
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
DB = Path('/tmp/opencode/cc_catalogue_audit_by_id/audit.sqlite')
OUT = ROOT / 'data/additional-mark-preparation.json'
TARGET = ('158538600', '151114672', '162925956', '120515467', '171402573', '163541653')
HOSTS = {'arweave.net', 'nft.collectorcrypt.com', 'd1xpxki1g4htqu.cloudfront.net'}


def canonical(value):
    def normalized(x):
        if isinstance(x, float) and x.is_integer():
            return int(x)
        if isinstance(x, dict):
            return {k: normalized(v) for k, v in x.items()}
        if isinstance(x, list):
            return [normalized(v) for v in x]
        return x
    return json.dumps(normalized(value), sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False)


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def cents(value):
    amount = Decimal(str(value)) * 100
    if amount != amount.to_integral_value() or amount <= 0:
        raise ValueError('Nonpositive or fractional-cent price')
    return int(amount)


def appraisal(values):
    # Original build_cc.py integer-cent algorithm, not sold-price inference.
    def median(v):
        v = sorted(v)
        return v[len(v)//2] if len(v) % 2 else (v[len(v)//2-1] + v[len(v)//2]) // 2
    initial = median(values)
    kept = [v for v in values if abs(v-initial)*10000//initial <= 6000] or values
    point = median(kept)
    spread = (max(kept)-min(kept))*10000//point
    half = point*(spread//2)//10000
    n = len(kept)
    base = 60 if n >= 10 else 45 if n >= 5 else 30 if n >= 3 else 15 if n else 0
    score = max(0, min(100, base+40-min(spread*40//6000, 40)))
    if n < 2:
        score = min(score, 39)
    elif n < 3:
        score = min(score, 69)
    return {'low': max(point-half, 0), 'point': point, 'high': point+half,
            'confidence': score, 'prices_used': n, 'kept_prices_cents': kept}


def safe_image(url):
    u = urlsplit(url)
    if u.scheme != 'https' or u.hostname not in HOSTS or u.query or u.fragment or u.username or u.password:
        raise ValueError('Image not an approved saved listing asset')


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        raise ValueError('Image redirect requires separate review')


def fetch_image(url):
    safe_image(url)
    req = urllib.request.Request(url, headers={'User-Agent': 'Gacha Mark evidence preparation'})
    with urllib.request.build_opener(NoRedirect).open(req, timeout=40) as response:
        data = response.read(8*1024*1024+1)
        if len(data) > 8*1024*1024:
            raise ValueError('Image exceeds size cap')
    with Image.open(io.BytesIO(data)) as image:
        size, fmt = list(image.size), image.format
        image.verify()
    return {'source_url': url, 'sha256': hashlib.sha256(data).hexdigest(),
            'bytes': len(data), 'dimensions': size, 'format': fmt,
            'base64': base64.b64encode(data).decode(), 'content': 'source_listing_front_photo',
            'physical_card_identity': 'not_checked', 'visual_label_review': 'not_checked'}


def main():
    source = json.loads((ROOT/'data/cc.json').read_text())
    certs = json.loads((ROOT/'src/certs.json').read_text())
    chain = json.loads((ROOT/'src/onchain.json').read_text())
    saved_rows = json.loads(Path('/tmp/opencode/marks_rows.json').read_text())
    existing = {str(r['cert']) for r in certs} | set(chain['events']) | {str(r['cert']) for r in saved_rows}
    assert len(existing) == 6 and not (set(TARGET) & existing)
    db = sqlite3.connect(DB.resolve().as_uri()+'?mode=ro&immutable=1', uri=True)
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA query_only=ON')
    records = []
    for cert in TARGET:
        groups = [g for g in source['cards'] if g['grade'].startswith('PSA ') and any(str(l['cert']) == cert for l in g['listings'])]
        assert len(groups) == 1, 'Ambiguous pricing group'
        g = groups[0]
        rows = db.execute('''SELECT l.id,l.raw,l.front_url,l.back_url,l.captured_at,r.checked_at,r.data
            FROM listings l JOIN results r ON l.id=r.listing_id
            WHERE l.cert=? AND l.company='PSA' AND r.qr_status='match' AND r.comparison='match'
            ORDER BY l.id''', (cert,)).fetchall()
        identities = set()
        valid = []
        for row in rows:
            raw, evidence = json.loads(row['raw']), json.loads(row['data'])
            observation, qr = evidence.get('observation', {}), evidence.get('qr', {})
            if not (observation.get('status') == 'decoded' and observation.get('download_succeeded')
                    and observation.get('sha256') and observation.get('url') == row['back_url']
                    and qr.get('status') == 'match' and qr.get('qr_cert') == cert and not qr.get('signals')):
                continue
            serial = str(raw.get('serial', '')).split('/')[0].lstrip('0')
            grade_match = re.search(r'(\d+(?:\.\d+)?)\s*$', raw.get('grade', ''))
            grade = str(raw['gradeNum']) if raw.get('gradeNum') is not None else grade_match.group(1) if grade_match else None
            if grade is not None:
                grade = format(float(grade), 'g')
            identity = (raw.get('set'), serial, grade)
            identities.add(identity)
            if identity == (g['set'], g['no'], g['grade'].split(' ')[1]):
                valid.append((row, raw, evidence))
        assert len(identities) == 1 and valid, 'Conflicting or missing cert-level evidence'
        row, raw, evidence = valid[0]
        # Exclude the subject's own ask and duplicate certificates from pricing.
        grouped = {}
        for listing in g['listings']:
            other = str(listing.get('cert') or '')
            if other == cert or not re.fullmatch('[0-9]{6,12}', other):
                continue
            grouped.setdefault(other, []).append(listing)
        comps = []
        for other, items in sorted(grouped.items()):
            if len({cents(x['ask']) for x in items}) != 1:
                continue  # Ambiguous duplicate asks are not selected as evidence.
            item = sorted(items, key=lambda x: x['id'])[0]
            comps.append({'listing_id': item['id'], 'cert': other, 'ask_cents': cents(item['ask']),
                          'listed_at': item.get('listed'), 'observed_at': source['updated'],
                          'currency': 'USD-equivalent stablecoin ask; original token not retained in grouped snapshot'})
        assert len(comps) >= 3
        app = appraisal([x['ask_cents'] for x in comps])
        assert app['prices_used'] >= 3 and app['low'] > 0
        score = app['confidence']
        # NONE risk means unassessed, NOT a favorable risk verdict. No lending.
        args = ['PSA', cert, app['low'], app['point'], app['high'], 0, score*10,
                app['prices_used'], 3 if score >= 70 else 2 if score >= 40 else 1, 0, False]
        assert 0 < args[2] <= args[3] <= args[4] < 2**64
        assert 0 <= args[5] <= 9000 and 0 <= args[6] <= 1000 and args[7] <= 65535
        assert 0 <= args[8] <= 3 and 0 <= args[9] <= 4
        # Use the same listing's saved frontM CDN asset, avoiding changing
        # endpoint redirects; retain the original frontImage URL separately.
        photo_url = (raw.get('images') or {}).get('frontM') or row['front_url']
        image = fetch_image(photo_url)
        image['original_front_url'] = row['front_url']
        public_row = {'grader': 'PSA', 'cert': cert, 'card_name': g['name'], 'card_no': g['no'],
                      'set_name': g['set'], 'year': str(raw['year']) if raw.get('year') else None,
                      'grade': g['grade'], 'grade_label': raw.get('grade'),
                      'low_usd': app['low']/100, 'point_usd': app['point']/100, 'high_usd': app['high']/100,
                      'confidence': score, 'prices_used': app['prices_used'], 'price_basis': 'asks',
                      'img_url': photo_url, 'qr_svg': None, 'network': 'robinhood-testnet',
                      'kind': 'mark', 'revoked': False, 'visible': False}
        record = {'identity': 'PSA:'+cert, 'status': 'prepared_not_issued', 'public_row_after_issuance': public_row,
                  'source': {'name': source['source'], 'pricing_snapshot': 'data/cc.json',
                             'pricing_observed_at': source['updated'], 'listing_id': row['id'],
                             'listing_captured_at': row['captured_at'], 'listed_at': raw.get('listedAt'),
                             'subject': raw.get('itemName'), 'schema': 'supabase/migrations/20261026_a5_public_marks.sql'},
                  'price_evidence': {'basis': 'asks', 'not_sales': True, 'not_live': True,
                                     'source_group_identity': [g['set'], g['no'], g['grade']],
                                     'self_ask_excluded': True, 'dedupe': 'one unambiguous ask per PSA cert',
                                     'algorithm': 'scripts/build_cc.py integer-cent median +/-60% filter; recomputed after dedupe and self exclusion',
                                     'comparables': comps, 'calculation': app},
                  'slab_qr_evidence': {'image_url': row['back_url'], 'checked_at': row['checked_at'],
                                       'observation': evidence['observation'], 'comparison': evidence['qr']},
                  'front_image': image,
                  'checks': {'live_grader': 'not_checked', 'authentication': 'not_determined',
                             'ownership': 'not_checked', 'custody': 'not_checked', 'sales_comps': 'missing',
                             'collateral_eligibility': 'not_assessed', 'public_mark_qr': 'missing_until_issued',
                             'front_photo_cert_visual_match': 'not_checked'},
                  'contract_proposal': {'method': 'publish(string,string,uint64,uint64,uint64,uint16,uint16,uint16,uint8,uint8,bool)',
                                        'args': args, 'confidence_score_mapping': 'ask-dispersion score 0..100 multiplied by 10; not grader confidence',
                                        'compCount_semantics': 'retained marketplace asks, NOT comparable sales',
                                        'risk': 'NONE (unassessed)', 'eligible': False, 'ltvBps': 0},
                  'issuance': {'transaction_hash': None, 'published_at': None, 'mark_events': []}}
        record['evidence_sha256'] = digest(record)
        records.append(record)
    assert len({r['identity'] for r in records}) == 6
    assert len({tuple(r['price_evidence']['source_group_identity']) for r in records}) == 6
    batch = {'version': 1, 'status': 'prepared_not_issued', 'existing_distinct_saved_marks': len(existing),
             'new_candidates': len(records), 'actual_new_issuance': 0, 'public_index_modified': False,
             'chain': {'name': chain['chain'], 'chain_id': 46630, 'rpc': 'https://rpc.testnet.chain.robinhood.com',
                       'registry': chain['registry'], 'explorer': chain['explorer'],
                       'contract_source_url': chain['explorer']+'/api/v2/smart-contracts/'+chain['registry'],
                       'explorer_is_verified': False, 'source_supplied_via_verified_twin': True},
             'existing_identities': ['PSA:'+x for x in sorted(existing)],
             'inputs_sha256': {p: hashlib.sha256((ROOT/p).read_bytes()).hexdigest() for p in
                              ['data/cc.json', 'src/certs.json', 'src/onchain.json', 'scripts/build_cc.py',
                               'supabase/migrations/20261026_a5_public_marks.sql']},
             'constraints': {'no_secret_reads': True, 'no_signing': True, 'no_transactions': True,
                             'no_database_writes': True, 'no_deploy': True, 'no_commit': True,
                             'no_ui_intake_or_gg_paths_changes': True},
             'records': records}
    OUT.write_text(json.dumps(batch, indent=2, ensure_ascii=False, allow_nan=False)+'\n')
    print(json.dumps({'prepared': len(records), 'actual_new_issuance': 0,
                      'rows': [{'cert': r['public_row_after_issuance']['cert'], 'name': r['public_row_after_issuance']['card_name'],
                                'point_usd': r['public_row_after_issuance']['point_usd'],
                                'asks_used': r['public_row_after_issuance']['prices_used']} for r in records]}))


if __name__ == '__main__':
    main()
