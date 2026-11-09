import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{parseHTML}=require('linkedom');
const root=path.resolve(import.meta.dirname,'..');
const page=fs.readFileSync(path.join(root,'public/platform.html'),'utf8');
const script=[...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(x=>x[1]).find(x=>x.includes('const D='));
const init=script.slice(0,script.indexOf('if(/access_token=|error_description=/'));
function section(hash){
 const {document,window}=parseHTML(page);
 const location=new URL('https://local.example/platform?saved=1'+hash),calls=[];
 const fetch=async url=>{calls.push(url);assert.ok(String(url).startsWith('/'),'no external source/network calls');const file=path.join(root,'public',String(url).split('?')[0]);return {ok:fs.existsSync(file),json:async()=>JSON.parse(fs.readFileSync(file))}};
 const ctx=vm.createContext({document,window,location,fetch,URLSearchParams,AbortController,AbortSignal,URL,console,setTimeout,clearTimeout,navigator:{},sessionStorage:{getItem:()=>null},history:{replaceState(){}},TextEncoder,crypto:globalThis.crypto});
 window.scrollTo=()=>{};vm.runInContext(init,ctx);
 return {document,calls,run:s=>vm.runInContext(s,ctx),view:()=>document.querySelector('#view')};
}
test('audited CGC groups keep exact image routes, evidence and explicit reference scope',async()=>{
 for(const [id,name,asset,total,shown] of [[11,'Pikachu','2025092337C49179',13,7],[71,'Venusaur','2025110440C70775',5,3]]){
  const a=section('#/card/'+id);await a.run('route()');await new Promise(r=>setTimeout(r,40));
  assert.equal(a.view().querySelector('h1').textContent,name);
  assert.equal(a.view().querySelector('.cimg').getAttribute('src'),'/cards/'+asset+'.webp');
  assert.ok(fs.statSync(path.join(root,'public/cards',asset+'.webp')).size>1000);
  assert.match(a.view().querySelector('.csum').textContent,new RegExp(`${total} source listings · ${shown} shown`));
  assert.match(a.view().querySelector('.pbox small').textContent,new RegExp(`Reference median from ${total} source listings`));
  assert.match(a.view().querySelector('#collector-source').textContent,new RegExp(`${total} source listings · ${shown} shown`));
  assert.equal(a.view().querySelectorAll('#collector-source tbody tr').length,shown);
  assert.ok(a.calls.includes('/data/collector-evidence.json'));
  assert.doesNotMatch(a.view().querySelector('#ltw thead').textContent,/PSA/);
  assert.match(a.view().querySelector('#ltw thead').textContent,/Cert ref/);
  const legend=a.view().querySelector('.legend');assert.equal(legend.textContent,'Saved median ask');
  assert.equal(a.view().querySelectorAll('.chart polyline').length,1);
  assert.equal(a.view().querySelector('#star').hidden,true);
 }
});
test('failed CGC evidence has useful empty state without nonexistent cert links',async()=>{
 const a=section('#/card/71');a.run('fetch=async()=>({ok:false})');await a.run('route()');await new Promise(r=>setTimeout(r,10));
 const evidence=a.view().querySelector('#collector-source');assert.match(evidence.textContent,/Source evidence could not load/);
 assert.doesNotMatch(evidence.textContent,/cert links above/);assert.equal(evidence.querySelector('a').getAttribute('href'),'#/cards');
});
test('read-only account views promise neither sign-in email nor previously sent code',async()=>{
 for(const route of ['#/watchlist','#/collection'])for(const step of ['email','code']){
  const a=section(route);a.run(`CS.step=${JSON.stringify(step)};CS.email="test@example.invalid"`);await a.run('route()');
  const panel=a.view().querySelector('.col-auth');assert.match(panel.textContent,/Sign-in unavailable/);
  assert.doesNotMatch(panel.textContent,/we will send|We sent|Check your email|Email me/i);
  assert.equal(panel.querySelectorAll('input,form,button').length,0);assert.equal(a.view().querySelectorAll('.account-unavailable').length,1);
 }
});
test('normal-mode shared sign-in retains email/code forms and existing handlers',()=>{
 const a=section('#/collection');
 const source=init.slice(init.indexOf('function colLogin()'),init.indexOf('async function colList(')).replaceAll('SAVED_ONLY','false');
 a.run(source);a.run('CS.ret="collection";CS.step="email";colLogin()');
 assert.ok(a.view().querySelector('#cemail'));assert.equal(typeof a.view().querySelector('#cf1').onsubmit,'function');
 assert.match(a.view().textContent,/Email me a sign-in link/);
 a.run('CS.step="code";colLogin()');assert.ok(a.view().querySelector('#ccode'));
 assert.equal(typeof a.view().querySelector('#cf2').onsubmit,'function');assert.ok(a.view().querySelector('#cback').onclick);
});
test('watch control fails closed for read failures and reports mutation failures honestly',async()=>{
 const a=section('#/card/11');await a.run('route()');
 const source=init.slice(init.indexOf('async function starInit(c)'),init.indexOf('async function watchlist()'));
 const code=source.replace('if(SAVED_ONLY)return;','');
 a.run(code);a.run('wlLoad=async()=>{throw new Error("offline")}');
 await a.run('starInit(byId[11])');const button=a.view().querySelector('#star');
 assert.equal(button.disabled,true);assert.equal(button.textContent,'Watchlist unavailable');
 a.run('wlLoad=async()=>{WL=[];return {user:{id:"unit"}}};SB={from:()=>({insert:async()=>({error:{code:"offline"}})})}');
 await a.run('starInit(byId[11])');assert.equal(button.disabled,false);await button.onclick();
 assert.equal(button.textContent,'Could not save, try again');assert.equal(button.getAttribute('aria-pressed'),'false');
 a.run('WL=[{id:"unit",card_key:byId[11].k}];wlLoad=async()=>({user:{id:"unit"}});SB={from:()=>({delete:()=>({eq:async()=>({error:{code:"offline"}})})})}');
 await a.run('starInit(byId[11])');await button.onclick();assert.equal(button.textContent,'Could not save, try again');
 assert.equal(button.getAttribute('aria-pressed'),'true');
});
test('chart suppresses absent series and never labels saved history as fair value',()=>{
 const a=section('#/groups');
 for(const [history,labels,count] of [
  [[['2026-11-01',1,null],['2026-11-02',2,null]],['Saved median ask'],1],
  [[['2026-11-01',null,1],['2026-11-02',null,2]],['Saved reference'],1],
  [[['2026-11-01',1,2],['2026-11-02',2,3]],['Saved median ask','Saved reference'],2]
 ]){
  a.view().innerHTML=a.run(`chart(${JSON.stringify(history)})`);
  assert.deepEqual([...a.view().querySelectorAll('.legend span')].map(el=>el.textContent),labels);
  assert.equal(a.view().querySelectorAll('polyline').length,count);assert.doesNotMatch(a.view().textContent,/Fair value/);
 }
 assert.match(page,/\[hidden\]\{display:none!important\}/);
});
test('Geodude Passport uses same-cert catalogue photo with readable price fields and neutral request option',async()=>{
 const a=section('#/passport/PSA/27867218');await a.run('route()');
 const manifest=JSON.parse(fs.readFileSync(path.join(root,'public/data/catalogue/manifest.json')));
 const rows=JSON.parse(fs.readFileSync(path.join(root,'public',manifest.base_url,manifest.shards[0].file)));
 const source=rows.find(row=>row.grader==='PSA'&&row.cert==='27867218');
 assert.equal(source.ask,1600);assert.equal(a.view().querySelector('h1').textContent,'Geodude-Reverse Foil');
 assert.equal(a.view().querySelector('.cimg').getAttribute('src'),source.image);
 assert.equal(a.view().querySelector('.passport-price>b').textContent,'$1,600');
 const visible=a.view().cloneNode(true);visible.querySelectorAll('details').forEach(el=>el.remove());
 assert.doesNotMatch(visible.textContent,/Collector Crypt|fNrzfkgLaUmqxu|source grade|requests unavailable|giant|No substitute/);
 assert.match(visible.textContent,/Mark request options/);assert.match(visible.textContent,/MINT 9/);
});
const routes=[
 ['#/','Catalogue',40],['#/cards','Catalogue',40],['#/home','Look up a Gacha Mark',0],
 ['#/lookup','Look up a Gacha Mark',0],['#/groups','Price-comparison groups',0],
 ['#/scanner','Saved price-gap scanner',0],['#/api','Public data',0],
 ['#/certified','Gacha Marks',8],['#/cert/109308847','109308847',0],
 ['#/card/7','Price history',0],['#/listing/PSA/109863355','Listing',0],
 ['#/passport/PSA/109863355','Card Passport',0],
 ['#/watchlist','Watchlist',8],['#/collection','My Collection',8],
 ['#/borrowing-pilot','Borrowing against cards',0]
];
for(const [hash,text,minimum] of routes)test('section renders safely: '+hash,async()=>{
 const a=section(hash);await a.run('route()');await new Promise(r=>setTimeout(r,40));
 const view=a.view();assert.ok(view,'view exists');assert.ok(view.textContent.includes(text),view.textContent.slice(0,200));
 assert.ok(view.querySelectorAll('.catalogue-row').length>=minimum);
 assert.ok(view.querySelectorAll('a,button,input').length>0,'usable navigation or controls');
 assert.ok(!view.textContent.includes('__CATALOGUE_JS__'));
 const visible=view.cloneNode(true);visible.querySelectorAll('details').forEach(el=>el.remove());
 assert.doesNotMatch(visible.textContent,/not_checked|not_run_here|Implementation note|fixture preview|intake database contract|decoded (?:listings|public|cards)/i,hash);
 for(const field of view.querySelectorAll('input:not([type="hidden"]),select,textarea')){
  assert.ok(field.getAttribute('aria-label')||field.getAttribute('aria-labelledby')||field.closest('label')||view.querySelector(`label[for="${field.id}"]`),'accessible name: '+field.id);
 }
 if(hash==='#/scanner'){assert.equal(view.querySelectorAll('tbody tr').length,20);assert.match(view.querySelector('.pricing-source').textContent,/Pricing snapshot/);assert.ok(!view.textContent.includes('Fair value'))}
 if(hash==='#/groups'){assert.equal(view.querySelectorAll('.rowc').length,40);assert.ok(view.querySelector('#group-search'))}
  if(hash==='#/api'){const pre=view.querySelector('#api-sample');const row=JSON.parse(pre.textContent);assert.equal(row.id,'source_id:2026101516C298786');assert.equal(row.scan.status,'decoded');for(const link of view.querySelectorAll('a[href^="/data/"],a[href="/prices.json"]'))assert.ok(fs.existsSync(path.join(root,'public',link.getAttribute('href'))))}
  if(['#/collection','#/watchlist'].includes(hash)){assert.match(view.textContent,/Catalogue examples, not your/);assert.equal(view.querySelectorAll('.col-auth input,.col-auth button').length,0);assert.ok(!a.calls.some(x=>String(x).includes('supabase')))}
});
test('pricing-group search submits and filters real saved groups',async()=>{
 const a=section('#/groups');await a.run('route()');a.document.querySelector('#group-query').value='Charizard';a.document.querySelector('#group-search').onsubmit({preventDefault(){}});
 assert.ok(a.view().querySelectorAll('.rowc').length>0);for(const row of a.view().querySelectorAll('.rowc'))assert.match(row.textContent,/Charizard/i);
});
test('Marks match bundled issued records, with a distinct non-certified catalogue preview',async()=>{
 const a=section('#/certified');await a.run('route()');await new Promise(r=>setTimeout(r,40));
 const marks=a.view().querySelector('#mark-records'),preview=a.view().querySelector('#mark-catalogue-preview');
 const real=JSON.parse(fs.readFileSync(path.join(root,'src/certs.json')));
   assert.equal(real.length,18);assert.equal(marks.querySelectorAll('.ccard').length,real.length);
 assert.deepEqual([...marks.querySelectorAll('.ccard')].map(x=>x.getAttribute('href')),real.map(c=>'#/cert/'+c.cert));
  assert.equal(marks.querySelectorAll('.mark-network').length,real.length);
 for(const label of marks.querySelectorAll('.mark-network'))assert.equal(label.textContent,'Robinhood Chain testnet');
 assert.equal(preview.previousElementSibling,marks);assert.equal(preview.querySelector('h2').textContent,'Browse more cards');
 assert.equal(preview.querySelectorAll('.catalogue-row').length,8);
 assert.equal(new Set([...preview.querySelectorAll('.catalogue-row')].map(x=>x.getAttribute('href'))).size,8);
 assert.equal(preview.querySelectorAll('.ccard,.mark-tag,.seal-sm').length,0);
 for(const row of preview.querySelectorAll('.catalogue-row')){assert.match(row.textContent,/Listing only/);assert.doesNotMatch(row.textContent,/certified|onchain/i);assert.ok(row.getAttribute('href').startsWith('#/catalogue/'))}
 assert.equal(a.view().querySelector('h1').textContent,'Gacha Marks');
 assert.doesNotMatch(a.view().textContent,/currently loaded feed|chain-wide issuance|non-revoked/);
 assert.doesNotMatch(page,/have saved scan evidence; .*not processed|__CATALOGUE_JS__/);
});
test('all nav sections map to existing handlers and borrowing implementation is not replaced',()=>{
 const {document}=parseHTML(page);const links=[...document.querySelectorAll('.tabs a')].map(a=>a.getAttribute('href'));
 assert.deepEqual(links,['#/cards','#/lookup','#/scanner','#/certified','#/api','#/watchlist','#/collection','/check']);
 for(const hash of links.filter(x=>x.startsWith('#')))assert.ok(routes.some(r=>r[0]===hash));
 assert.ok(page.includes('function borrowingPilot()'));
});
test('shared header keeps compact Price Check and hides global search only on catalogue',async()=>{
 const a=section('#/cards');await a.run('route()');
 const header=a.document.querySelector('header');
 assert.equal(a.document.querySelector('.sub'),null);
 assert.equal(header.querySelector('a[href="/check"]').textContent,'Price Check');
 assert.doesNotMatch(header.textContent,/Collector Crypt|Pricing groups|Collector journey|Separate existing borrowing pilot|UTC/);
 assert.equal(a.document.querySelector('#qf').hidden,true);
 assert.equal(a.document.body.classList.contains('catalogue-browse'),true);
 assert.equal(a.document.querySelectorAll('form[role="search"]:not([hidden])').length,1);
 for(const hash of ['#/scanner','#/lookup','#/home','#/catalogue/0/0/wrong','#/cards','#/']){
  a.run(`location.hash=${JSON.stringify(hash)}`);await a.run('route()');
  const catalogue=['#/cards','#/'].includes(hash);
  assert.equal(a.document.querySelector('#qf').hidden,catalogue,hash);
  assert.equal(a.document.body.classList.contains('catalogue-browse'),catalogue,hash);
 }
 assert.equal(a.document.querySelector('footer .fb span').textContent,'© 2026 GACHA GALAXY LABS INC.');
});
test('pilot stays view-only with historical evidence and distinct mainnet/testnet records',async()=>{
 const a=section('#/borrowing-pilot');await a.run('route()');const view=a.view();
 assert.equal(view.querySelector('h1').textContent,'Borrowing against cards');
 for(const text of ['109308847','token #1','Chain ID 4663','0xa4a98F8A373E98Ce555a7F6e1FF2094C858D8F23','have not been confirmed','saved testnet record, separate from this mainnet pilot','recording is historical','do not connect, deposit, approve, borrow, repay or withdraw.'])assert.ok(view.textContent.includes(text),text);
 assert.equal(view.querySelectorAll('button,input,form').length,0);
 assert.equal(view.querySelector('details').hasAttribute('open'),false);
 assert.deepEqual(a.calls,[]);
 assert.ok(view.querySelector('a[href="#/cert/109308847"]'));
 assert.match(a.run('JSON.stringify(D.certs.find(c=>c.cert==="109308847").ev)'),/46630/);
});
test('group browse, featured previews and scanner only select saved decoded source listings',async()=>{
 for(const hash of ['#/groups','#/lookup','#/scanner']){
  const a=section(hash);await a.run('route()');await new Promise(r=>setTimeout(r,40));
  const groups=JSON.parse(a.run('JSON.stringify(D.cards)'));
  for(const link of a.view().querySelectorAll('.rowc[href^="#/card/"],.mac[href^="#/card/"],.sc-n[href^="#/card/"]')){
   const id=Number(link.getAttribute('href').split('/').at(-1));assert.equal(groups.find(c=>c.i===id).decoded,true);
  }
  if(hash==='#/scanner'){
   const rows=JSON.parse(a.run('JSON.stringify(scanRows("","", ""))'));
   for(const [c,l] of rows.flat())assert.equal(l[6],true,c.cn);
  }
 }
});
test('featured comparisons use exact decoded source image routes and simple saved-ask labels',async()=>{
 const a=section('#/lookup');await a.run('route()');await new Promise(r=>setTimeout(r,40));
 const source=JSON.parse(fs.readFileSync(path.join(root,'data/cc.json'))).cards;
 const groups=JSON.parse(a.run('JSON.stringify(D.cards)'));
 const tiles=[...a.view().querySelectorAll('#featured-cards .mac')];assert.equal(tiles.length,4);
 for(const tile of tiles){
  const group=groups.find(c=>c.i===Number(tile.getAttribute('href').split('/').at(-1)));
  const record=source[group.i-1],listing=group.L.find(l=>l[7]===record.id&&l[6]===true);
  assert.equal(group.decoded,true);assert.ok(listing);assert.equal(listing[5],record.listings.find(l=>l.id===record.id).cert);
  assert.equal(tile.querySelector('img').getAttribute('src'),'/cards/'+record.id+'.webp');
  assert.ok(fs.statSync(path.join(root,'public',group.im)).size>1000);
  assert.match(tile.querySelector('.sm').textContent,/^Saved low ask \$/);
  assert.doesNotMatch(tile.textContent,/decoded|pricing inputs|Saved group/i);
 }
 a.run('imageUnavailable(document.querySelector("#featured-cards .mac img"))');
 assert.equal(a.view().querySelectorAll('#featured-cards .mac').length,3);
 assert.equal(a.view().querySelectorAll('#featured-cards .ph-img').length,0);
 a.run('D.cards.forEach(c=>{if(c.f)c.im=null})');await a.run('home()');
 assert.equal(a.view().querySelectorAll('#featured-cards .mac').length,0,'missing images excluded before rendering');
});
test('home, pricing groups and scanner keep processing copy and source metadata collapsed',async()=>{
 for(const hash of ['#/home','#/lookup','#/groups','#/scanner']){
  const a=section(hash);await a.run('route()');await new Promise(r=>setTimeout(r,40));
  const details=[...a.view().querySelectorAll('details.pricing-source')];assert.ok(details.length>0);
  for(const item of details){assert.equal(item.hasAttribute('open'),false);item.remove()}
  assert.doesNotMatch(a.view().textContent,/decoded|saved pricing inputs|pricing snapshot|133.*250/i,hash);
 }
});
