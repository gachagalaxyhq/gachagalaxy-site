"""Select decoded matching PSA evidence, then reuse the saved-source preparation recipe."""
import importlib.util
import json
from pathlib import Path
import re
import sqlite3

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('prep',ROOT/'scripts/prepare_additional_marks.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
source=json.loads((ROOT/'data/cc.json').read_text())
existing={str(x['cert']) for x in json.loads((ROOT/'src/certs.json').read_text())}
assert len(existing)==12
db=sqlite3.connect('file:/tmp/opencode/cc_catalogue_audit_by_id/audit.sqlite?mode=ro',uri=True)
db.row_factory=sqlite3.Row
candidates=[]
for row in db.execute('''SELECT l.cert,l.raw,l.back_url,r.data FROM listings l JOIN results r
 ON l.id=r.listing_id WHERE l.company='PSA' AND r.qr_status='match' AND r.comparison='match' ORDER BY l.cert'''):
    cert=row['cert']
    if cert in existing or any(c['cert']==cert for c in candidates):continue
    raw=json.loads(row['raw']);ev=json.loads(row['data']);ob=ev.get('observation',{});qr=ev.get('qr',{})
    if not(ob.get('status')=='decoded' and ob.get('download_succeeded') and ob.get('sha256')
           and qr.get('qr_cert')==cert and not qr.get('signals')
           and ob.get('qr_text')=='https://www.psacard.com/cert/'+cert+'/'):continue
    groups=[g for g in source['cards'] if g['grade'].startswith('PSA ') and any(str(l['cert'])==cert for l in g['listings'])]
    if len(groups)!=1:continue
    g=groups[0]
    serial=str(raw.get('serial','')).split('/')[0].lstrip('0')
    gm=re.search(r'(\d+(?:\.\d+)?)\s*$',raw.get('grade',''))
    grade=str(raw['gradeNum']) if raw.get('gradeNum') is not None else gm.group(1) if gm else ''
    if (raw.get('set'),serial,format(float(grade),'g') if grade else '')!=(g['set'],g['no'],g['grade'].split(' ')[1]):continue
    grouped={}
    for l in g['listings']:
        other=str(l.get('cert') or '')
        if other!=cert and re.fullmatch('[0-9]{6,12}',other):grouped.setdefault(other,[]).append(l)
    try:
        prices=[m.cents(items[0]['ask']) for items in grouped.values() if len({m.cents(x['ask']) for x in items})==1]
    except ValueError:
        continue
    if len(prices)<4:continue
    app=m.appraisal(prices)
    if app['prices_used']<4 or app['low']<=0:continue
    candidates.append({'cert':cert,'name':g['name'],'group':(g['set'],g['no'],g['grade']),
                       'asks':app['prices_used'],'score':app['confidence'],'qr':'decoded_literal_match'})
candidates.sort(key=lambda c:(-c['asks'],-c['score'],c['cert']))
selected=[];groups=set()
for c in candidates:
    if c['group'] in groups:continue
    groups.add(c['group']);selected.append(c)
    if len(selected)==6:break
assert len(selected)==6
print(json.dumps({'selected':selected,'candidate_count':len(candidates)},indent=2))
# Copy the established preparation source, changing only batch scope and output.
text=(ROOT/'scripts/prepare_additional_marks.py').read_text()
text=text.replace("OUT = ROOT / 'data/additional-mark-preparation.json'","OUT = ROOT / 'data/marks-to-18-preparation.json'")
text=re.sub(r'^TARGET = .*$', 'TARGET = '+repr(tuple(c['cert'] for c in selected)),text,flags=re.M)
text=text.replace('assert len(existing) == 6 and','assert len(existing) == 12 and')
dest=ROOT/'scripts/prepare_marks_to_18_source.py'
dest.write_text(text)
spec=importlib.util.spec_from_file_location('prep18',dest)
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);module.main()
