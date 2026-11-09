"""Index only the six receipt-confirmed Marks. No network, render, deployment or DB writes."""
import copy
import hashlib
import io
import json
from pathlib import Path
import qrcode
import qrcode.image.svg

ROOT = Path(__file__).resolve().parents[1]
def load(p):
    return json.loads((ROOT/p).read_text())
def save(p, value):
    path = ROOT/p
    temp = path.with_suffix(path.suffix+'.tmp')
    temp.write_text(json.dumps(value, indent=1, ensure_ascii=False)+'\n')
    temp.replace(path)

batch = load('data/additional-mark-preparation.json')
journal = load('operations/additional-marks-receipts.json')
assert journal['confirmed_count'] == 6
assert journal['prepared_sha256'] == hashlib.sha256((ROOT/'data/additional-mark-preparation.json').read_bytes()).hexdigest()
certs, onchain = load('src/certs.json'), load('src/onchain.json')
original_certs, original_events = copy.deepcopy(certs), copy.deepcopy(onchain['events'])
assert len(certs) == len(onchain['events']) == 6
for rel in ('src/certs.json', 'src/onchain.json'):
    data = (ROOT/rel).read_bytes()
    assert hashlib.sha256(data).hexdigest() == batch['inputs_sha256'][rel]
    dest = ROOT/'operations'/('pre-issuance-'+Path(rel).name)
    assert not dest.exists()
    dest.write_bytes(data)
disclosure = ('Robinhood Chain testnet (46630). Saved Collector Crypt marketplace asks observed '
              '2026-11-06T06:57:12Z; not live prices or comparable sales. Slab QR certificate '
              'comparison only, not authentication. Ownership and custody not checked. '
              'Collateral eligibility not assessed; eligible=false and LTV=0.')
handoff = {'actual_issued_count': 6, 'total_saved_marks': 12, 'chain_id': 46630,
           'registry': journal['registry'], 'attester': journal['attester'],
           'deployed': False, 'database_written': False, 'disclosure': disclosure,
           'total_actual_fee_wei': journal['total_actual_fee_wei'], 'records': []}
for record in batch['records']:
    row = record['public_row_after_issuance']
    cert = row['cert']
    receipt = next(x for x in journal['transactions'] if x['identity'] == record['identity'])
    assert receipt['status'] == 'confirmed' and receipt['receipt']['status'] == 1
    assert receipt['evidence_sha256'] == record['evidence_sha256']
    event = {'t': receipt['published_at'], 'low': row['low_usd'], 'point': row['point_usd'],
             'high': row['high_usd'], 'tx': receipt['tx'], 'explorer': batch['chain']['explorer'],
             'registry': journal['registry'], 'chainId': 46630, 'block': receipt['block'],
             'block_hash': receipt['block_hash']}
    assert cert not in onchain['events'] and not any(c['cert'] == cert for c in certs)
    # Established saved Mark route; parent handles deployment/routing separately.
    url = 'https://gachagalaxy.io/platform?saved=1#/cert/'+cert
    stream = io.BytesIO()
    qrcode.make(url, image_factory=qrcode.image.svg.SvgPathImage).save(stream)
    qr = stream.getvalue().decode()
    image = record['front_image']
    mime = {'WEBP': 'image/webp', 'JPEG': 'image/jpeg', 'PNG': 'image/png'}[image['format']]
    item = {'cert': cert, 'name': row['card_name'], 'num': '#'+row['card_no'],
            'set': row['set_name'], 'year': row['year'], 'grader': row['grader'],
            'grade': row['grade'], 'gradeLabel': row['grade_label'],
            'low': row['low_usd'], 'point': row['point_usd'], 'high': row['high_usd'],
            'conf': row['confidence'], 'prices': row['prices_used'],
            'img': 'data:'+mime+';base64,'+image['base64'], 'qr': qr,
            'price_basis': 'asks', 'ev': [event], 'network': 'robinhood-testnet',
            'source': record['source'], 'source_observed_at': record['source']['pricing_observed_at'],
            'saved_source': True, 'not_live': True, 'disclosure': disclosure,
            'checks': record['checks'], 'evidence_sha256': record['evidence_sha256'],
            'eligible': False, 'ltvBps': 0}
    item['checks'] = {**record['checks'], 'public_mark_qr': 'generated_after_confirmed_issuance'}
    certs.append(item)
    onchain['events'][cert] = [event]
    markrow = {**row, 'qr_svg': qr, 'visible': True}
    dbevent = {'grader': 'PSA', 'cert': cert, 'published_at': receipt['published_at'],
               'low_usd': row['low_usd'], 'point_usd': row['point_usd'], 'high_usd': row['high_usd'],
               'chain_id': 46630, 'registry': journal['registry'], 'tx': receipt['tx'],
               'explorer': batch['chain']['explorer']}
    handoff['records'].append({'identity': record['identity'], 'mark': markrow, 'mark_event': dbevent,
        'receipt': receipt, 'source': record['source'], 'price_evidence': record['price_evidence'],
        'slab_qr_evidence': record['slab_qr_evidence'], 'evidence_sha256': record['evidence_sha256'],
        'checks': item['checks'], 'disclosure': disclosure})
assert certs[:6] == original_certs
assert all(onchain['events'][k] == v for k,v in original_events.items())
assert len(certs) == len(onchain['events']) == 12
save('src/certs.json', certs)
save('src/onchain.json', onchain)
save('operations/additional-marks-publication-ready.json', handoff)
# Re-open the written indexes and verify preservation and every new receipt link.
written, chain = load('src/certs.json'), load('src/onchain.json')
assert written[:6] == original_certs
assert all(chain['events'][k] == v for k,v in original_events.items())
assert len(written) == len(chain['events']) == 12
for r in handoff['records']:
    c = next(c for c in written if 'PSA:'+c['cert'] == r['identity'])
    assert c['ev'][0]['tx'] == r['receipt']['tx'] == chain['events'][c['cert']][0]['tx']
    assert c['not_live'] and c['saved_source'] and c['network'] == 'robinhood-testnet'
    assert c['eligible'] is False and c['ltvBps'] == 0
print(json.dumps({'new_issued': 6, 'indexed_total': 12, 'old_six_preserved': True,
    'deployed': False, 'database_written': False, 'files': ['src/certs.json','src/onchain.json',
    'operations/additional-marks-publication-ready.json']}))
