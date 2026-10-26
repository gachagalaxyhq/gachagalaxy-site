/* Price Passport engine: what the same graded card nets in one country vs another, sold vs sold.
   Pure functions, no network. Every fee, duty, tax and FX rate is an INPUT. Nothing is assumed:
   a missing or unverified rate makes the result "incomplete" instead of guessing. */
const PP_MIN_SALES=3;
const ppMedian=a=>{const s=[...a].sort((x,y)=>x-y),n=s.length;return n?(n%2?s[(n-1)/2]:(s[n/2-1]+s[n/2])/2):null};
function ppSame(a,b){return a.grader===b.grader&&String(a.grade)===String(b.grade)&&a.lang===b.lang&&a.cardKey===b.cardKey}
/* sales: [{market,currency,price,date,grader,grade,lang,cardKey}] for ONE market. Returns the median sold price
   inside the window, or a reason it cannot. */
function ppMarketPrice(sales,card,now,windowDays){windowDays=windowDays||90;const cut=now-windowDays*864e5;
 const ok=sales.filter(s=>ppSame(s,card)&&Date.parse(s.date)>=cut&&s.price>0);
 const other=sales.filter(s=>s.cardKey===card.cardKey&&s.lang!==card.lang).length;
 if(ok.length<PP_MIN_SALES)return {ok:false,reason:ok.length?'too_few_sales':'no_sales',n:ok.length,otherLang:other};
 const cur=[...new Set(ok.map(s=>s.currency))];if(cur.length>1)return {ok:false,reason:'mixed_currency',n:ok.length};
 return {ok:true,currency:cur[0],median:ppMedian(ok.map(s=>s.price)),n:ok.length,otherLang:other,sales:ok,from:ok.map(s=>s.date).sort()[0],to:ok.map(s=>s.date).sort().slice(-1)[0]}}
/* rates: {fx:{'JPY>USD':{rate,asOf,verified}}, routes:{'JP>US':{sellFeePct,payFeePct,shipping,shippingCcy,dutyPct,taxPct,deMinimis,deMinimisCcy,verified}}}
   Percentages as fractions (0.1 = 10%). */
function ppFx(rates,from,to){if(from===to)return {rate:1,verified:true};const r=rates.fx&&rates.fx[from+'>'+to];return r&&r.rate>0?r:null}
function ppRoute(buy,sell,rates,opt){opt=opt||{};const key=buy.market+'>'+sell.market;const R=rates.routes&&rates.routes[key];const miss=[];
 if(!R)return {ok:false,reason:'no_route',route:key};
 const ccy=sell.currency;const fx=ppFx(rates,buy.currency,ccy);if(!fx)miss.push('fx '+buy.currency+'>'+ccy);
 const shipFx=R.shippingCcy?ppFx(rates,R.shippingCcy,ccy):fx;if(R.shipping==null)miss.push('shipping');else if(!shipFx)miss.push('fx '+R.shippingCcy+'>'+ccy);
 ['sellFeePct','payFeePct','dutyPct','taxPct'].forEach(k=>{if(R[k]==null)miss.push(k)});
 if(miss.length)return {ok:false,reason:'missing_rates',missing:miss,route:key};
 const cost=buy.median*fx.rate;const ship=R.shipping*shipFx.rate;
 let dm=null;if(R.deMinimis!=null){const dfx=ppFx(rates,R.deMinimisCcy||ccy,ccy);dm=dfx?R.deMinimis*dfx.rate:null;if(!dfx)return {ok:false,reason:'missing_rates',missing:['fx '+R.deMinimisCcy+'>'+ccy],route:key}}
 const dutiable=dm!=null&&cost<=dm?0:cost;const duty=dutiable*R.dutyPct;const tax=dm!=null&&cost<=dm?0:(cost+duty+(opt.taxOnShipping?ship:0))*R.taxPct;
 const landed=cost+ship+duty+tax;const fees=sell.median*(R.sellFeePct+R.payFeePct);const net=sell.median-fees;
 const margin=net-landed;const verified=!!(R.verified&&fx.verified&&shipFx.verified);
 const r2=x=>Math.round(x*100)/100;
 return {ok:true,route:key,currency:ccy,verified,lines:[['Buy price',r2(cost)],['Shipping',r2(ship)],['Import duty',r2(duty)],['Import tax',r2(tax)],['Landed cost',r2(landed)],['Sell price',r2(sell.median)],['Selling fees',r2(-fees)],['Net from sale',r2(net)]],
  landed:r2(landed),net:r2(net),margin:r2(margin),marginPct:landed?Math.round(margin/landed*1000)/10:null,deMinimisApplied:dm!=null&&cost<=dm,fxAsOf:fx.asOf||null}}
/* Full passport for one card across two markets, both directions. */
function ppPassport(card,salesA,salesB,rates,now,opt){const a=ppMarketPrice(salesA,card,now,opt&&opt.windowDays),b=ppMarketPrice(salesB,card,now,opt&&opt.windowDays);
 const mA=salesA[0]&&salesA[0].market,mB=salesB[0]&&salesB[0].market;
 const out={card,markets:{[mA||'A']:a,[mB||'B']:b},routes:[]};
 if(!a.ok||!b.ok){out.status='insufficient_sales';return out}
 const A={...a,market:mA},B={...b,market:mB};out.routes=[ppRoute(A,B,rates,opt),ppRoute(B,A,rates,opt)];
 out.status=out.routes.every(r=>r.ok)?(out.routes.every(r=>r.verified)?'ok':'unverified_rates'):'incomplete';return out}
if(typeof module!=='undefined')module.exports={ppMedian,ppMarketPrice,ppRoute,ppPassport,PP_MIN_SALES};
