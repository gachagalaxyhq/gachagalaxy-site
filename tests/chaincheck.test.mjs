import test from 'node:test';import assert from 'node:assert';import {createRequire} from 'module';
const {ccEncode,ccDecode,ccCompare,ccRead}=createRequire(import.meta.url)('../src/chaincheck.js');
const REG='0x2A585396dd0248A060045b3f557076fB1B4Cb0eb';
test('encoding matches ethers for PSA/111992917',async()=>{
 let e;try{e=(await import('ethers')).ethers}catch{return}
 const i=new e.Interface(['function getAppraisalByCert(string,string)']);assert.equal(ccEncode('PSA','111992917'),i.encodeFunctionData('getAppraisalByCert',['PSA','111992917']))});
test('compare: exact cents match, mismatch named',()=>{
 const ch={low:24902,point:27500,high:30098,appraisedAt:1792306121};
 assert.deepEqual(ccCompare({low:249.02,point:275,high:300.98,published:'2026-10-18T06:48:41Z'},ch),{k:'match'});
 assert.deepEqual(ccCompare({low:249.02,point:280,high:300.98},ch),{k:'mismatch',diffs:['Value point']});
 assert.deepEqual(ccCompare({low:1,point:1,high:1},{appraisedAt:0}),{k:'missing'})});
test('decode rejects short data',()=>assert.equal(ccDecode('0x'),null));
test('live read: 6 certs match chain, unknown cert missing',{skip:!process.env.LIVE},async()=>{
 const want={'100863346':[1215.61,1331,1446.39],'111992917':[249.02,275,300.98],'154790134':[524.03,650,775.97]};
 for(const [id,[l,p,h]] of Object.entries(want)){const ch=await ccRead(46630,REG,'PSA',id);assert.equal(ccCompare({low:l,point:p,high:h},ch).k,'match',id)}
 assert.equal(ccCompare({low:1,point:1,high:1},await ccRead(46630,REG,'PSA','999')).k,'missing')});

// Mainnet MarkRegistry: words captured from the deployed bytecode (copied into a local node) after publish / revoke.
const MK='0xc427A992f0460b86744e9a6E24Cd242770D240d8';
const W=(...a)=>'0x'+a.map(x=>BigInt(x).toString(16).padStart(64,'0')).join('');
const OPR='0x85c94037d1e373c4995926dd8161c7aa912045f1';
test('mainnet registry is detected and uses getMark',async()=>{
 assert.equal(require2().ccKind(4663,MK),'mark');assert.equal(require2().ccKind(46630,REG),'appraisal');
 let e;try{e=(await import('ethers')).ethers}catch{return}
 const i=new e.Interface(['function getMark(string,string)']);assert.equal(ccEncode('PSA','111992917',require2().CC_SEL_MARK),i.encodeFunctionData('getMark',['PSA','111992917']))});
test('mainnet decode + compare: match, mismatch, revoked, missing',()=>{
 const {ccDecodeMark}=require2();
 const live=ccDecodeMark(W(27500,10,0,1793027087,OPR));
 assert.deepEqual(live,{point:27500,grade:10,revoked:false,appraisedAt:1793027087,attester:OPR});
 const pub=new Date(1793027087*1000).toISOString();
 assert.deepEqual(ccCompare({low:249.02,point:275,high:300.98,grade:'PSA 10',published:pub},live),{k:'match'});
 assert.deepEqual(ccCompare({point:280,grade:'PSA 9',published:pub},live),{k:'mismatch',diffs:['Value point','Grade']});
 assert.deepEqual(ccCompare({point:275},ccDecodeMark(W(27500,10,1,1793027087,OPR))),{k:'revoked'});
 assert.deepEqual(ccCompare({point:275},ccDecodeMark(W(0,0,0,0,0))),{k:'missing'});
 assert.equal(ccDecodeMark('0x'),null)});
test('mainnet ccRead sends getMark to the mainnet RPC',async()=>{
 let sent;const f=async(u,o)=>{sent={u,b:JSON.parse(o.body)};return {json:async()=>({result:W(27500,10,0,1793027087,OPR)})}};
 const ch=await ccRead(4663,MK,'PSA','111992917',f);
 assert.equal(sent.u,'https://rpc.mainnet.chain.robinhood.com');assert.ok(sent.b.params[0].data.startsWith('0xabced0a8'));assert.equal(ch.point,27500)});
function require2(){return createRequire(import.meta.url)('../src/chaincheck.js')}
