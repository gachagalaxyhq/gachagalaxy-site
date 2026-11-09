import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');
test('Clean Check is explicitly free basic evidence, not authenticity or a paid upsell gate',()=>{
 const html=read('public/cleancheck.html');
 assert.match(html,/Clean Check is a free basic check showing available evidence/);
 assert.match(html,/PSA cert ref/);assert.match(html,/QR match is not authentication|cannot authenticate a physical slab/);
 assert.match(html,/QR-to-cert match: not_checked/);assert.match(html,/Physical authenticity: not_checked/);
 assert.match(html,/Gacha Mark is a separate paid service for a timestamped evidence report\/record/);
 assert.match(html,/Payments are currently unavailable/);
});
test('paid positioning is consistent without implying new fulfilment',()=>{
 for(const path of ['public/check.html','public/certificate.html','public/platform.html','public/how-gacha-mark-works/index.html']){
  const html=read(path);
  assert.match(html,/paid service for a timestamped evidence report\/record/,path);
  assert.match(html,/Payments are currently unavailable/,path);
  assert.match(html,/intake.*unavailable|intake database contract.*unverified/,path);
 }
 const html=read('public/certificate.html');
 assert.doesNotMatch(html,/Usually within one working day|The certificate is checked|Yes, PSA and CGC|Request a Gacha Mark<\/a>/);
 assert.match(html,/A QR match does not authenticate a physical slab/);
 assert.match(html,/does not show that a customer paid/);
});
test('previous published pricing is labelled historical and not offered, never made into checkout',()=>{
 const html=read('public/certificate.html');
 for(const amount of ['$9','$49','$199'])assert.ok(html.includes(amount));
 assert.match(html,/previously published single-card price · not orderable/);
 assert.match(html,/previously published ten-mark price · not offered/);
 assert.match(html,/previously published annual dealer price · not offered/);
 assert.doesNotMatch(html,/href=["'][^"']*(?:checkout|stripe|pay\.)/);
});
test('first-ten-free request policy and backend contract remain intact, not a per-person entitlement',()=>{
 const api=read('functions/api/mark-request.js');
 assert.match(api,/const FREE_LIMIT = 10;/);
 // V2 keeps the ten-request candidate limit in SQL, not a caller-controlled RPC argument.
 assert.doesNotMatch(api,/p_limit:/);
 const migration=read('supabase/migrations/20261107_mark_intake_v2.sql');
 assert.match(migration,/free_limit = 10/);assert.match(migration,/approved boolean not null default false/);
 assert.match(api,/free: d.free/);assert.match(api,/const INTAKE_AVAILABLE = false/);
 const html=read('public/certificate.html');
  assert.match(html,/first-ten-free request allowance/);assert.match(html,/not a per-person promise/);
  assert.match(html,/existing complimentary request allowance preserved/);
  assert.doesNotMatch(html,/needs a policy decision|plain Gacha Marks are free/);
 assert.match(read('public/check.html'),/first-ten-free request policy is unchanged/);
});
test('monitoring and bulk remain future options, with no availability promise',()=>{
 for(const path of ['public/check.html','public/cleancheck.html','public/certificate.html']){
  const html=read(path);assert.match(html,/Future options/);assert.match(html,/Monitoring or bulk checks could become paid services later/);
  assert.match(html,/not currently offered/);assert.doesNotMatch(html,/>Subscribe|>Buy bulk|>Start monitoring/);
 }
});
test('My Collection cannot bypass closed intake and no longer promises universally free Marks',()=>{
 const html=read('public/platform.html');
 assert.doesNotMatch(html,/Plain Gacha Marks are free|from\('mark_requests'\)\.insert|from\('mark_requests'\)\.delete/);
 assert.match(html,/Paid Mark · intake unavailable/);
 assert.match(html,/Prior records and request statuses are preserved/);
});
test('Price Check gates intake on handler availability and the public home keeps basic Clean Check free',()=>{
 const html=read('public/check.html');assert.match(html,/id="rgo" disabled/);
 const intake=html.split('var rqEl=')[1];
 assert.match(intake,/var available=false,pending=false/);
 assert.match(intake,/d\.intakeStatus==='available'/);
 assert.match(intake,/go2\.disabled=pending\|\|!available/);
 assert.doesNotMatch(intake,/createElement|\.href\s*=\s*d\.payUrl/);
 for(const path of ['src/index.tpl.html','public/index.html']){
  const home=read(path);assert.doesNotMatch(home,/Run a Clean Check or a Gacha Mark/);
  assert.match(home,/Clean Check is a free basic check of available evidence/);
 }
});
