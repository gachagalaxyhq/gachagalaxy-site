import test from 'node:test';import assert from 'node:assert';import {createRequire} from 'module';
const {ppMedian,ppMarketPrice,ppRoute,ppPassport}=createRequire(import.meta.url)('../src/passport.js');
/* ALL NUMBERS BELOW ARE MADE-UP TEST FIXTURES. They are not real fees, duties, taxes, FX or sales. */
const NOW=Date.parse('2026-10-26T00:00:00Z');
const card={cardKey:'fixture-card-1',grader:'PSA',grade:'10',lang:'JP'};
const s=(market,currency,price,daysAgo,over)=>({market,currency,price,date:new Date(NOW-daysAgo*864e5).toISOString(),grader:'PSA',grade:'10',lang:'JP',cardKey:'fixture-card-1',...over});
const JP=[s('JP','JPY',30000,5),s('JP','JPY',32000,10),s('JP','JPY',31000,20),s('JP','JPY',90000,200)];
const US=[s('US','USD',300,3),s('US','USD',320,8),s('US','USD',310,15),s('US','USD',305,30,{grade:'9'}),s('US','USD',900,4,{lang:'EN'})];
const RATES={fx:{'JPY>USD':{rate:0.01,asOf:'fixture',verified:false},'USD>JPY':{rate:100,asOf:'fixture',verified:false}},
 routes:{'JP>US':{sellFeePct:.1,payFeePct:.03,shipping:20,shippingCcy:'USD',dutyPct:0,taxPct:0,deMinimis:null,verified:false},
         'US>JP':{sellFeePct:.08,payFeePct:.02,shipping:3000,shippingCcy:'JPY',dutyPct:0,taxPct:.1,deMinimis:10000,deMinimisCcy:'JPY',verified:false}}};
test('median',()=>{assert.equal(ppMedian([3,1,2]),2);assert.equal(ppMedian([1,2,3,4]),2.5);assert.equal(ppMedian([]),null)});
test('market price uses only same grade, same language, inside window',()=>{
 const u=ppMarketPrice(US,card,NOW);assert.equal(u.ok,true);assert.equal(u.n,3);assert.equal(u.median,310);assert.equal(u.otherLang,1);
 const j=ppMarketPrice(JP,card,NOW);assert.equal(j.n,3);assert.equal(j.median,31000)});
test('too few sales is refused, not guessed',()=>{const r=ppMarketPrice(US.slice(0,2),card,NOW);assert.equal(r.ok,false);assert.equal(r.reason,'too_few_sales')});
test('mixed currency is refused',()=>{const r=ppMarketPrice([...US.slice(0,3),s('US','JPY',30000,2)],card,NOW);assert.equal(r.reason,'mixed_currency')});
test('JP to US route maths',()=>{const r=ppRoute({market:'JP',currency:'JPY',median:31000},{market:'US',currency:'USD',median:310},RATES);
 assert.equal(r.ok,true);assert.equal(r.landed,330);assert.equal(r.net,269.7);assert.equal(r.margin,-60.3);assert.equal(r.verified,false)});
test('US to JP route applies tax above the threshold, skips below',()=>{
 const hi=ppRoute({market:'US',currency:'USD',median:310},{market:'JP',currency:'JPY',median:31000},RATES);
 assert.equal(hi.lines.find(l=>l[0]==='Import tax')[1],3100);assert.equal(hi.deMinimisApplied,false);
 const lo=ppRoute({market:'US',currency:'USD',median:50},{market:'JP',currency:'JPY',median:6000},RATES);
 assert.equal(lo.lines.find(l=>l[0]==='Import tax')[1],0);assert.equal(lo.deMinimisApplied,true)});
test('missing rate makes it incomplete and names the gap',()=>{const R={...RATES,routes:{'JP>US':{...RATES.routes['JP>US'],dutyPct:null}}};
 const r=ppRoute({market:'JP',currency:'JPY',median:31000},{market:'US',currency:'USD',median:310},R);assert.equal(r.ok,false);assert.deepEqual(r.missing,['dutyPct'])});
test('passport status is unverified while rates are placeholders',()=>{const p=ppPassport(card,JP,US,RATES,NOW);assert.equal(p.status,'unverified_rates');assert.equal(p.routes.length,2)});
test('passport refuses when one side has no sales',()=>{const p=ppPassport(card,JP,[],RATES,NOW);assert.equal(p.status,'insufficient_sales')});
