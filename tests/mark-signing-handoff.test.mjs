// Offline UI/receipt logic tests. Fixtures below are synthetic tests only;
// never exported as issuance records, receipts, or chain evidence.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {parseHTML} from '/tmp/opencode/catalogue-test-deps/node_modules/linkedom/esm/index.js';
import {ethers} from '/tmp/opencode/pub/node_modules/ethers/lib.esm/index.js';
const html=fs.readFileSync(new URL('../operations/mark-signing.html',import.meta.url),'utf8');
const {document}=parseHTML(html);
const code=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][1][1];
const context=vm.createContext({document,window:{},ethers,console,Blob,URL,setTimeout});
vm.runInContext(code,context);
assert.equal(document.querySelectorAll('.card').length,6);
assert.equal(document.querySelectorAll('[data-sign]:disabled').length,6);
assert.match(document.querySelector('#global').textContent,/No wallet connected/);
vm.runInContext(`
 const fixture=BATCH.records[0];
 const event=iface.encodeEventLog(iface.getEvent('AppraisalPublished'),[fixture.contract_proposal.cert_key,...fixture.contract_proposal.args.slice(0,6),fixture.contract_proposal.args[8],0,false,ATTESTER]);
 const good={status:'0x1',logs:[{address:REG,topics:event.topics,data:event.data}]};
 verifyEvent(fixture,good);
 verifyTransaction(fixture,{to:REG,from:ATTESTER,value:'0x0',input:fixture.contract_proposal.unsigned_transaction.data,chainId:'0xb626'});
 globalThis.fixture=fixture;globalThis.good=good;
`,context);
for(const snippet of [
 `verifyEvent(fixture,{...good,status:'0x0'})`,
 `verifyEvent(fixture,{status:'0x1',logs:[]})`,
 `verifyEvent(BATCH.records[1],good)`,
 `verifyEvent(fixture,{...good,logs:[...good.logs,...good.logs]})`,
 `verifyTransaction(fixture,{to:REG,from:ATTESTER,value:'0x1',input:fixture.contract_proposal.unsigned_transaction.data})`,
 `verifyTransaction(fixture,{to:REG,from:ATTESTER,value:'0x0',input:'0x'})`,
 `verifyTransaction(fixture,{to:ATTESTER,from:ATTESTER,value:'0x0',input:fixture.contract_proposal.unsigned_transaction.data})`,
])assert.throws(()=>vm.runInContext(snippet,context));
await vm.runInContext('connect()',context);
assert.match(document.querySelector('#global').textContent,/No injected wallet/);
assert.equal(document.querySelectorAll('[data-sign]:disabled').length,6);
assert(!/localStorage|sessionStorage|Wallet\(|privateKey|eth_sendRawTransaction|wallet_addEthereumChain/.test(code));
assert.equal((code.match(/method:'eth_sendTransaction'/g)||[]).length,1);
assert(!html.includes('/* EMBED_BATCH */null'));
console.log('PASS: six cards; fixed ABI/calldata; wrong receipt, event, value, destination rejected; no-wallet signing disabled. No real wallet or transaction used.');
