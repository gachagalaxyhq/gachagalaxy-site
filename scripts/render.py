"""data/cc.json + src/*.tpl.html -> public/index.html, public/platform.html (Collector Crypt only)."""
import json, html, os, datetime as dt, shutil
R = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
cc = json.load(open(f"{R}/data/cc.json")); certs = json.load(open(f"{R}/src/certs.json"))
EXP = "https://explorer.testnet.chain.robinhood.com/address/0x30dfBCA3978CE186e6107A93cedC7d2971d30950"
upd = dt.datetime.strptime(cc["updated"], "%Y-%m-%dT%H:%M:%SZ").strftime("%-d %b %Y, %H:%M UTC")
hist = {}
hp = f"{R}/data/history.json"
if os.path.exists(hp): hist = json.load(open(hp))

import re as _re
_UP = {"EX","GX","V","VMAX","VSTAR","SV","SIR","AR","SAR","IR","ETB","SWSH","TG","PSA","CGC","151","II","III","UR","HR","SR","CHR"}
def clean_name(n):
    n = (n or "").strip()
    fa = False
    m = _re.match(r"(?i)full art\s*/\s*(.+)", n)
    if m: n, fa = m.group(1).strip(), True
    if n.isupper():
        n = " ".join(w if w.upper() in _UP else "-".join(x[:1] + x[1:].lower() for x in w.split("-")) for w in n.split())
    n = _re.sub(r"\b(Vmax|Vstar)\b", lambda m: m.group(1).upper(), n)
    n = _re.sub(r"\s+", " ", n)
    return n + (" (Full Art)" if fa else "")
cards = []
for k, c in enumerate(cc["cards"], 1):
    key = f"{c['set']}|{c['no']}|{c['grade']}"
    L = [["Collector Crypt", c["grade"], l["ask"], c["point"], l["gap"]] for l in c["listings"]]
    H = hist.get(key) or [[cc["updated"][:10], c["point"], None]]
    cards.append(dict(i=k, n=clean_name(c["name"]), s=c["set"], no=c["no"], cn=clean_name(c["name"]), cl=f"{c['set']} · #{c['no']}",
        la=c["low_ask"], se=True, f=c["featured"], lp="Collector Crypt", g=c["grade"], ga=c["point"], gn=c["n"],
        u=None, im=(f"https://gachagalaxy-site.pages.dev/cards/{c['id']}.webp" if os.path.exists(f"{R}/public/cards/{c['id']}.webp") else c["img"]), pv=[dict(grade=c["grade"], low=c["low"], point=c["point"], high=c["high"],
        confidence=c["confidence"], tier=c["tier"], prices_used=c["prices_used"], eligible=True)], L=L, H=H))
cards.sort(key=lambda x: (not x["f"], -x["ga"]))
df = cards[0]["i"]
D = dict(df=df, cards=cards, certs=certs, exp=EXP, markets=["Collector Crypt"])
os.makedirs(f"{R}/public", exist_ok=True)
p = open(f"{R}/src/platform.tpl.html", encoding="utf-8").read()
p = p.replace("__CC_DATA__", json.dumps(D, separators=(",", ":"))).replace("__UPDATED__", upd)
open(f"{R}/public/platform.html", "w", encoding="utf-8").write(p)
# scanner: one row per card, gap < 300%, asks >= $20, grade 8+, 10 below then 10 above
rows = []
for c in cards:
    try: gnum = float(c["g"].split()[1])
    except: continue
    if gnum < 8: continue
    for l in c["L"]:
        if l[4] is None or l[2] < 20 or abs(l[4]) >= 300 or l[4] == 0: continue
        rows.append((l[4], c, l))
best = {}
for g, c, l in rows:
    if c["i"] not in best or abs(g) > abs(best[c["i"]][0]): best[c["i"]] = (g, c, l)
below = sorted([v for v in best.values() if v[0] < 0], key=lambda v: v[0])[:10]
above = sorted([v for v in best.values() if v[0] > 0], key=lambda v: -v[0])[:10]
e = html.escape
def tr(g, c, l):
    cls, lab = ("down", "Below value") if g < 0 else ("up", "Above value")
    return (f'<tr><td><a class="sc-card" href="platform.html#/card/{c["i"]}">{e(c["cn"])}</a><span class="sc-set">{e(c["cl"])}</span>'
            f'<span class="sc-set mob">Collector Crypt · {e(c["g"])}</span></td><td>Collector Crypt<span class="sc-set">{e(c["g"])}</span></td>'
            f'<td class="num r nw">${l[2]:,.2f}</td><td class="num r nw hm">${c["ga"]:,.2f}</td>'
            f'<td class="num r nw {cls}"><b>{"+" if g > 0 else ""}{g:.1f}%</b><span class="sc-set">{lab}</span></td></tr>')
h = open(f"{R}/src/index.tpl.html", encoding="utf-8").read()
h = h.replace("__SCAN_ROWS__", "".join(tr(*v) for v in below + above)).replace("__UPDATED__", upd)
h = h.replace("gg-platform-final.html", "platform.html")
open(f"{R}/public/index.html", "w", encoding="utf-8").write(h)
for f in ["og-image-new.png"]:
    if os.path.exists(f"{R}/{f}"): shutil.copy(f"{R}/{f}", f"{R}/public/{f}")
import re, hashlib, base64
os.makedirs(f"{R}/public/assets", exist_ok=True)
EXT = {"image/png":"png","image/jpeg":"jpg","image/gif":"gif","image/svg+xml":"svg","image/webp":"webp"}
def unin(m):
    mime, b = m.group(1), m.group(2)
    if mime not in EXT or len(b) < 2000: return m.group(0)
    raw = base64.b64decode(b); n = hashlib.sha1(raw).hexdigest()[:12] + "." + EXT[mime]
    fp = f"{R}/public/assets/{n}"
    if not os.path.exists(fp): open(fp, "wb").write(raw)
    return "https://gachagalaxy-site.pages.dev/assets/" + n
for f in ["index.html", "platform.html"]:
    fp = f"{R}/public/{f}"; t = open(fp, encoding="utf-8").read()
    t = re.sub(r"data:([a-z/+]+);base64,([A-Za-z0-9+/=]+)", unin, t)
    open(fp, "w", encoding="utf-8").write(t)
print("rendered cards", len(cards), "scanner", len(below), "below", len(above), "above", "updated", upd)
