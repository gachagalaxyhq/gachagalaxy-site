/* Run with NODE_PATH pointing to a local linkedom installation. No network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {parseHTML}=require('linkedom');
const root=path.resolve(import.meta.dirname,'..');
const code=fs.readFileSync(path.join(root,'src/catalogue.js'),'utf8');
const workerCode=fs.readFileSync(path.join(root,'src/catalogue-worker.js'),'utf8');
const data=JSON.parse(fs.readFileSync(path.join(root,'data/cc.json')));
const readJSON=url=>JSON.parse(fs.readFileSync(path.join(root,'public',url)));
function app({hash='#/cards',fail='',hold=''}={}){
 const {document}=parseHTML('<html><body><input id="q"><main id="view"></main></body></html>');
 const location={hash};let waiting;
 const calls=[];
 const fetch=async url=>{calls.push(url);if(url.includes(fail)&&fail)return {ok:false};if(hold&&url.includes(hold))await new Promise(resolve=>waiting=resolve);return {ok:true,json:async()=>readJSON(url)}};
 class Worker{
  constructor(){const self={postMessage:data=>queueMicrotask(()=>this.onmessage?.({data}))};this.ctx=vm.createContext({self,fetch,AbortSignal});vm.runInContext(workerCode,this.ctx)}
  postMessage(data){this.ctx.self.onmessage({data}).catch(error=>this.onerror?.(error))}
  terminate(){}
 }
 const $=s=>document.querySelector(s),V=$('#view');
 const ctx=vm.createContext({document,$,V,location,fetch,Worker,AbortSignal,URLSearchParams,Map,Number,Promise,setTimeout,clearTimeout,console,
   D:JSON.parse(fs.readFileSync(path.join(root,'public/platform.html'),'utf8').split('const D=')[1].split(';const $=')[0]),setTab(){},esc:s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))});
 vm.runInContext(code,ctx);
 return {$,V,location,calls,run:script=>vm.runInContext(script,ctx),release:()=>waiting?.()};
}
test('default view shows 40 genuine listings, next/previous/clear controls and provenance',async()=>{
 const a=app();await a.run('catalogueBrowse()');
 assert.equal(a.V.querySelectorAll('.catalogue-row').length,40);
 assert.match(a.V.textContent,/100,877 saved listing records/);
  assert.doesNotMatch(a.V.textContent,/have saved scan evidence; .* not processed/);
  assert.equal(a.$('#catalogue-progress').textContent,'31,081 listings · 1–40');
 assert.ok(a.$('#catalogue-prev').hasAttribute('disabled'));
  assert.equal(a.calls.length,3,'manifest + decoded selection + one listing shard, not the search index');
  assert.match(a.V.textContent,/31,081 decoded listings/);
   assert.equal(a.V.querySelector('.catalogue-variety'),null);
 assert.equal(a.V.querySelectorAll('.catalogue-grid .catalogue-row').length,40);
 const first=a.$('.catalogue-row').getAttribute('href');
 a.$('#catalogue-next').onclick();assert.equal(a.location.hash,'#/cards?page=1');
  await a.run('catalogueBrowse()');assert.equal(a.$('#catalogue-progress').textContent,'31,081 listings · 41–80');
 assert.notEqual(a.$('.catalogue-row').getAttribute('href'),first);
 a.$('#catalogue-prev').onclick();await a.run('catalogueBrowse()');assert.equal(a.$('.catalogue-row').getAttribute('href'),first);
 a.$('#catalogue-reset').onclick();assert.equal(a.location.hash,'#/cards');
});
test('search form and filters navigate, full search is genuine and opens exact listing detail',async()=>{
 const a=app();await a.run('catalogueBrowse()');
 a.$('#catalogue-query').value='109863355';a.$('#catalogue-form').onsubmit({preventDefault(){}});
 assert.equal(a.location.hash,'#/cards?q=109863355');await a.run('catalogueBrowse()');
 assert.match(a.V.textContent,/Nidoking/);assert.ok(a.V.querySelectorAll('.catalogue-row').length>=1);
 const hash=a.$('.catalogue-row').getAttribute('href');a.location.hash=hash;
 const [,shard,offset,id]=hash.replace('#/','').split('/');
 await a.run(`catalogueDetail(${JSON.stringify(shard)},${JSON.stringify(offset)},${JSON.stringify(id)})`);
  assert.equal(a.$('.eyebrow').textContent,'Listing');assert.match(a.V.textContent,/Nidoking/);
  assert.match(a.V.textContent,/No Gacha Mark in these records/);assert.match(a.V.textContent,/Opening this saved listing does not issue anything/);
});
test('actual Moltres and decoded CGC listing details show labelled identity and hide source metadata',async()=>{
 const manifest=readJSON('/data/catalogue/manifest.json');const rows=readJSON(manifest.base_url+manifest.shards[0].file);
 for(const [offset,name,cert,ask,grader] of [[1,"Team Rocket's Moltres EX",'151880372','USDC 255.28','PSA'],[4,'Venusaur','1401015277013','USDC 109.60','CGC']]){
  const row=rows[offset],hash=`#/catalogue/0/${offset}/${encodeURIComponent(row.id)}`,a=app({hash});
  await a.run(`catalogueDetail(0,${offset},${JSON.stringify(encodeURIComponent(row.id))})`);
  assert.equal(a.$('h1').textContent,name);assert.equal(a.$('.cimg').getAttribute('src'),offset===1?'/cards/2026101516C298786.webp':row.image);
  const fields=Object.fromEntries([...a.$('.chead').querySelectorAll('dt')].map(dt=>[dt.textContent,dt.nextElementSibling.textContent]));
  assert.equal(fields['Cert reference'],cert);assert.equal(fields.Grader,grader);assert.equal(fields.Set,row.set);assert.equal(fields.Grade,row.grade);
  assert.equal(a.$('.detail-price b').textContent,ask);
  assert.equal(a.$('.detail-source').hasAttribute('open'),false);assert.match(a.$('.detail-source').textContent,/6 Nov 2026, 11:31 UTC/);
  assert.ok(a.$('.detail-source').textContent.includes(row.id));
  const visible=a.V.cloneNode(true);visible.querySelectorAll('details').forEach(el=>el.remove());
  assert.doesNotMatch(visible.textContent,/source_id:|T11:31:|2026101516C298786|2026080256C218572|Collector Crypt|undefined|not_checked/);
  assert.match(visible.textContent,/Saved asking price · availability not checked/);
 }
});
test('detail formatting preserves precision, uses UTC dates and shortens only structured names',()=>{
 const a=app();assert.equal(a.run('detailDate(null)'),'—');assert.equal(a.run('detailDate("invalid")'),'—');
 assert.equal(a.run('detailDate("2026-11-06T11:31:19.028000+00:00")'),'6 Nov 2026, 11:31 UTC');
 assert.equal(a.run('detailAmount(255.28,"USDC")'),'USDC 255.28');assert.equal(a.run('detailAmount(0.00001234,"USDC")'),'USDC 0.00001234');
 assert.equal(a.run('detailAmount(null,"USDC")'),'—');
 assert.equal(a.run('detailName({name:"Unstructured original title",number:"1",grader:"PSA"})'),'Unstructured original title');
});
test('empty results, final page, out-of-range page and unavailable data are explicit',async()=>{
  for(const [hash,pattern,rows] of [['#/cards?q=nosuchlistingzzzz',/No saved listings match/,0],['#/cards?page=777',/31,081 listings · 31,081–31,081/,1],['#/cards?page=99999',/Page outside the saved results/,0]]){
  const a=app({hash});await a.run('catalogueBrowse()');assert.match(a.V.textContent,pattern);assert.equal(a.V.querySelectorAll('.catalogue-row').length,rows);
 }
  for(const fail of ['manifest.json','decoded.json','listings-0000.json','search-0000.json']){
  const a=app({hash:fail.startsWith('search')?'#/cards?q=pikachu':'#/cards',fail});await a.run('catalogueBrowse()');
  assert.match(a.V.textContent,/Results are unavailable/);assert.ok(a.$('#catalogue-retry'));assert.equal(a.V.querySelectorAll('.catalogue-row').length,0);
 }
});
test('loading and stale-route protections do not overwrite another screen',async()=>{
 const a=app({hold:'manifest.json'});const pending=a.run('catalogueBrowse()');
  assert.match(a.V.textContent,/Loading saved listings/);
 a.location.hash='#/collection';a.V.innerHTML='Existing collection screen';a.release();await pending;
 assert.equal(a.V.textContent,'Existing collection screen');
});
test('Mark catalogue preview handles failed loading and stale routes without replacement data',async()=>{
 const failed=app({hash:'#/certified',fail:'listings-0000.json'});await failed.run('markCataloguePreview()');
 assert.match(failed.V.textContent,/Cards could not load/);assert.equal(failed.V.querySelectorAll('.catalogue-row').length,0);
 const a=app({hash:'#/certified',hold:'manifest.json'}),pending=a.run('markCataloguePreview()');
 a.location.hash='#/cards';a.V.innerHTML='Catalogue route';a.release();await pending;assert.equal(a.V.textContent,'Catalogue route');
});
test('record identity mismatch fails closed and rows escape markup and preserve missing values',async()=>{
 const a=app({hash:'#/catalogue/0/0/wrong'});await a.run('catalogueDetail("0","0","wrong")');assert.match(a.V.textContent,/No substitute record/);
  const html=a.run('catalogueRow({id:"source_id:x",name:"<script>alert(1)</script>",set:null,number:null,grader:null,grade:null,cert:null,ask:null,currency:null,image:null,scan:{processed:true,status:"decoded"}},[0,0])');
  assert.ok(!html.includes('<script>'));assert.match(html,/&lt;script&gt;/);assert.match(html,/Ask not supplied/);assert.match(html,/Image unavailable/);assert.doesNotMatch(html,/decoded|Saved back-image scan/);
  for(const status of ['failed','unreadable','not_processed','pending','decoder_error','decoder_timeout','decoder_crash','no_back_photo'])assert.throws(()=>a.run(`catalogueRow({scan:{processed:true,status:${JSON.stringify(status)}}},[0,0])`),/Non-decoded/);
  assert.throws(()=>a.run('catalogueRow({scan:{processed:false,status:"decoded"}},[0,0])'),/Non-decoded/);
});
test('form filter controls actually change query state and return exact saved coverage',async()=>{
 const a=app();await a.run('catalogueBrowse()');
 const grader=a.$('#catalogue-grader');
 for(const o of grader.querySelectorAll('option'))o.removeAttribute('selected');grader.querySelector('option[value="CGC"]').selected=true;
 grader.onchange();assert.match(a.location.hash,/grader=CGC/);await a.run('catalogueBrowse()');
  assert.equal(a.$('#catalogue-progress').textContent,'5,907 listings · 1–40');
  assert.equal(a.$('#catalogue-scan'),null);
  a.location.hash='#/cards?grader=CGC&scan=pending';await a.run('catalogueBrowse()');
  assert.ok(a.V.querySelectorAll('.catalogue-row').length>0);
  assertDecodedTiles(a);
});
function assertDecodedTiles(a){
 for(const tile of a.V.querySelectorAll('.catalogue-row')){
  const [,s,o,id]=tile.getAttribute('href').replace('#/','').split('/');
  const m=readJSON('/data/catalogue/manifest.json'),r=readJSON(m.base_url+m.shards[Number(s)].file)[Number(o)];
  assert.equal(r.id,decodeURIComponent(id));assert.equal(r.scan.processed,true);assert.equal(r.scan.status,'decoded');
 }
}
test('actual failed Magneton and unreadable Charizard excluded; decoded Moltres searchable',async()=>{
 for(const [id,total] of [['source_id:202512044C89811',0],['source_id:2026081235C223307',0],['source_id:2026101516C298786',1]]){
  const a=app({hash:'#/cards?q='+encodeURIComponent(id)});await a.run('catalogueBrowse()');
  assert.equal(a.V.querySelectorAll('.catalogue-row').length,total);assertDecodedTiles(a);
 }
});
test('all default, paginated and curated section previews select decoded rows before slicing',async()=>{
 for(const hash of ['#/cards','#/cards?page=1','#/cards?page=777','#/cards?scan=pending']){
  const a=app({hash});await a.run('catalogueBrowse()');assertDecodedTiles(a);
 }
 for(const script of ['markCataloguePreview()','sectionSavedPreview("watchlist")','sectionSavedPreview("collection")']){
  const a=app({hash:'#/certified'});await a.run(script);assert.equal(a.V.querySelectorAll('.catalogue-row').length,8);assertDecodedTiles(a);
  assert.doesNotMatch(a.V.textContent,/decoded listings shown|decoded public listings|100,877/);
 }
});
test('catalogue keeps attribution and evidence limits collapsed, without visible clutter',async()=>{
  const a=app();await a.run('catalogueBrowse()');
  assert.equal(a.$('h1').textContent,'Catalogue');
  assert.equal(a.$('.pg-sub').textContent,'Saved listings · snapshot 2026-11-06.');
  const details=a.$('details.catalogue-source');
  assert.ok(details);assert.equal(details.hasAttribute('open'),false);
  assert.match(details.textContent,/Source: Collector Crypt/);
  for(const limit of ['processed=true and status=decoded','All raw saved records remain','Authenticity, ownership, custody, issuance and current availability','Asking prices are not completed sales'])assert.ok(details.textContent.includes(limit),limit);
  details.remove();
  assert.doesNotMatch(a.V.textContent,/Collector Crypt|Successfully decoded only|Separate |Search covers|not live stock|real decoded listings|100,877/);
  assert.deepEqual([...a.V.querySelectorAll('.catalogue-links a')].map(a=>a.textContent),['Price comparisons','Gacha Marks']);
  assert.doesNotMatch(a.$('#catalogue-form').textContent,/decoded/);
  assertDecodedTiles(a);
});
test('catalogue hierarchy places one toolbar above cards and provenance after pagination',async()=>{
 const a=app();await a.run('catalogueBrowse()');
 assert.deepEqual([...a.V.children].map(el=>el.className||el.id),['catalogue-heading','bar','catalogue-results','catalogue-provenance']);
 assert.equal(a.V.querySelectorAll('form[role="search"]').length,1);
 assert.equal(a.$('.catalogue-title #catalogue-progress').textContent,'31,081 listings · 1–40');
 assert.ok(a.$('#catalogue-form #catalogue-query'));assert.ok(a.$('#catalogue-form #catalogue-grader'));
 assert.equal(a.$('.catalogue-provenance').previousElementSibling,a.$('#catalogue-results'));
 assert.equal(a.$('.catalogue-pagination').previousElementSibling,a.$('.catalogue-grid'));
 for(const tile of a.V.querySelectorAll('.catalogue-row')){
  assert.doesNotMatch(tile.textContent,/Saved back-image scan|decoded|Successfully decoded only/i);
  assert.match(tile.textContent,/Listing only/);assert.equal(tile.querySelectorAll('.cell').length,1);
  assert.match(tile.textContent,/saved ask|Ask not supplied/);
 }
 assertDecodedTiles(a);
});
