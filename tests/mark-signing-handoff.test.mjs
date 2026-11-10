// Offline UI/receipt logic tests. Fixtures below are synthetic tests only;
// never exported as issuance records, receipts, or chain evidence.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {ethers} from 'ethers';
// operations/mark-signing.html is a generated, gitignored artifact (removed from the public release
// in c7fd311). Build the same page in memory from the tracked template + prepared batch exactly as
// scripts/build_mark_signing_handoff.py does, without writing the artifact back to disk.
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');
const batch=JSON.parse(read('data/additional-mark-preparation.json'));
assert.equal(batch.records.length,6);assert.equal(batch.actual_new_issuance,0);
const payload={chain:batch.chain,validation:{...batch.readonly_chain_validation},records:batch.records};
delete payload.validation.complete_event_history;
// Python json.dumps(ensure_ascii=True) equivalent for the embedded batch.
const embedded=JSON.stringify(payload).replace(/[\u007f-\uffff]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0')).replaceAll('</','<\\/');
const template=read('operations/mark-signing.template.html');
assert.ok(template.includes('/* EMBED_BATCH */null'));
const html=template.replace('/* EMBED_ETHERS */',()=>'').replace('/* EMBED_BATCH */null',()=>embedded);
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
