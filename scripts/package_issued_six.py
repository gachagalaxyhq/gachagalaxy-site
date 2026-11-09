"""Verify indexed preservation and package only explicitly allowlisted public evidence."""
import hashlib
import json
from pathlib import Path
import zipfile
ROOT=Path(__file__).resolve().parents[1]
load=lambda p:json.loads((ROOT/p).read_text())
b=load('data/additional-mark-preparation.json')
j=load('operations/additional-marks-receipts.json')
c=load('src/certs.json');o=load('src/onchain.json')
oldc=load('operations/pre-issuance-certs.json');oldo=load('operations/pre-issuance-onchain.json')
h=load('operations/additional-marks-publication-ready.json')
assert len(c)==len(o['events'])==12 and c[:6]==oldc
assert all(o['events'][k]==v for k,v in oldo['events'].items())
assert j['confirmed_count']==len(h['records'])==6
assert len({t['tx'] for t in j['transactions']})==6
for r in h['records']:
    t=r['receipt'];cert=r['mark']['cert']
    assert t['status']=='confirmed' and t['receipt']['status']==1
    assert t['event']['cert']==cert and t['event']['attester']==j['attester']
    assert o['events'][cert][0]['tx']==t['tx']
    assert r['mark']['network']=='robinhood-testnet' and r['mark']['price_basis']=='asks'
    assert r['price_evidence']['not_live'] and r['price_evidence']['not_sales']
    assert r['checks']['authentication']=='not_determined'
files=['src/certs.json','src/onchain.json','data/additional-mark-preparation.json',
       'operations/additional-marks-receipts.json','operations/additional-marks-preflight.json',
       'operations/additional-marks-publication-ready.json','operations/pre-issuance-certs.json',
       'operations/pre-issuance-onchain.json','scripts/index_issued_six.py','scripts/package_issued_six.py']
report={'actual_issued_count':6,'indexed_total':12,'old_six_preserved':True,'testnet_chain_id':46630,
        'transactions':[{k:t[k] for k in ['identity','tx','block','published_at','status']} for t in j['transactions']],
        'total_fee_wei':j['total_actual_fee_wei'],'database_written':False,'deployed':False,
        'committed':False,'pushed':False,'prepared_evidence_unchanged':True,
        'changed_existing_files':['src/certs.json','src/onchain.json'],
        'new_files':[p for p in files if p not in ['src/certs.json','src/onchain.json','data/additional-mark-preparation.json']]+['operations/additional-marks-execution-report.json','/tmp/opencode/pub/issue_prepared_six.mjs'],
        'parent_handoff':'Local source indexes updated. Public files, database import, UI cleanup, routing and deployment remain with parent. Original preparation intentionally retained unchanged; receipts and publication-ready data are authoritative for issuance.'}
(ROOT/'operations/additional-marks-execution-report.json').write_text(json.dumps(report,indent=2)+'\n')
files.append('operations/additional-marks-execution-report.json')
dest=Path('/home/user/output/additional-marks-issued.zip')
with zipfile.ZipFile(dest,'w',zipfile.ZIP_DEFLATED) as z:
    for path in files:z.write(ROOT/path,path)
    z.write('/tmp/opencode/pub/issue_prepared_six.mjs','executor/issue_prepared_six.mjs')
with zipfile.ZipFile(dest) as z:
    assert z.testzip() is None
    assert len(z.namelist())==len(files)+1
    assert not any(x in p.lower() for p in z.namelist() for x in ['keystore','gh-secrets','passphrase'])
    assert json.loads(z.read('src/certs.json'))==c
    assert json.loads(z.read('src/onchain.json'))==o
print(json.dumps(report,indent=2))
print(json.dumps({'archive':str(dest),'bytes':dest.stat().st_size,'sha256':hashlib.sha256(dest.read_bytes()).hexdigest()}))
