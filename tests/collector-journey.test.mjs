import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {jsPDF}=require('jspdf');
const {buildMarkPdf}=require('../src/markpdf.js');
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');
const page=read('public/platform.html');
const D=JSON.parse(page.split('const D=')[1].split(';const $=')[0]);
const evidence=JSON.parse(read('public/data/collector-evidence.json'));
test('generated scripts parse and scanner implementation remains unchanged from template',()=>{
  for(const m of page.matchAll(/<script>([\s\S]*?)<\/script>/g))new vm.Script(m[1]);
  const template=read('src/platform.tpl.html');
  const updated=new Date(JSON.parse(read('data/cc.json')).updated).toLocaleString('en-GB',{day:'numeric',month:'short',year:'numeric',timeZone:'UTC'})+', '+new Date(JSON.parse(read('data/cc.json')).updated).toISOString().slice(11,16)+' UTC';
  assert.equal(page.split('function scanRows')[1].split('const API=')[0],template.split('function scanRows')[1].split('const API=')[0].replaceAll('__UPDATED__',updated));
});
test('primary example has real dated evidence matching card and clean-check shard',()=>{
  const c=D.cards.find(c=>c.i===7),e=evidence.cards['7'];
  assert.equal(c.g,'PSA 10');assert.equal(c.ga,95);assert.equal(e.point,c.ga);
  assert.equal(e.listings.length,16);assert.equal(evidence.observed_at,'2026-11-06T06:57:12Z');
  const listing=e.listings[0];assert.equal(listing.cert,'129395238');assert.equal(listing.ask,50);
  const shard=JSON.parse(read('public/data/cc/129.json'));
  assert.equal(shard.find(x=>x.cert===listing.cert).ask,listing.ask);
  assert.equal(D.certs.some(c=>c.cert===listing.cert),false);
});
test('existing pilot transition has no wallet or transaction implementation',()=>{
  const section=page.split('function borrowingPilot()')[1].split('const SG=')[0];
  for(const s of ['109308847','token #1 only','Chain ID 4663','0xa4a98F8A373E98Ce555a7F6e1FF2094C858D8F23','Not confirmed','ShjZm8cE'])assert.ok(section.includes(s),s);
  assert.doesNotMatch(section,/ethereum\.request|sendTransaction|approve\(|borrow\(/);
});
test('actual saved Rayquaza PDF uses sold basis, events and honest provenance',()=>{
  const c=JSON.parse(read('src/certs.json'))[0];
  const doc=buildMarkPdf(jsPDF,c,{},Date.now());
  const text=doc.output();
  assert.equal(doc.getNumberOfPages(),1);
  assert.match(text,/^%PDF/);
  assert.equal(c.ev[0].chainId,46630,'saved Mark is testnet, not pilot mainnet');
  assert.ok(c.ev[0].tx);assert.equal(c.price_basis,'psa10-sold');
});
