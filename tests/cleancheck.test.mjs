import test from 'node:test';import assert from 'node:assert';import {createRequire} from 'module';
const {cleanCheck,ccCert,ccDigitDiff}=createRequire(import.meta.url)('../src/cleancheck.js');
test('cert normalising',()=>{assert.equal(ccCert(' 111-992-917 '),'111992917');assert.equal(ccCert('abc'),null);assert.equal(ccCert('1234'),null)});
test('digit diff: two-digit pair is 2 digits',()=>{assert.equal(ccDigitDiff('12345678','32345668'),2);assert.equal(ccDigitDiff('1','12'),Infinity)});
test('clean data: no flags',()=>{const r=cleanCheck([{source:'marks',cert:'111992917',card:'Umbreon VMAX',grade:'PSA 10'},{source:'collection',cert:'111992917',owner:'u1'}]);
 assert.equal(r.checked,1);assert.deepEqual(r.flags,[])});
test('multi_owner across sources',()=>{const r=cleanCheck([{source:'collection',cert:'109308847',owner:'u1'},{source:'mark_requests',cert:'109308847',owner:'u2'}]);
 assert.equal(r.flags[0].kind,'multi_owner');assert.deepEqual(r.flags[0].owners.sort(),['u1','u2'])});
test('same owner twice is not a flag',()=>assert.deepEqual(cleanCheck([{source:'collection',cert:'5',owner:'u1'},{source:'collection',cert:'280293',owner:'u1'},{source:'mark_requests',cert:'280293',owner:'u1'}]).flags,[]));
test('identity_conflict on grade or card',()=>{const r=cleanCheck([{source:'marks',cert:'100863346',card:'Lugia V',grade:'PSA 10'},{source:'x',cert:'100863346',card:'Lugia V',grade:'9'}]);
 assert.equal(r.flags[0].kind,'identity_conflict');assert.deepEqual(r.flags[0].grades,[10,9])});
test('near_cert only when the card matches',()=>{
 const a={source:'a',cert:'12345678',card:'Example Holo #9'},b={source:'b',cert:'32345668',card:'example holo 9'};
 assert.equal(cleanCheck([a,b]).flags[0].kind,'near_cert');
 assert.deepEqual(cleanCheck([a,{...b,card:'Charizard'}]).flags,[]);
 assert.deepEqual(cleanCheck([a,{...b,cert:'45821000'}]).flags,[])});
test('graders kept apart',()=>assert.deepEqual(cleanCheck([{grader:'PSA',cert:'123456',owner:'u1'},{grader:'CGC',cert:'123456',owner:'u2'}]).flags,[]));
test('invalid certs counted, not flagged',()=>{const r=cleanCheck([{cert:'n/a'},{cert:''}]);assert.equal(r.invalid,2);assert.equal(r.checked,0)});
test('same-batch neighbours are not near_cert',()=>assert.deepEqual(cleanCheck([{cert:'6100000017',card:'Example Card 29'},{cert:'6100000013',card:'Example Card 29'}]).flags,[]));
test('moved_chain vs same-chain duplicate',()=>{
 const m=cleanCheck([{cert:'100000002',owner:'a',chain:'solana'},{cert:'100000002',owner:'b',chain:'robinhood'}]);assert.equal(m.flags[0].kind,'moved_chain');
 const d=cleanCheck([{cert:'100000001',owner:'a',chain:'solana'},{cert:'100000001',owner:'b',chain:'solana'}]);assert.equal(d.flags[0].kind,'multi_owner');
 const x=cleanCheck([{cert:'100000001',owner:'a',chain:'solana'},{cert:'100000001',owner:'b',chain:'solana'},{cert:'100000001',owner:'c',chain:'base'}]);assert.equal(x.flags[0].kind,'multi_owner')});
test('our Mark of a partner listing is not a duplicate',()=>{
 assert.deepEqual(cleanCheck([{source:'partner',cert:'109308847',owner:'p:1',chain:'solana'},{source:'marks',cert:'109308847'},{source:'collection',cert:'109308847',owner:'u1'}]).flags,[]);
 assert.equal(cleanCheck([{source:'partner',cert:'109308847',owner:'p:1',chain:'solana'},{source:'partner',cert:'109308847',owner:'p:2',chain:'solana'},{source:'marks',cert:'109308847'}]).flags[0].kind,'multi_owner')});
