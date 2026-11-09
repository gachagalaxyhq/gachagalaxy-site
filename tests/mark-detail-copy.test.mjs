import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const {parseHTML}=createRequire(import.meta.url)('linkedom');
const page=fs.readFileSync(new URL('../public/platform.html',import.meta.url),'utf8');
const script=[...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(x=>x[1]).find(x=>x.includes('const D='));
const init=script.slice(0,script.indexOf('if(/access_token=|error_description=/'));
function app(saved=true){
 const {document,window}=parseHTML(page),location=new URL('https://local.example/platform'+(saved?'?saved=1':'')+'#/cert/118973623');
 const calls=[];window.scrollTo=()=>{};
 const ctx=vm.createContext({document,window,location,URLSearchParams,URL,AbortController,AbortSignal,TextEncoder,crypto:globalThis.crypto,console,setTimeout,clearTimeout,navigator:{},sessionStorage:{getItem:()=>null},history:{replaceState(){}},fetch:async url=>{calls.push(url);return {ok:false,json:async()=>[]}}});
 vm.runInContext(init,ctx);
 return {document,calls,run:s=>vm.runInContext(s,ctx)};
}
test('saved Mark detail uses human copy and collapses all check diagnostics',async()=>{
 const a=app();a.run('cert("118973623")');await new Promise(r=>setTimeout(r,0));
 const details=a.document.querySelector('.mark-record-details');assert.ok(details);assert.equal(details.hasAttribute('open'),false);
 const fields=Object.fromEntries([...details.querySelectorAll('dt')].map(dt=>[dt.textContent,dt.nextElementSibling.textContent]));
 assert.equal(fields['Grader lookup'],'Not checked');assert.equal(fields['QR comparison'],'Not checked');
 assert.equal(fields['Physical authentication'],'Not performed');assert.equal(fields['Live chain status'],'Not checked in saved view');
 assert.match(fields['Review period'],/publication window, not live chain validation/);
 assert.equal(a.document.querySelector('#mkcc'),null);
 assert.match(a.document.querySelector('.cert').textContent,/Recorded evidence; not a physical authentication/);
 details.remove();
 assert.doesNotMatch(a.document.querySelector('.cert').textContent,/not_checked|saved.record mode|database record|days left|refresh due|Grader lookup|QR comparison|Physical authentication: not performed/i);
 assert.ok(a.calls.every(u=>u.startsWith('/data/')),'saved view makes no live chain call');
 const c=JSON.parse(a.run('JSON.stringify(D.certs.find(c=>c.cert==="118973623"))'));
 assert.ok(c.ev.length);assert.equal(c.cert,'118973623');
});
test('publication states and due calculation remain distinct from live validation',()=>{
 const a=app();
 const record={cert:'unit',ev:[{t:'2026-11-06T00:00:00Z'}]};
 for(const [date,state] of [['2026-11-07','active'],['2026-12-03','recheck'],['2026-12-07','expired']]){
  const st=JSON.parse(a.run(`JSON.stringify(markStatus(${JSON.stringify(record)},Date.parse("${date}")))`));
  assert.equal(st.state,state);assert.equal(st.until,Date.parse('2026-12-06T00:00:00Z'));
  const line=a.run(`mkLine(${JSON.stringify(st)})`);assert.match(line,/Published 6 Nov/);assert.match(line,/6 Dec 2026/);assert.doesNotMatch(line,/refresh|days left/);
 }
 assert.equal(a.run(`markStatus(${JSON.stringify({...record,revoked:true})}).state`),'revoked');
 assert.equal(a.run('markStatus({cert:"unit",ev:[]}).state'),'none');
 a.run('D.certs.find(c=>c.cert==="118973623").revoked=true;cert("118973623")');
 assert.equal(a.document.querySelector('.mk-st .pill').textContent,'Revoked');
 a.run('D.certs.find(c=>c.cert==="118973623").revoked=false;D.certs.find(c=>c.cert==="118973623").ev=[];cert("118973623")');
 assert.equal(a.document.querySelector('.mk-st .pill').textContent,'No publication recorded');
});
test('normal-mode registry failures, missing, revoked, mismatch and match remain separate',async()=>{
 const a=app(false);a.run('ccRead=async()=>{throw new Error("offline")};cert("118973623")');
 await new Promise(r=>setTimeout(r,0));
 assert.match(a.document.querySelector('#mkcc').textContent,/Live chain check unavailable/);
 assert.match(a.document.querySelector('#mkcc').textContent,/has not been confirmed/);
 for(const [value,pattern] of [[null,/not available/],[{appraisedAt:0},/No record for this cert/],[{appraisedAt:1,revoked:true},/Revoked on the registry/],[{appraisedAt:1,point:1},/Does not match the chain/]]){
  a.run(`ccRead=async()=>(${JSON.stringify(value)})`);
  await a.run('chainCheck(D.certs.find(c=>c.cert==="118973623"),D.certs.find(c=>c.cert==="118973623").ev[0])');
  assert.match(a.document.querySelector('#mkcc').textContent,pattern);
 }
 a.run('ccRead=async()=>{const e=D.certs.find(c=>c.cert==="118973623").ev[0];return {appraisedAt:Date.parse(e.t)/1000,low:Math.round(e.low*100),point:Math.round(e.point*100),high:Math.round(e.high*100)}}');
 await a.run('chainCheck(D.certs.find(c=>c.cert==="118973623"),D.certs.find(c=>c.cert==="118973623").ev[0])');
 assert.match(a.document.querySelector('#mkcc').textContent,/Matches the chain/);
});
