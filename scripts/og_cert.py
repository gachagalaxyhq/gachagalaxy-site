"""Build a 1200x630 share image per Gacha Mark certificate into public/og/<cert>.png.
Run: python3 scripts/og_cert.py   (deterministic, no network: images come from src/certs.json)"""
import base64, io, json, pathlib
from PIL import Image, ImageDraw, ImageFont

R = pathlib.Path(__file__).resolve().parent.parent
OUT = R / "public" / "og"
W, H = 1200, 630
BG = (7, 6, 13); TXT = (255, 255, 255); MUT = (201, 212, 226); DIM = (141, 151, 168)
PUR = (180, 77, 250); LINE = (60, 55, 84); PANEL = (16, 13, 28); GRN = (52, 211, 153)
F = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
FB = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
def font(sz, bold=False): return ImageFont.truetype(FB if bold else F, sz)
def track(d, xy, text, f, fill, sp=3):
    x, y = xy
    for ch in text:
        d.text((x, y), ch, font=f, fill=fill)
        x += d.textlength(ch, font=f) + sp
    return x
def money(v): return "$" + format(int(round(v)), ",")
def wrap(d, text, f, maxw):
    words, lines, cur = text.split(), [], ""
    for w in words:
        t = (cur + " " + w).strip()
        if d.textlength(t, font=f) <= maxw: cur = t
        else:
            if cur: lines.append(cur)
            cur = w
    if cur: lines.append(cur)
    return lines
def slab(src):
    if not src: return None
    try:
        raw = base64.b64decode(src.split(",", 1)[1]) if src.startswith("data:") else open(src, "rb").read()
        im = Image.open(io.BytesIO(raw)).convert("RGB")
    except Exception:
        return None
    box = (300, 440); s = min(box[0] / im.width, box[1] / im.height)
    im = im.resize((max(1, int(im.width * s)), max(1, int(im.height * s))), Image.LANCZOS)
    canvas = Image.new("RGB", box, (0, 0, 0)); canvas.paste(im, ((box[0] - im.width) // 2, (box[1] - im.height) // 2))
    return canvas
def build(c):
    im = Image.new("RGB", (W, H), BG); d = ImageDraw.Draw(im)
    for i in range(340):  # soft glow top-left
        a = int(26 * (1 - i / 340) ** 2)
        d.ellipse([-160 - i, -240 - i, 420 + i, 340 + i], fill=(BG[0] + a // 3, BG[1] + a // 6, BG[2] + a))
    d.rounded_rectangle([24, 24, W - 24, H - 24], 26, outline=LINE, width=2)
    d.rounded_rectangle([60, 95, 380, 555], 18, fill=PANEL, outline=LINE, width=2)
    s = slab(c.get("img")); 
    if s: im.paste(s, (70, 105))
    x = 420
    track(d, (x, 96), "GACHA MARK", font(19, True), PUR, 4)
    tf = font(58, True); tl = wrap(d, f'{c.get("name","")} {c.get("num","")}'.strip(), tf, W - x - 70)[:2]
    y = 132
    for ln in tl: d.text((x, y), ln, font=tf, fill=TXT); y += 66
    d.text((x, y + 6), f'{c.get("set","")} · {c.get("year","")}', font=font(25), fill=MUT); y += 52
    gp = f'{c.get("grade","")}' + (f' · {c["gradeLabel"]}' if c.get("gradeLabel") else "")
    gw = d.textlength(gp, font=font(20, True)) + 32
    d.rounded_rectangle([x, y, x + gw, y + 40], 20, fill=(30, 24, 48), outline=(70, 60, 100), width=1)
    d.text((x + 16, y + 9), gp, font=font(20, True), fill=MUT); y += 76
    d.text((x, y), "VALUE POINT", font=font(17, True), fill=DIM); y += 26
    d.text((x, y), money(c.get("point", 0)), font=font(62, True), fill=TXT); y += 78
    band = f'{money(c.get("low",0))} – {money(c.get("high",0))} band · confidence {c.get("conf","–")} / 100'
    d.text((x, y), band, font=font(20), fill=MUT); y += 40
    d.line([x, y + 8, W - 70, y + 8], fill=LINE, width=1)
    cy = min(y + 26, H - 104)  # keep clear of the footer line whatever the value text length
    d.text((x, cy), f'Checked against the onchain registry · gachagalaxy.io/verify/{c.get("grader","PSA")}/{c.get("cert","")}', font=font(17), fill=DIM)
    assert cy + 22 < H - 70, (c["cert"], cy)
    d.ellipse([62, H - 62, 76, H - 48], fill=GRN)
    d.text((84, H - 66), "Gacha Galaxy · asking prices, not completed sales", font=font(16), fill=DIM)
    return im
def main():
    OUT.mkdir(parents=True, exist_ok=True)
    certs = json.load(open(R / "src/certs.json"))
    for c in certs:
        im = build(c); p = OUT / f'{c["cert"]}.png'; im.save(p, optimize=True)
        print(p.relative_to(R), im.size, p.stat().st_size // 1024, "KB")
main()
