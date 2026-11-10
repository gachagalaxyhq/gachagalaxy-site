import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');
const page=read('public/platform.html');
const D=JSON.parse(page.split('const D=')[1].split(';const $=')[0]);
const shard=JSON.parse(read('public/data/cc/109.json'));
const listing=shard.find(c=>c.cert==='109863355'&&c.grader==='PSA');
// Saved ask and listed date move with each Collector Crypt refresh; derive expectations from the shard row.
const askText='$'+listing.ask.toLocaleString('en-US');
const listedText=new Date(listing.listed+'T00:00:00Z').toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric',timeZone:'UTC'});
async function render(rows=shard,ok=true,changeRoute=false){
 const view={innerHTML:''};
 const location={hash:'#/listing/PSA/109863355'};
 const context=vm.createContext({D,V:view,journeyCopy:()=>'',passportHandoff:()=>'',esc:s=>String(s??'').replace(/[<>&"]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c])),money:v=>v==null?'—':'$'+v.toLocaleString('en-US'),setTab(){},location,window:{scrollTo(){}},encodeURIComponent,fetch:async()=>{if(changeRoute){location.hash='#/card/7';view.innerHTML='New route content'}return {ok,json:async()=>rows}}});
  vm.runInContext(page.slice(page.indexOf('function detailDate('),page.indexOf('async function catalogueDetail(')),context);
  vm.runInContext(page.slice(page.indexOf('async function savedListing('),page.indexOf('async function collectorEvidence(')),context);
 await vm.runInContext('savedListing("PSA","109863355")',context);
 return view.innerHTML;
}
test('Nidoking saved detail does not borrow catalogue PSA 6 evidence',async()=>{
 assert.ok(listing.ask>0);assert.equal(listing.grade,'NM-MT+ 8.5');
 assert.equal(D.certs.some(c=>c.cert===listing.cert),false);
 const html=await render();
  for(const s of ['Nidoking-Holo 1st Edition PSA 8.5',askText,// Live savedListing copy (was 'Insufficient comparisons' / 'No second same-cert listing' / 'No Gacha Mark is available' / 'Grader lookup: not checked').
  'No exact card-and-grade comparison available','Matching listings','Recorded asking price, not a completed sale or valuation','Availability, grader status and physical authenticity have not been checked',listedText,'4xXyL7gFQs4oFm','source label, not authentication','Submitting a request does not collect payment or issue a Mark','/cleancheck?cert=109863355&amp;grader=PSA'])assert.ok(html.includes(s),s);
 assert.doesNotMatch(html,/PSA 6|\$50|fair value of|109308847/);
});
test('saved detail fails visibly on missing, malformed or unavailable evidence',async()=>{
 for(const [rows,ok] of [[[],true],[null,true],[[null],true],[shard,false]]){
  const html=await render(rows,ok);assert.match(html,/No matching saved listing|Saved listing evidence unavailable/);assert.ok(!html.includes(askText));
 }
});
test('source markup remains escaped in saved detail',async()=>{
 const html=await render([{...listing,name:'<img src=x onerror=alert(1)>',status:'<script>bad</script>'}]);
 assert.doesNotMatch(html,/<img|<script>/);assert.match(html,/&lt;img/);
});
test('stale saved-listing response cannot overwrite a new route',async()=>{
 const html=await render(shard,true,true);
 assert.equal(html,'New route content');
});
test('intake and payment gates never access storage even with activation configured',async()=>{
 const original=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw new Error('forbidden transport')};
 try{
  const api=await import('data:text/javascript;base64,'+Buffer.from(read('functions/api/mark-request.js')).toString('base64'));
  const env={MARK_PAYMENTS_ENABLED:'true',PAY_LINK:'https://example.invalid/pay'};
  assert.equal((await api.onRequestGet({env})).status,503);
  const r=await api.onRequestPost({env,request:new Request('https://example.invalid',{method:'POST',body:JSON.stringify({cert:listing.cert,grader:'PSA',email:'test@example.invalid'})})});
  assert.equal(r.status,503);assert.equal((await r.json()).intakeStatus,'unavailable');assert.equal(calls,0);
 }finally{globalThis.fetch=original}
});
test('client submits through configured intake only, with contact email and no payment link creation',()=>{
 const html=read('public/check.html');const intake=html.split("var rqEl=")[1];
 assert.match(intake,/if\(!available\)/);assert.match(intake,/if\(pending\)return/);
 assert.match(intake,/fetch\('\/api\/mark-request',\{method:'POST'/);
 assert.match(html,/<input[^>]+type="email"/);
 assert.doesNotMatch(intake,/createElement|\.href\s*=\s*d\.payUrl/);
 // Server-side gating is the contract now; the client starts disabled and only enables on a confirmed GET.
 assert.match(html,/id="rgo" disabled/);assert.match(intake,/d\.intakeStatus==='available'/);
 assert.match(html,/Payments are inactive; submitting is not a paid order/);
});
test('saved route and handoff navigation are wired into existing pages',()=>{
 assert.match(page,/if\(a==='listing'\)return savedListing/);
  assert.doesNotMatch(page.split('<header class="top">')[1].split('<main>')[0],/Collector journey · Nidoking/);
  assert.match(page,/if\(a==='cards'\)return catalogueBrowse\(\)/);
 const cc=read('public/cleancheck.html');assert.match(cc,/Open saved listing \/ pricing evidence/);assert.match(cc,/Request a Gacha Mark evidence review →|Request an evidence review →/);assert.match(cc,/Payments are inactive/);
 assert.doesNotMatch(page,/8 marketplaces/);
});
