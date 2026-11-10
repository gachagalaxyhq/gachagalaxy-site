// Offline only: execute the shipped website scripts with a small DOM harness.
// fetch is always intercepted; no public requests, paid lookups or backend writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');
const scripts=html=>[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]);
const settle=async()=>{for(let i=0;i<12;i++)await new Promise(r=>setImmediate(r))};
function dom(html){
 const elements=new Map();
 for(const m of html.matchAll(/<([a-z]+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)){
  const attrs=Object.fromEntries([...m[2].matchAll(/([\w-]+)="([^"]*)"/g)].map(a=>[a[1],a[2]]));
  elements.set(m[3],{...attrs,value:attrs.value||'',hidden:/\bhidden\b/.test(m[2]),disabled:/\bdisabled\b/.test(m[2]),innerHTML:'',textContent:'',listeners:{},
   addEventListener(type,fn){this.listeners[type]=fn},removeAttribute(key){delete this[key]},focus(){this.focused=true}});
 }
 const document={getElementById:id=>elements.get(id),querySelector:s=>elements.get(s.slice(1))};
 return {elements,document};
}
function boot(file,query='',responses={}){
 const html=read(file),{document,elements}=dom(html),calls=[];
 const fetch=async(url,options={})=>{
  calls.push({url,options});
  assert.notEqual(options.method,'POST','This test must never submit a request');
  if(Object.hasOwn(responses,url))return {ok:true,json:async()=>responses[url]};
  if(url.startsWith('/data/')){
   try{return {ok:true,json:async()=>JSON.parse(read('public'+url))}}catch{return {ok:false,status:404,json:async()=>null}}
  }
  throw new Error('Unstubbed fetch: '+url);
 };
 // check.html opens #request via location.hash + window 'hashchange'; stub both (no navigation happens).
 const context=vm.createContext({document,fetch,URLSearchParams,location:{search:query,hash:''},window:{addEventListener(){}},history:{replaceState(...args){context.lastURL=args[2]}},console});
 for(const script of scripts(html))vm.runInContext(script,context,{filename:file});
 return {elements,calls,context};
}
const status={ok:true,intakeStatus:'available',allowanceScope:'global',freeLeft:0,freeLimit:10,supportedGraders:['PSA','CGC'],paymentStatus:'inactive',payUrl:null};
const check=(query='',state=status)=>boot('public/check.html',query,{'/api/mark-request':state});
const emit=(el,type)=>el.listeners[type]({preventDefault(){}});

test('bare and incomplete request contexts never create a saved listing URL',async()=>{
 for(const q of ['', '?cert=109308847','?grader=PSA','?cert=abc&grader=CGC','?cert=1401015277013&grader=PSA']){
  const b=check(q);await settle();const link=b.elements.get('listing-link');
  assert.equal(link.hidden,true);assert.equal(link.href,undefined);
  assert.equal(b.elements.get('evidence-link').href,'/cleancheck');
  assert.equal(b.calls.length,1);
 }
});
test('request context links canonicalize and clear immediately when inputs change',async()=>{
 const b=check('?cert=00109-308-847&grader=psa');await settle();
 const cert=b.elements.get('rcert'),gr=b.elements.get('rgr'),link=b.elements.get('listing-link');
 assert.equal(link.hidden,false);assert.equal(link.href,'/platform?saved=1#/listing/PSA/109308847');
 cert.value='1401 015 277 013';gr.value='CGC';emit(gr,'change');
 assert.equal(link.href,'/platform?saved=1#/listing/CGC/1401015277013');
 assert.equal(b.elements.get('evidence-link').href,'/cleancheck?cert=1401015277013&grader=CGC');
 cert.value='';emit(cert,'input');assert.equal(link.hidden,true);assert.equal(link.href,undefined);
 cert.value='109308847';gr.value='';emit(gr,'change');assert.equal(link.hidden,true);assert.equal(link.href,undefined);
});
test('zero complimentary allowance still enables requests, independently of payment availability',async()=>{
 for(const state of [status,{...status,paymentStatus:'unknown'}]){
  const b=check('',state);await settle();
  assert.equal(b.elements.get('rgo').disabled,false);
  assert.equal(b.elements.get('intake-label').textContent,'Requests accepted.');
  assert.match(b.elements.get('freeleft').textContent,/not free/);
  assert.match(b.elements.get('rn').textContent,/does not collect payment or issue a Mark/);
  assert.equal(b.calls.length,1);
 }
 const b=check('',{...status,intakeStatus:'unavailable'});await settle();
 assert.equal(b.elements.get('rgo').disabled,true);
 assert.equal(b.elements.get('intake-label').textContent,'Requests unavailable.');
});
test('13-digit CGC lookup does not expand Mark request intake',async()=>{
 const b=check('?cert=1401015277013&grader=CGC');await settle();
 b.elements.get('remail').value='local@example.com';await emit(b.elements.get('rq'),'submit');
 assert.match(b.elements.get('rn').textContent,/6–10 digits/);
 assert.equal(b.calls.length,1);
});
test('price query behavior stays unchanged and makes no additional calls',async()=>{
 const b=boot('public/check.html','?q=Rayquaza',{'/api/mark-request':status,'/api/check?q=Rayquaza':{cards:[]}});await settle();
 assert.equal(b.elements.get('q').value,'Rayquaza');
 assert.match(b.elements.get('msg').textContent,/No match/);
 assert.deepEqual(b.calls.map(c=>c.url).sort(),['/api/check?q=Rayquaza','/api/mark-request'].sort());
});
test('real 13-digit CGC record survives validation of the entire stored shard and renders actual evidence',async()=>{
 const b=boot('public/cleancheck.html','?cert=001401-015-277-013&grader=CGC');await settle();
 const out=b.elements.get('out').innerHTML;
 // Live wording: 'Matching saved listing found' / 'Matching records (N)' (was 'Indexed Collector Crypt record found' / 'Claims found').
 assert.match(out,/Matching saved listing found/);assert.match(out,/Saved listing: found — 1 saved record/);
 assert.match(out,/Venusaur CGC 10 Pristine/);assert.match(out,/Matching records \(1\)/);
 // Saved ask moves with each Collector Crypt refresh (81 -> 101.95); assert the shard's own value as rendered (whole dollars).
 const venusaur=JSON.parse(read('public/data/cc/140.json')).find(r=>r.grader==='CGC'&&r.cert==='1401015277013');
 assert.ok(out.includes('Asking $'+Number(venusaur.ask).toLocaleString('en-US',{maximumFractionDigits:0})));assert.match(out,/CGC cert ref 1401015277013/);
 assert.match(out,/Collector Crypt saved shard: checked/);assert.doesNotMatch(out,/Incomplete source check/);
 assert.match(out,/\/listing\/CGC\/1401015277013/);
 assert.equal(b.context.lastURL,'?cert=1401015277013&grader=CGC');
 assert.deepEqual(b.calls.map(c=>c.url).sort(),['/data/cc/140.json','/data/cc/index.json','/data/own-claims.json'].sort());
});
test('grader-aware lookup rejects 13-digit PSA, supports any-grader CGC and normal PSA',async()=>{
 const psa=boot('public/cleancheck.html','?cert=1401015277013&grader=PSA');await settle();
 assert.match(psa.elements.get('out').textContent,/PSA cert number with 6–10/);
 assert.equal(psa.calls.some(c=>c.url==='/data/cc/140.json'),false);
 for(const query of ['?cert=1401015277013','?cert=109308847&grader=PSA']){
  const b=boot('public/cleancheck.html',query);await settle();
  assert.match(b.elements.get('out').innerHTML,/Matching records \(\d+\)/);
  assert.doesNotMatch(b.elements.get('out').innerHTML,/Incomplete source check|\/passport\/\//);
 }
});
test('unknown unscoped cert does not generate malformed request or Passport links',async()=>{
 const b=boot('public/cleancheck.html','?cert=1409999999999');await settle();
 const out=b.elements.get('out').innerHTML;
 assert.match(out,/No indexed claims found/);assert.match(out,/Choose a grader/);
 assert.doesNotMatch(out,/\/passport\/|\/check\?cert=/);
});
test('changing cleancheck inputs clears old context links and supersedes pending results',async()=>{
 const b=boot('public/cleancheck.html','?cert=1401015277013&grader=CGC');
 b.elements.get('cert').value='109308847';emit(b.elements.get('cert'),'input');await settle();
 assert.equal(b.elements.get('out').innerHTML,'');assert.equal(b.elements.get('out').className,'result');
 assert.equal(b.elements.get('go').disabled,false);
 b.elements.get('grader').value='PSA';emit(b.elements.get('grader'),'change');
 emit(b.elements.get('f'),'submit');await settle();
 assert.match(b.elements.get('out').innerHTML,/PSA cert ref 109308847/);
 assert.doesNotMatch(b.elements.get('out').innerHTML,/1401015277013/);
});
test('source failures stay incomplete rather than implying an all-clear',async()=>{
 const b=boot('public/cleancheck.html','?cert=1401015277013&grader=CGC',{'/data/own-claims.json':{invalid:true}});await settle();
 assert.match(b.elements.get('out').innerHTML,/Incomplete source check/);
 assert.match(b.elements.get('out').innerHTML,/Venusaur/);
 assert.match(b.elements.get('out').innerHTML,/saved records: unavailable/);
});
test('every requested form field has an explicit visible label',()=>{
 for(const [file,ids] of [['public/check.html',['q','rcert','rgr','remail']],['public/cleancheck.html',['cert','grader']]]){
  const html=read(file);
  for(const id of ids)assert.match(html,new RegExp('<label for="'+id+'">[^<]+</label>'));
 }
});
test('availability and limits copy avoids stale unavailable intake and raw internal terminology',()=>{
 for(const file of ['public/check.html','public/cleancheck.html','public/certificate.html']){
  const html=read(file);assert.doesNotMatch(html,/database contract|configured global allowance|timestamped evidence report\/record/);
  // Internal state keys may remain in scripts; visible copy must be human-readable.
  assert.doesNotMatch(html.split('<script>')[0],/not_checked|intake unavailable|new report intake (?:is |are )?unavailable/i);
  assert.match(html,/not complimentary|not free/);assert.match(html,/payments are inactive/i);
 }
});
test('homepage and template embed all eighteen published records with their real grades',()=>{
 const source=JSON.parse(read('src/certs.json'));
 assert.equal(source.length,18);assert.equal(new Set(source.map(c=>c.grader+'/'+c.cert)).size,18);
 for(const file of ['public/index.html','src/index.tpl.html']){
  // Live wording: the register heading is 'Eighteen published records' (was 'Six featured records'); tie the count to src/certs.json.
  const html=read(file);assert.match(html,/Eighteen published records/);assert.equal(source.length,18);assert.match(html,/Featured records/);
  assert.doesNotMatch(html,/slabs are certified today|Six real PSA 10 slabs|Certificates onchain/);
  const script=scripts(html).join('\n');
  const featured=JSON.parse(script.match(/(?:let|const) CERTS=(\[[\s\S]*?\]);/)[1]);
  assert.equal(featured.length,18);assert.ok(featured.every(c=>source.some(s=>s.cert===c.cert&&s.grade===c.grade)));
  assert.ok(featured.every(c=>source.some(s=>s.cert===c.cert&&s.grader==='PSA')));
  const start=script.indexOf('const L=CERTS.map');
  const refresh=script.slice(start,script.indexOf('  otb();',start));
  const ctx=vm.createContext({CERTS:structuredClone(featured),rows:source.map(c=>({...c,card_name:c.name})),otb(){},$:s=>({value:'',innerHTML:''}),vcard(){return ''}});
  vm.runInContext(refresh,ctx);assert.equal(ctx.CERTS.length,18);
  assert.deepEqual(Array.from(ctx.CERTS,c=>c.cert),featured.map(c=>c.cert));
 }
});
// KNOWN PRODUCT BUG (reported, not fixed here): the homepage claims all eighteen records are PSA 10,
// but src/certs.json has PSA 9/PSA 7 entries, and the inline lookup only knows the six featured
// records, so 12 of the 18 'Featured Mark records' buttons report 'not among the eighteen'.
test('homepage register copy and lookup agree with the eighteen published records',()=>{
 const source=JSON.parse(read('src/certs.json'));
 for(const file of ['public/index.html','src/index.tpl.html']){
  const html=read(file);
  if(/all PSA 10/.test(html))assert.ok(source.every(c=>c.grade==='PSA 10'),file+': "all PSA 10" contradicts src/certs.json grades');
  const featured=JSON.parse(scripts(html).join('\n').match(/(?:let|const) CERTS=(\[[\s\S]*?\]);/)[1]);
  const buttons=[...html.matchAll(/<div class="try">[\s\S]*?<\/div>/g)][0][0].match(/data-c="(\d+)"/g).map(x=>x.slice(8,-1));
  assert.deepEqual(buttons.filter(c=>!featured.some(f=>f.cert===c)),[],file+': featured buttons the lookup cannot show');
 }
});
test('all shipped inline website scripts compile',()=>{
 for(const file of ['public/index.html','public/check.html','public/cleancheck.html','public/certificate.html','src/index.tpl.html'])
  for(const script of scripts(read(file)))new vm.Script(script,{filename:file});
});
