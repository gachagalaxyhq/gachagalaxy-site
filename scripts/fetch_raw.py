"""Fetch all Collector Crypt Pokemon listings (compact) -> data/raw_cc.json"""
import json, time, urllib.request, urllib.parse, sys
BASE = "https://api.collectorcrypt.com/marketplace"
KEEP = ["id","itemName","category","grade","gradeNum","gradingCompany","gradingID","insuredValue",
        "listedAt","year","set","serial","frontImage","nftAddress","nftStatus","language"]
def get(params):
    url = BASE + "?" + urllib.parse.urlencode(params)
    for a in range(4):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (GachaGalaxy price feed)"})
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.load(r)
        except Exception as e:
            print("retry", a, e, file=sys.stderr); time.sleep(3 * (a + 1))
    raise RuntimeError("fetch failed")
out, cursor, pages = [], None, 0
while True:
    p = {"orderBy": "listedDateDesc", "step": 1000, "categories": "Pokemon"}
    if cursor: p["cursor"] = cursor
    d = get(p); rows = d.get("filterNFtCard") or []
    for x in rows:
        r = {k: x.get(k) for k in KEEP}
        lst = x.get("listing") or {}
        r["price"] = lst.get("price"); r["currency"] = lst.get("currency"); r["mkt"] = lst.get("marketplace")
        r["img"] = (x.get("images") or {}).get("frontM") or x.get("frontImage")
        out.append(r)
    pages += 1; cursor = d.get("nextCursor")
    if pages % 10 == 0: print("pages", pages, "rows", len(out), flush=True)
    if not rows or not cursor or len(rows) < 1000 or pages > 300: break
json.dump(out, open(sys.argv[1] if len(sys.argv) > 1 else "data/raw_cc.json", "w"))
print("done pages", pages, "rows", len(out))
