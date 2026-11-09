import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..');
const manifest=JSON.parse(fs.readFileSync(path.join(root,'public/data/catalogue/manifest.json')));
manifest.decoded=JSON.parse(fs.readFileSync(path.join(root,'public/data/catalogue/decoded.json')));
const code=fs.readFileSync(path.join(root,'src/catalogue-worker.js'),'utf8');
function worker(fail=false){
 const messages=[],calls=[];
 const ctx=vm.createContext({AbortSignal,Error,console,self:{postMessage:m=>messages.push(m)},fetch:async url=>{
  calls.push(url);if(fail)return {ok:false};
  return {ok:true,json:async()=>JSON.parse(fs.readFileSync(path.join(root,'public',url)))};
 }});
 vm.runInContext(code,ctx);
 return {messages,calls,send:async data=>{await ctx.self.onmessage({data:{manifest,pageSize:40,...data}});return messages.filter(m=>m.id===data.id).at(-1)}};
}
test('full worker index returns first/next/last pages and preserves snapshot order',async()=>{
  const w=worker(),a=await w.send({id:1,page:0}),b=await w.send({id:2,page:1}),z=await w.send({id:3,page:777});
  assert.equal(a.total,31081);assert.equal(a.refs.length,40);assert.equal(b.refs.length,40);assert.equal(z.refs.length,1);
  assert.deepEqual(JSON.parse(JSON.stringify(a.refs)),manifest.decoded.refs.slice(0,40));assert.deepEqual(JSON.parse(JSON.stringify(b.refs)),manifest.decoded.refs.slice(40,80));
 assert.equal(new Set([...a.refs,...b.refs].map(JSON.stringify)).size,80);
 assert.equal(w.calls.length,21,'search shards loaded once, not per query');
 assert.ok(w.messages.some(x=>x.type==='progress'&&x.loaded===100877));
});
test('search reaches final catalogue record, exact listing IDs, certs, grader and scan filters',async()=>{
 const w=worker();
  const lastRef=manifest.decoded.refs.at(-1),last=JSON.parse(fs.readFileSync(path.join(root,'public',manifest.base_url,manifest.shards[lastRef[0]].file)))[lastRef[1]];
  const id=await w.send({id:1,query:last.id});assert.equal(id.total,1);assert.deepEqual(JSON.parse(JSON.stringify(id.refs[0])),lastRef);
 const cert=await w.send({id:2,query:'109863355',grader:'PSA'});assert.ok(cert.total>=1);
  const pending=await w.send({id:3,scan:'pending'});assert.equal(pending.total,31081);
  const processed=await w.send({id:4,scan:'processed'});assert.equal(processed.total,31081);
  const psa=await w.send({id:5,grader:'PSA'});assert.equal(psa.total,25171);
 const none=await w.send({id:6,query:'no-such-card-zzzzzz'});assert.equal(none.total,0);
 const partial=await w.send({id:7,query:'pokemon magneton'});assert.ok(partial.total>0);
});
test('worker fails visibly on unavailable data without returning a partial result',async()=>{
 const w=worker(true),r=await w.send({id:1,query:'Pikachu'});
 assert.equal(r.type,'error');assert.match(r.message,/no complete search result/);
 assert.ok(!w.messages.some(x=>x.type==='results'));
});
test('filtered worker pagination exactly covers every decoded reference without gaps',async()=>{
  const w=worker();let seen=[];
  for(let page=0;page<Math.ceil(manifest.decoded.decoded_records/40);page++){
    const result=await w.send({id:page+1,page,scan:'pending'});
    assert.equal(result.total,manifest.decoded.decoded_records);
    seen.push(...JSON.parse(JSON.stringify(result.refs)));
  }
  assert.deepEqual(seen,manifest.decoded.refs);
  assert.equal(new Set(seen.map(JSON.stringify)).size,31081);
});
test('rendered integration keeps routes and excludes misleading entire-catalogue claims',()=>{
 const page=fs.readFileSync(path.join(root,'public/platform.html'),'utf8');
 assert.ok(!page.includes('__CATALOGUE_JS__'));
 assert.ok(page.includes("if(a==='cards')return catalogueBrowse()"));
 assert.ok(page.includes("if(a==='groups')return list()"));
 for(const route of ['listing','passport','cert','scanner','collection','borrowing-pilot'])assert.ok(page.includes("a==='"+route+"'"));
 assert.ok(!page.includes('The 8 highest-valued cards listed on Collector Crypt'));
 assert.ok(!page.includes('slabs are certified today'));
 assert.ok(!page.includes('slabs with a Gacha Mark onchain on Robinhood Chain.'));
 const scripts=[...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(x=>x[1]);
 for(const script of scripts)new vm.Script(script);
});
test('platform landing opens genuine catalogue; Mark lookup remains explicitly reachable',()=>{
 const page=fs.readFileSync(path.join(root,'public/platform.html'),'utf8');
 const routeCode=page.slice(page.indexOf('function route(){'),page.indexOf('let catalogueSearchTimer;'));
 for(const hash of ['', '#/', '#/cards', '#/home', '#/lookup']){
  const hits=[];
  const context=vm.createContext({location:{hash},document:{body:{classList:{toggle(){}}}},$:()=>({}),catalogueBrowse:()=>hits.push('catalogue'),home:()=>hits.push('lookup')});
  vm.runInContext(routeCode+';route()',context);
  assert.deepEqual(hits,[['#/home','#/lookup'].includes(hash)?'lookup':'catalogue'],hash||'bare platform URL');
 }
 assert.match(page,/href="#\/cards" data-t="cards">Catalogue/);
 assert.match(page,/href="#\/lookup" data-t="home">Mark lookup/);
});
