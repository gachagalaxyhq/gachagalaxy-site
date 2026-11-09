import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');
const page=read('public/platform.html');
const D=JSON.parse(page.split('const D=')[1].split(';const $=')[0]);

test('affected featured cards and filmed catalogue card use exact checked-in local images',()=>{
 const catalogue=JSON.parse(read('data/cc.json')).cards;
 for(const id of [222,225,7]){
  const c=D.cards.find(c=>c.i===id),source=catalogue[id-1];
  assert.equal(c.im,'/cards/'+source.id+'.webp');
  const bytes=fs.readFileSync(new URL('../public'+c.im,import.meta.url));
  assert.equal(bytes.subarray(0,4).toString(),'RIFF');
  assert.equal(bytes.subarray(8,12).toString(),'WEBP');
 }
 assert.doesNotMatch(read('scripts/render.py'),/https:\/\/gachagalaxy-site.pages.dev\/(cards|assets)\//);
});

test('image load failure becomes accessible unavailable text without replacement imagery',()=>{
 const handlers={};let replacement;
 const context=vm.createContext({V:{addEventListener(type,fn,capture){handlers[type]=fn;assert.equal(capture,true)}},
  document:{createElement(){return {setAttribute(k,v){this[k]=v}}}}});
 vm.runInContext(page.slice(page.indexOf('function imageUnavailable('),page.indexOf('function band(')),context);
 handlers.error({target:{tagName:'IMG',className:'cimg',alt:'Actual saved slab',replaceWith(el){replacement=el}}});
 assert.equal(replacement.textContent,'Image unavailable');assert.equal(replacement.role,'img');
 assert.equal(replacement['aria-label'],'Actual saved slab: image unavailable');
 assert.equal(replacement.src,undefined);assert.match(replacement.className,/cimg/);
 assert.match(page,/image-unavailable[^}]*font-size:9px/);
});

test('public own evidence is only named dated bundled Marks, with no collection or requester data',()=>{
 const own=JSON.parse(read('public/data/own-claims.json')),marks=JSON.parse(read('src/certs.json'));
 assert.equal(own.length,marks.length);
 for(const row of own){
  const m=marks.find(m=>m.cert===row.cert&&m.grader===row.grader);
  assert.ok(m);assert.equal(row.source,'mark');assert.equal(row.owner,'Gacha Galaxy (marked)');
  assert.equal(row.card,[m.name,m.num].filter(Boolean).join(' '));
  assert.equal(row.when,m.ev.map(e=>e.t).sort().at(-1));
 }
 assert.doesNotMatch(JSON.stringify(own),/"source":"collection"|"source":"request"|"email"|"reason"/);
});

test('allowance copy preserves policy without promising availability or ten reports per person',()=>{
 for(const p of ['public/check.html','public/certificate.html','src/platform.tpl.html','public/platform.html']){
  const h=read(p);assert.match(h,/complimentary/);assert.match(h,/first-ten-free request/);
  assert.doesNotMatch(h,/Earlier blanket-free|needs a policy decision/);
 }
 assert.match(read('functions/api/mark-request.js'),/const FREE_LIMIT = 10;/);
 assert.match(read('functions/api/mark-request.js'),/const INTAKE_AVAILABLE = false;/);
 assert.match(read('functions/api/stripe-webhook.js'),/const PAYMENTS_AVAILABLE = false;/);
});
