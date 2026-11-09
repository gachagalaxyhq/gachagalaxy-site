import base64
import hashlib
import io
import json
from pathlib import Path
from PIL import Image, ImageDraw
from prepare_additional_marks import canonical,appraisal
ROOT=Path(__file__).resolve().parents[1]
b=json.loads((ROOT/'data/marks-to-18-preparation.json').read_text())
assert len(b['records'])==6 and len(b['existing_identities'])==12
canvas=Image.new('RGB',(6*280,510),'white')
for i,record in enumerate(b['records']):
    r=json.loads(json.dumps(record));expected=r.pop('evidence_sha256')
    for k in ('cert_key','unsigned_transaction'):r['contract_proposal'].pop(k,None)
    assert hashlib.sha256(canonical(r).encode()).hexdigest()==expected
    assert r['identity'] not in b['existing_identities']
    qr=r['slab_qr_evidence'];cert=r['public_row_after_issuance']['cert']
    assert qr['observation']['status']=='decoded' and qr['observation']['download_succeeded']
    assert qr['observation']['qr_text']=='https://www.psacard.com/cert/'+cert+'/'
    assert qr['comparison']['status']=='match' and qr['comparison']['qr_cert']==cert and not qr['comparison']['signals']
    calc=appraisal([c['ask_cents'] for c in r['price_evidence']['comparables']])
    assert calc==r['price_evidence']['calculation']
    assert len({c['cert'] for c in r['price_evidence']['comparables']})==len(r['price_evidence']['comparables'])
    assert cert not in {c['cert'] for c in r['price_evidence']['comparables']}
    assert calc['prices_used']>=4
    a=r['contract_proposal']['args']
    assert a==['PSA',cert,calc['low'],calc['point'],calc['high'],0,calc['confidence']*10,calc['prices_used'],3 if calc['confidence']>=70 else 2 if calc['confidence']>=40 else 1,0,False]
    image=r['front_image'];data=base64.b64decode(image['base64'],validate=True)
    assert hashlib.sha256(data).hexdigest()==image['sha256'] and len(data)==image['bytes']
    with Image.open(io.BytesIO(data)) as im:
        assert list(im.size)==image['dimensions'];im.verify()
    im=Image.open(io.BytesIO(data)).convert('RGB')
    im.save(ROOT/('operations/marks-to-18-front-'+cert+'.jpg'))
    im.thumbnail((270,465))
    canvas.paste(im,(i*280+(280-im.width)//2,30))
    ImageDraw.Draw(canvas).text((i*280+20,5),cert,fill='black')
canvas.save(ROOT/'operations/marks-to-18-source-image-review.jpg')
for path,h in b['inputs_sha256'].items():assert hashlib.sha256((ROOT/path).read_bytes()).hexdigest()==h,path
print(json.dumps({'evidence_hashes_valid':6,'literal_decoded_qr_matches':6,'valid_source_images':6,'pricing_recomputed':6,'distinct_new_identities':6}))
