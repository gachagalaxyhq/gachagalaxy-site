import json,re,pathlib
R=pathlib.Path(__file__).resolve().parent.parent
js=re.sub(r"if\(typeof module!=='undefined'\)module\.exports=\{[^}]*\};?","",(R/'src/passport.js').read_text())
now='2026-10-26T00:00:00Z'
def s(m,c,p,d,**o):
    import datetime;t=datetime.datetime(2026,10,26,tzinfo=datetime.timezone.utc)-datetime.timedelta(days=d)
    return {'market':m,'currency':c,'price':p,'date':t.isoformat(),'grader':'PSA','grade':'10','lang':'JP','cardKey':'fixture-card-1',**o}
FX={'now':0,'card':{'cardKey':'fixture-card-1','grader':'PSA','grade':'10','lang':'JP','title':'Fixture card, Japanese, PSA 10','subtitle':'Test card for layout only. Same graded card, sold in Japan vs sold in the United States, after fees, shipping, duty, tax and exchange rate.'},
 'jp':[s('JP','JPY',30000,5),s('JP','JPY',32000,10),s('JP','JPY',31000,20),s('JP','JPY',29500,41),s('JP','JPY',90000,200)],
 'us':[s('US','USD',300,3),s('US','USD',320,8),s('US','USD',310,15),s('US','USD',305,30,grade='9'),s('US','USD',900,4,lang='EN')],
 'rates':{'fx':{'JPY>USD':{'rate':0.01,'asOf':'fixture','verified':False},'USD>JPY':{'rate':100,'asOf':'fixture','verified':False}},
  'routes':{'JP>US':{'sellFeePct':.1,'payFeePct':.03,'shipping':20,'shippingCcy':'USD','dutyPct':0,'taxPct':0,'deMinimis':None,'verified':False},
            'US>JP':{'sellFeePct':.08,'payFeePct':.02,'shipping':3000,'shippingCcy':'JPY','dutyPct':0,'taxPct':.1,'deMinimis':10000,'deMinimisCcy':'JPY','verified':False}}}}
fx='const FX='+json.dumps(FX)+';FX.now=Date.parse("'+now+'");'
out=(R/'preview/passport.tpl.html').read_text().replace('__PASSPORT_JS__',js).replace('__FIXTURES__',fx)
p=pathlib.Path('/home/user/workspace/preview_out');p.mkdir(exist_ok=True);(p/'passport-preview.html').write_text(out);print(p/'passport-preview.html')
