import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');

test('Price Check names the standalone page, metadata, navigation and accessible search',()=>{
 const html=read('public/check.html');
 assert.match(html,/<title>Price Check — graded Pokémon card sold prices \| Gacha Galaxy<\/title>/);
 assert.match(html,/<meta name="description" content="Price Check:/);
 assert.match(html,/<h1>Price Check<\/h1>/);
 assert.match(html,/aria-current="page">Price Check<\/a>/);
 assert.match(html,/role="search" aria-label="Price Check"/);
 assert.match(html,/aria-label="Card name for Price Check"/);
 assert.match(html,/<button id="go">Price Check<\/button>/);
 assert.doesNotMatch(html,/>Check a card<|<title>Check a|<button id="go">Check</);
 assert.match(html,/href="https:\/\/gachagalaxy.io\/check"/);
 assert.match(html,/fetch\('\/api\/check\?q='/);
 assert.match(html,/async function run\(q\)/);
 assert.match(html,/id="rgo" disabled/);
 assert.match(html,/Payments are inactive/);
});

test('pricing entry links use Price Check across source templates and rendered pages',()=>{
 for(const path of ['src/index.tpl.html','public/index.html','src/platform.tpl.html','public/platform.html','public/cleancheck.html','public/certificate.html','public/how-gacha-mark-works/index.html']){
  const html=read(path);
  assert.match(html,/href="\/check">Price Check/,path);
  assert.doesNotMatch(html,/href="\/check">(?:Price check|Free price check|Check a card)<\/a>/,path);
 }
 for(const path of ['public/check.html','src/platform.tpl.html','public/platform.html','public/how-gacha-mark-works/index.html']){
  assert.match(read(path),/Price Check/,path);assert.match(read(path),/Clean Check/,path);
 }
});

test('other products and generic check actions retain their identities',()=>{
 const clean=read('public/cleancheck.html');
 assert.match(clean,/<h1>Clean Check<\/h1>/);
 assert.match(clean,/<button type="submit" id="go">Check<\/button>/);
 for(const path of ['src/platform.tpl.html','public/platform.html']){
  const html=read(path);
  assert.match(html,/Card Passport/);
  assert.doesNotMatch(html,/Implementation note:|fixture preview remain/);
  assert.match(html,/if\(a==='borrowing-pilot'\)return borrowingPilot\(\)/);
  const header=html.split('<header class="top">')[1].split('<main>')[0];
  assert.doesNotMatch(header,/Collector Crypt|Pricing groups|Collector journey|Separate existing borrowing pilot/);
  assert.match(html,/Check your email/);
 }
 assert.match(read('src/passport.js'),/Price Passport engine/);
 assert.match(read('preview/passport.tpl.html'),/<title>Price Passport preview \(fixtures\)<\/title>/);
 assert.match(read('public/certificate.html'),/internal Price Passport calculator/);
});
