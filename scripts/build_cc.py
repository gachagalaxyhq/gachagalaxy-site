"""raw_cc.json -> data/cc.json. Card rule + Gacha Mark price maths (same as preview.py / build_seed.py).
Keeps last good file if the new result looks bad."""
import json, re, sys, os, collections, datetime as dt
RAW, OUT = sys.argv[1], sys.argv[2]
MaxDevBps=6000; ConfReal=70; ConfModest=40; MinComps=3; KEEP=250
def med(v):
    s=sorted(v); n=len(s); m=n//2; return s[m] if n%2 else (s[m-1]+s[m])//2
def conf(n,spread):
    base=60 if n>=10 else 45 if n>=5 else 30 if n>=3 else 15 if n>=1 else 0
    s=base+40-min(spread*40//6000,40)
    if n<2 and s>ConfModest-1: s=ConfModest-1
    elif n<3 and s>ConfReal-1: s=ConfReal-1
    return max(0,min(100,s))
def appraise(cents):
    m=med(cents); kept=[p for p in cents if (0 if m==0 else abs(p-m)*10000//m)<=MaxDevBps] or cents
    pt=med(kept); spread=0 if pt==0 else (max(kept)-min(kept))*10000//pt; half=pt*(spread//2)//10000
    sc=conf(len(kept),spread)
    return dict(low=round(max(pt-half,0)/100,2),point=round(pt/100,2),high=round((pt+half)/100,2),confidence=sc,
                tier="High" if sc>=ConfReal else "Medium" if sc>=ConfModest else "Low",prices_used=len(kept))
def comp(x):
    c=(x.get('gradingCompany') or '').upper()
    return 'CGC' if c.startswith('CGC') else 'PSA' if c=='PSA' else None
def gnum(x):
    g=x.get('gradeNum')
    if g is not None: return ('%g'%float(g))
    m=re.search(r'(\d+(?:\.\d)?)\s*$',x.get('grade') or ''); return m.group(1) if m else None
def cname(t):
    t=re.sub(r'^\d{4}\s+','',t or ''); t=re.sub(r'^(Pokemon\s+)?','',t)
    t=re.split(r'\s+(PSA|CGC)\b',t)[0]; t=re.sub(r'^#\S+\s+','',t)
    return t.strip()[:80]
raw=json.load(open(RAW)); now=dt.datetime.now(dt.timezone.utc)
groups=collections.defaultdict(list)
for x in raw:
    try: p=float(x.get('price') or 0)
    except: continue
    if x.get('currency') not in('USDC','USDG') or not(10<=p<=50000): continue
    c,g=comp(x),gnum(x); s=(x.get('serial') or '').split('/')[0].lstrip('0')
    if not(c and g and x.get('set') and s): continue
    groups[(x['set'],s,c,g)].append(x)
cards=[]
for (st,no,c,g),v in groups.items():
    if len(v)<MinComps: continue
    pv=appraise([int(round(float(x['price'])*100)) for x in v])
    v.sort(key=lambda x:float(x['price']))
    last=max(x['listedAt'] for x in v if x.get('listedAt'))
    img=next((x['img'] for x in v if x.get('img')),None)
    cards.append(dict(id=v[0]['id'],name=cname(v[0]['itemName']),set=st,no=no,grade=f"{c} {g}",
        low_ask=float(v[0]['price']),n=len(v),img=img,last_listed=last,**pv,
        listings=[dict(id=x['id'],ask=float(x['price']),cert=x.get('gradingID'),listed=x.get('listedAt'),
                       gap=round((float(x['price'])-pv['point'])/pv['point']*100,1) if pv['point'] else None) for x in v]))
cards.sort(key=lambda c:(-c['n'],-c['point'])); cards=cards[:KEEP]
wk=(now-dt.timedelta(days=7)).isoformat()
feat=[c for c in cards if c['img'] and c['confidence']>=40 and 50<=c['point']<=50000]
feat=sorted(feat,key=lambda c:-c['point'])[:8]
for c in cards: c['featured']=c in feat
out=dict(source="Collector Crypt",updated=now.strftime('%Y-%m-%dT%H:%M:%SZ'),listings_read=len(raw),cards=cards)
# sanity: keep last good file if result looks bad
bad=len(cards)<100 or any(not isinstance(c['point'],(int,float)) or c['point']<=0 for c in cards)
if bad and os.path.exists(OUT): print("BAD RESULT, kept last good file", len(cards)); sys.exit(0)
json.dump(out,open(OUT,'w'),separators=(',',':'))
print("cards",len(cards),"featured",len(feat),"bytes",os.path.getsize(OUT))
for c in feat: print(f"  {c['name'][:40]:40} | {c['grade']:7} | ${c['point']:>8,.2f} | {c['n']} listings | conf {c['confidence']} {c['tier']}")
