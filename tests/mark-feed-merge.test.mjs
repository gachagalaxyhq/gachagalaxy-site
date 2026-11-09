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
const bundled=JSON.parse(fs.readFileSync(path.join(root,'src/certs.json')));
const liveRow=c=>({cert:c.cert,grader:c.grader,card_name:c.name,card_no:c.num?.replace(/^#/,''),set_name:c.set,grade:c.grade,
 low_usd:c.low,point_usd:c.point,high_usd:c.high,confidence:c.conf,prices_used:c.prices,img_url:c.img,revoked:false,
 mark_events:c.ev.map(e=>({published_at:e.t,low_usd:e.low,point_usd:e.point,high_usd:e.high,tx:e.tx,explorer:e.explorer,registry:e.registry,chain_id:e.chainId}))});
const oldSix=bundled.slice(0,6).map(liveRow);
async function browser(rows,{failure=false}={}){
 const {document,window}=parseHTML(page),calls=[];
 let currentRows=rows,offline=failure;
 const location=new URL('https://local.example/platform#/certified');
 const fetch=async(url,options={})=>{calls.push({url:String(url),method:options.method||'GET'});
  if(String(url).includes('/rest/v1/marks?')){if(offline)throw Error('offline');return {ok:true,json:async()=>structuredClone(currentRows)}}
  assert.ok(String(url).startsWith('/'),'unexpected external request');
  const file=path.join(root,'public',String(url).split('?')[0]);return {ok:fs.existsSync(file),json:async()=>JSON.parse(fs.readFileSync(file))};
 };
 window.scrollTo=()=>{};
 const ctx=vm.createContext({document,window,location,fetch,URLSearchParams,AbortController,AbortSignal,URL,console,setTimeout,clearTimeout,
  navigator:{},sessionStorage:{getItem:()=>null},history:{replaceState(){}},TextEncoder,crypto:globalThis.crypto});
 // Execute the real page, including start(), async loadMarks(), and the rerender.
 vm.runInContext(script,ctx);await vm.runInContext('MKready',ctx);await new Promise(r=>setTimeout(r,30));
 return {document,calls,feed:(next,failed=false)=>{currentRows=next;offline=failed},run:s=>vm.runInContext(s,ctx),records:()=>JSON.parse(vm.runInContext('JSON.stringify(D.certs)',ctx))};
}
function twelve(a){
  assert.equal(a.records().length,bundled.length);assert.equal(a.run('MKon().length'),bundled.length);
  assert.equal(a.document.querySelectorAll('#mark-records .ccard').length,bundled.length);
  assert.equal(a.document.querySelector('#mkall').textContent,`Download all ${bundled.length} Marks as one PDF`);
  assert.equal(new Set(a.records().map(c=>c.grader+':'+c.cert)).size,bundled.length);
 assert.deepEqual(a.records().map(c=>c.cert),bundled.map(c=>c.cert));
 for(const c of bundled.slice(6)){
  const record=a.records().find(x=>x.cert===c.cert);assert.deepEqual(record.ev,c.ev);
  assert.equal(a.run(`markStatus(D.certs.find(c=>c.cert==='${c.cert}'),Date.parse('2026-11-07T21:00:00Z')).state`),'active');
  assert.match(a.document.querySelector(`#mark-records a[href="#/cert/${c.cert}"]`).textContent,/Certified onchain/);
 }
 assert.ok(a.calls.every(x=>x.method==='GET'));
}
test('real browser init: successful old-six live feed retains all twelve issued Marks',async()=>twelve(await browser(oldSix)));
test('real browser init: failed live feed retains all twelve issued Marks',async()=>twelve(await browser([],{failure:true})));
test('empty successful feed does not delete bundled evidence',async()=>twelve(await browser([])));
test('normalized grader/cert dedupes repeated rows without adding chain events',async()=>{
 const row={...oldSix[0],grader:' psa ',cert:' '+oldSix[0].cert+' '};
 const a=await browser([...oldSix,row,row]);twelve(a);
 assert.deepEqual(a.records()[0].ev,bundled[0].ev);
});
test('newer evidence wins over stale live prices, and newer live evidence is retained',async()=>{
 const stale={...oldSix[0],point_usd:1,updated_at:'2099-01-01T00:00:00Z',mark_events:oldSix[0].mark_events.slice(1)};
 const a=await browser([stale]);assert.equal(a.records()[0].point,bundled[0].point);
 const newer=structuredClone(oldSix[0]);newer.point_usd=2001;newer.mark_events[0]={...newer.mark_events[0],published_at:'2026-11-07T20:00:00Z',point_usd:2001,tx:'test-only-newer-evidence'};
 const b=await browser([newer]);assert.equal(b.records()[0].point,2001);assert.equal(b.records()[0].ev[0].tx,'test-only-newer-evidence');
 assert.equal(b.records()[0].ev.length,bundled[0].ev.length+1);
});
test('live revocation overrides bundled issuance and stays revoked across stale reloads/failure',async()=>{
 const row={...liveRow(bundled[6]),revoked:true,mark_events:[]};
  const a=await browser([...oldSix,row]);assert.equal(a.records().length,bundled.length);assert.equal(a.run('MKon().length'),bundled.length-1);
 const c=a.records().find(c=>c.cert===row.cert);assert.equal(c.revoked,true);assert.deepEqual(c.ev,bundled[6].ev);
 assert.match(a.document.querySelector(`#mark-records a[href="#/cert/${row.cert}"]`).textContent,/Revoked/);
  a.feed(oldSix);await a.run('loadMarks()');assert.equal(a.run('MKon().length'),bundled.length-1);
  a.feed([],true);await a.run('loadMarks()');assert.equal(a.run('MKon().length'),bundled.length-1);
 const kept=a.run(`mergeMarks(D.certs,[{...D.certs[6],revoked:false,updated_at:'2099-01-01'}])[6].revoked`);assert.equal(kept,true);
});
test('bundled revocation cannot be resurrected; same cert under another grader is distinct',async()=>{
 const a=await browser(oldSix);
 assert.equal(a.run('mergeMarks([{...D.certs[0],revoked:true}],[{...D.certs[0],revoked:false}])[0].revoked'),true);
 assert.equal(a.run("mergeMarks([D.certs[0]],[{cert:D.certs[0].cert,grader:' cgc ',ev:[]}]).length"),2);
 assert.equal(a.run("mergeMarks([],[{cert:D.certs[0].cert,grader:'CGC'}])[0].ev.length"),0);
});
