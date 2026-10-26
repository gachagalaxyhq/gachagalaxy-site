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
