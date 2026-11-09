"""Final decoded-only constraint check and allowlisted evidence archive."""
import hashlib
import json
from pathlib import Path
import zipfile
ROOT=Path(__file__).resolve().parents[1]
load=lambda p:json.loads((ROOT/p).read_text())
b=load('data/marks-to-18-preparation.json');j=load('operations/marks-to-18-receipts.json')
c=load('src/certs.json');o=load('src/onchain.json');h=load('operations/marks-to-18-publication-ready.json')
oldc=load('operations/pre-18-certs.json');oldo=load('operations/pre-18-onchain.json')
assert len(c)==len(o['events'])==18 and len(oldc)==12 and c[:12]==oldc
assert all(o['events'][k]==v for k,v in oldo['events'].items())
assert j['confirmed_count']==len(h['records'])==6
assert len({x['cert'] for x in c})==18
assert j['prepared_sha256']==hashlib.sha256((ROOT/'data/marks-to-18-preparation.json').read_bytes()).hexdigest()
for r in b['records']:
    cert=r['public_row_after_issuance']['cert'];q=r['slab_qr_evidence'];t=next(t for t in j['transactions'] if t['identity']==r['identity'])
    indexed=next(x for x in c if x['cert']==cert)
    assert q['observation']['status']=='decoded' and q['observation']['download_succeeded']
    assert q['comparison']['status']=='match' and q['comparison']['qr_cert']==cert
    assert q['observation']['qr_text']=='https://www.psacard.com/cert/'+cert+'/'
    assert indexed['qr_decode_status']=='decoded' and indexed['slab_qr_evidence']==q
    assert indexed['ev'][0]['tx']==o['events'][cert][0]['tx']==t['tx']
    assert t['status']=='confirmed' and t['receipt']['status']==1
    assert indexed['saved_source'] and indexed['not_live'] and indexed['price_basis']=='asks'
    assert indexed['network']=='robinhood-testnet' and indexed['ltvBps']==0 and indexed['eligible'] is False
report={'actual_total_marks':18,'new_issued':6,'old_twelve_preserved':True,
 'new_decoded_literal_qr_matches':6,'valid_saved_slab_images':6,'front_label_visual_matches':6,
 'chain_id':46630,'registry':j['registry'],'attester':j['attester'],
 'transactions':[{k:t[k] for k in ['identity','tx','block','published_at','status']} for t in j['transactions']],
 'actual_fee_wei':j['total_actual_fee_wei'],'shared_ui_changed':False,'deployed':False,
 'database_written':False,'committed':False,'pushed':False,
 'existing_updated':['src/certs.json','src/onchain.json'],
 'evidence_and_receipts':['data/marks-to-18-preparation.json','operations/marks-to-18-receipts.json',
 'operations/marks-to-18-preflight.json','operations/marks-to-18-publication-ready.json',
 'operations/pre-18-certs.json','operations/pre-18-onchain.json'],
 'parent_next_step':'Prepare/render/deploy existing updated source indexes and decoded-only catalogue through parent. No public files or routing changed by issuance executor.',
 'disclosure':h['disclosure']}
out='operations/marks-to-18-execution-report.json'
(ROOT/out).write_text(json.dumps(report,indent=2)+'\n')
files=report['existing_updated']+report['evidence_and_receipts']+[out,
 'scripts/prepare_marks_to_18.py','scripts/prepare_marks_to_18_source.py','scripts/configure_marks_to_18.py',
 'scripts/verify_marks_to_18_evidence.py','scripts/validate_marks_to_18.mjs','scripts/index_marks_to_18.py','scripts/package_marks_to_18.py']
dest=Path('/home/user/output/marks-total-18.zip')
with zipfile.ZipFile(dest,'w',zipfile.ZIP_DEFLATED) as z:
    for f in files:z.write(ROOT/f,f)
    z.write('/tmp/opencode/pub/issue_marks_to_18.mjs','executor/issue_marks_to_18.mjs')
with zipfile.ZipFile(dest) as z:
    assert z.testzip() is None and len(z.namelist())==len(files)+1
    assert json.loads(z.read('src/certs.json'))==c
    assert not any(term in f.lower() for f in z.namelist() for term in ['keystore','gh-secrets','passphrase'])
print(json.dumps(report,indent=2))
print(json.dumps({'archive':str(dest),'bytes':dest.stat().st_size}))
