"""Append today's fair value per card+grade to data/history.json (kept 365 days)."""
import json, os
R = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
cc = json.load(open(f"{R}/data/cc.json")); hp = f"{R}/data/history.json"
h = json.load(open(hp)) if os.path.exists(hp) else {}
day = cc["updated"][:10]
for c in cc["cards"]:
    k = f"{c['set']}|{c['no']}|{c['grade']}"; s = h.setdefault(k, [])
    pt = [day, c["point"], None]
    if s and s[-1][0] == day: s[-1] = pt
    else: s.append(pt)
    h[k] = s[-365:]
json.dump(h, open(hp, "w"), separators=(",", ":"))
print("history keys", len(h))
