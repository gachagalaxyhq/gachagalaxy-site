"""Download each card image once, shrink to 360px webp, save in public/cards/<id>.webp. Skips ones we already have."""
import json, os, io, sys, urllib.request
from PIL import Image
R = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
D = f"{R}/public/cards"; os.makedirs(D, exist_ok=True)
cards = json.load(open(f"{R}/data/cc.json"))["cards"]
new = fail = 0
for c in cards:
    if not c.get("img"): continue
    p = f"{D}/{c['id']}.webp"
    if os.path.exists(p): continue
    try:
        req = urllib.request.Request(c["img"], headers={"User-Agent": "Mozilla/5.0 (GachaGalaxy price feed)"})
        im = Image.open(io.BytesIO(urllib.request.urlopen(req, timeout=30).read())).convert("RGB")
        im.thumbnail((360, 504)); im.save(p, "WEBP", quality=78); new += 1
    except Exception as e:
        fail += 1; print("img fail", c["id"], e, file=sys.stderr)
keep = {f"{c['id']}.webp" for c in cards}
for f in os.listdir(D):
    if f not in keep: os.remove(f"{D}/{f}")
print("images new", new, "failed", fail, "total", len(os.listdir(D)))
