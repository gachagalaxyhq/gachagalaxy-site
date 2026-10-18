"""Runs in the 4-hourly refresh (and by hand): read every Gacha Mark publish event from the AppraisalRegistry on Robinhood Chain testnet
-> src/onchain.json  {cert: [{t, low, point, high, tx}, ...newest first]}. Prices in USD.
If the explorer fails or returns nothing, the last good file is kept and the script exits 0."""
import json, os, sys, urllib.request
R = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = "https://explorer.testnet.chain.robinhood.com"
# Current registry first (admin: Trust Wallet). The old 23 Sep registry is read too so its history stays visible.
ADDR = "0x2A585396dd0248A060045b3f557076fB1B4Cb0eb"
REGS = [ADDR, "0x30dfBCA3978CE186e6107A93cedC7d2971d30950"]
def get(u): return json.load(urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent": "Mozilla/5.0"}), timeout=30))
def fetch():
  out = {}
  for REG in REGS:
    url = f"{BASE}/api/v2/addresses/{REG}/logs"
    while url:
        d = get(url)
        for x in d["items"]:
            p = {q["name"]: q["value"] for q in (x.get("decoded") or {}).get("parameters", [])}
            if not p.get("certId"): continue
            t = get(f"{BASE}/api/v2/transactions/{x['transaction_hash']}")["timestamp"][:19] + "Z"
            out.setdefault(p["certId"], []).append(dict(t=t, low=int(p["fmvLow"]) / 100, point=int(p["fmvPoint"]) / 100,
                high=int(p["fmvHigh"]) / 100, tx=x["transaction_hash"]))
        n = d.get("next_page_params")
        url = f"{BASE}/api/v2/addresses/{REG}/logs?" + "&".join(f"{k}={v}" for k, v in n.items()) if n else None
  return out
try:
    out = fetch()
except Exception as e:
    print(f"Explorer read failed ({e}); keeping last good onchain.json"); sys.exit(0)
if not out:
    print("No events returned; keeping last good onchain.json"); sys.exit(0)
for v in out.values(): v.sort(key=lambda e: e["t"], reverse=True)
json.dump(dict(chain="Robinhood Chain testnet", explorer=BASE, registry=ADDR, events=out), open(f"{R}/src/onchain.json", "w"), indent=1)
print({k: len(v) for k, v in out.items()})
