"""Prepare only collector UI output; never runs scanners or refreshes source data."""
from pathlib import Path
import json
import re
from datetime import datetime
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
public = ROOT / 'public'
old = (public / 'platform.html').read_text()
payload, _ = json.JSONDecoder().raw_decode(old.split('const D=', 1)[1])
# Refresh only public Mark evidence, never rebuild the cleaned catalogue/copy.
payload['certs'] = json.loads((ROOT / 'src/certs.json').read_text())
payload['oc'] = json.loads((ROOT / 'src/onchain.json').read_text())
cc = json.loads((ROOT / 'data/cc.json').read_text())
# Prefer the checked-in image belonging to this exact catalogue row, not an
# older deployed host. Do not substitute another card when an asset is absent.
catalogue = {number: card for number, card in enumerate(cc['cards'], 1)}
def matching_image(card, source):
    """Use a readable bundled photo for this exact displayed source listing only."""
    if not source or (card['s'], str(card['no']), card['g']) != (source['set'], str(source['no']), source['grade']):
        return None
    listing = next((row for row in card['L'] if row[7] == source['id'] and row[6] is True), None)
    saved = next((row for row in source['listings'] if row['id'] == source['id']), None)
    if not listing or not saved or (listing[5] and listing[5] != saved.get('cert')):
        return None
    route = '/cards/' + source['id'] + '.webp'
    try:
        with Image.open(public / route.lstrip('/')) as image:
            image.load()
            if image.width < 100 or image.height < 100:
                return None
    except (OSError, ValueError):
        return None
    return route

for card in payload['cards']:
    source = catalogue.get(card['i'])
    if card.get('decoded'):
        card['im'] = matching_image(card, source)
    elif source:
        image = '/cards/' + source['id'] + '.webp'
        card['im'] = image if (public / image.lstrip('/')).is_file() else source.get('img')
for mark in payload['certs']:
    image = mark.get('img', '')
    prefix = 'https://gachagalaxy-site.pages.dev/assets/'
    if image.startswith(prefix):
        local = '/assets/' + image[len(prefix):]
        if (public / local.lstrip('/')).is_file():
            mark['img'] = local
# Match Passport photos to exact grader/cert AND recorded card identity.
# Only existing decoded catalogue rows may supply a photo; source files stay untouched.
passport_rows = {}
for file in (public / 'data/cc').glob('*.json'):
    entries = json.loads(file.read_text())
    if not isinstance(entries, list):
        continue
    for row in entries:
        passport_rows.setdefault((row['grader'].upper(), row['cert']), []).append(row)
manifest = json.loads((public / 'data/catalogue/manifest.json').read_text())
selection = json.loads((public / 'data/catalogue/decoded.json').read_text())
allowed = {}
for shard, offset in selection['refs']:
    allowed.setdefault(shard, set()).add(offset)
payload['passportImages'] = {}
for shard, offsets in allowed.items():
    rows = json.loads((public / manifest['base_url'].lstrip('/') / manifest['shards'][shard]['file']).read_text())
    for offset in offsets:
        row = rows[offset]
        key = (row['grader'], row['cert'])
        if not row.get('image') or not any(old['name'] == row['name'] and old['grade'] == row['grade'] for old in passport_rows.get(key, [])):
            continue
        payload['passportImages'].setdefault('|'.join(key), {'image': row['image'], 'name': row['name'], 'grade': row['grade'], 'number': row['number']})
# Public evidence comes only from bundled public Mark records. Never publish
# collection user IDs or request/contact data as part of this saved demo feed.
marks = json.loads((ROOT / 'src/certs.json').read_text())
claims = []
for mark in marks:
    events = mark.get('ev') or []
    latest = max(events, key=lambda event: event['t']) if events else None
    claims.append({'source': 'mark', 'grader': mark.get('grader', 'PSA'),
                   'cert': mark['cert'], 'owner': 'Gacha Galaxy (marked)',
                   'card': ' '.join(filter(None, [mark.get('name'), mark.get('num')])),
                   'grade': mark.get('grade'),
                   'chain': 'Robinhood Chain testnet' if latest and latest.get('chainId') == 46630 else '',
                   'when': latest['t'] if latest else ''})
(public / 'data/own-claims.json').write_text(json.dumps(claims, separators=(',', ':')))
evidence = {'observed_at': cc['updated'], 'source': 'Collector Crypt', 'cards': {}}
for number, card in enumerate(cc['cards'], 1):
    evidence['cards'][str(number)] = {key: card[key] for key in ('name', 'set', 'grade', 'point', 'listings')}
(public / 'data/collector-evidence.json').write_text(json.dumps(evidence, separators=(',', ':')))
page = (ROOT / 'src/platform.tpl.html').read_text()
page = page.replace('Prices from the Gacha Galaxy index, 8 marketplaces. Asking prices, not completed sales.',
                    '')
updated = datetime.strptime(cc['updated'], '%Y-%m-%dT%H:%M:%SZ').strftime('%-d %b %Y, %H:%M UTC')
page = page.replace('__CC_DATA__', json.dumps(payload, separators=(',', ':'))).replace('__UPDATED__', updated)
# Preserve the already-public browser configuration; never read environment or secrets.
for marker, variable in [('__SB_URL__', 'SB_URL'), ('__SB_KEY__', 'SB_KEY')]:
    value = re.search(variable + r"='([^']*)'", old).group(1)
    page = page.replace(marker, value)
for marker, name in [('__CATALOGUE_JS__', 'catalogue.js'), ('__CHAINCHECK_JS__', 'chaincheck.js'), ('__MARKPDF_JS__', 'markpdf.js'), ('__CARD_PASSPORT_JS__', 'card-passport.js')]:
    source = (ROOT / 'src' / name).read_text()
    source = re.sub(r"if\(typeof module!=='undefined'\)module\.exports=\{[^}]*\};?", '', source)
    page = page.replace(marker, source)
assert all(marker not in page for marker in ['__CC_DATA__', '__CATALOGUE_JS__', '__MARKPDF_JS__', '__CARD_PASSPORT_JS__'])
(public / 'platform.html').write_text(page)
print('Prepared collector UI, exact local image routes and public saved Mark evidence; source catalogue, Mark data and scanner outputs unchanged.')
