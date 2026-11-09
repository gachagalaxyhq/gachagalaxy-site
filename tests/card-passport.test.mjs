import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const {cardPassport}=createRequire(import.meta.url)('../src/card-passport.js');
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');
const page=read('public/platform.html');
const D=JSON.parse(page.split('const D=')[1].split(';const $=')[0]);
const shard=JSON.parse(read('public/data/cc/109.json'));
test('saved Nidoking Passport preserves cert ask and absence of image/Mark without fixtures',()=>{
 const p=cardPassport('PSA','109863355',shard,D.certs);
 assert.equal(p.status,'saved');assert.equal(p.listings.length,1);assert.equal(p.listings[0].ask,2600);
 assert.equal(p.image,null);assert.equal(p.mark,null);assert.equal(p.cleanCheckStatus,'not_run_here');
 assert.equal(p.horizenExecution,'not_checked');assert.equal(p.physicalAuthenticity,'not_checked');
});
test('saved Rayquaza Passport reuses actual Mark and image without claiming payment or new check',()=>{
 const p=cardPassport('PSA','109308847',shard,D.certs);
 const m=D.certs.find(x=>x.cert==='109308847');assert.equal(p.mark,m);assert.equal(p.image,m.img);
 assert.equal(p.graderRecord,'not_checked');assert.equal(p.qrMatch,'not_checked');
 assert.equal(p.cleanCheckStatus,'not_run_here');assert.equal(p.paid,undefined);
});
test('missing malformed and different-grader sources do not become evidence',()=>{
 assert.equal(cardPassport('PSA','999999999',[],D.certs).status,'missing');
 assert.equal(cardPassport('CGC','109863355',shard,D.certs).status,'missing');
 assert.equal(cardPassport('PSA','109863355',[null],D.certs).status,'unavailable');
 assert.equal(cardPassport('PSA','bad',[],[]).status,'invalid');
});
test('Passport photo mapping requires exact grader cert title and grade, with no random fallback',()=>{
 const rows=JSON.parse(read('public/data/cc/278.json'));
 const p=cardPassport('PSA','27867218',rows,D.certs,D.passportImages);
 assert.equal(p.image,'https://d1xpxki1g4htqu.cloudfront.net/61X6G7mPFecoYaVDxampCLO1e4d658vjcS9jlkKQBcs');
 assert.equal(p.number,'77');assert.equal(p.listings[0].ask,1600);
 const map={'PSA|27867218':{image:'wrong',name:'Different card',grade:'MINT 9'}};
 assert.equal(cardPassport('PSA','27867218',rows,D.certs,map).image,null);
 assert.equal(cardPassport('CGC','27867218',rows,D.certs,D.passportImages).status,'missing');
});
async function render(cert,rows=shard,ok=true,changeRoute=false){
 const view={innerHTML:''},status={textContent:''},button={};const location={hash:'#/passport/PSA/'+cert,origin:'https://example.invalid'};
 const context=vm.createContext({D,V:view,cardPassport,journeyCopy:()=>'',esc:s=>String(s??'').replace(/</g,'&lt;').replace(/>/g,'&gt;'),money:n=>n==null?'—':'$'+n.toLocaleString('en-US'),setTab(){},location,window:{scrollTo(){}},navigator:{clipboard:{writeText:async()=>{}}},$:s=>s==='#passport-share'?button:status,fetch:async()=>{if(changeRoute){location.hash='#/cards';view.innerHTML='New route'}return{ok,json:async()=>rows}}});
 const start=page.indexOf('async function passport('),end=page.indexOf('const img=',start);
  vm.runInContext(page.slice(page.indexOf('function detailDate('),page.indexOf('async function catalogueDetail(')),context);
  vm.runInContext(page.slice(start,end),context);await vm.runInContext('passport("PSA","'+cert+'")',context);return{view,button,status};
}
test('Passport renders honest absent states and working share-link action',async()=>{
 const {view,button,status}=await render('109863355');
 for(const text of ['class="cimg"','No Gacha Mark in these records','No new check has been run','Live verification has not been performed','$2,600','/cleancheck?cert=109863355','not physical authentication'])assert.ok(view.innerHTML.includes(text),text);
 await button.onclick();assert.equal(status.textContent,'Passport link copied.');
});
test('Passport source failures preserve only separately bundled Mark evidence',async()=>{
 assert.match((await render('109863355',[],false)).view.innerHTML,/Saved listing source unavailable/);
 const html=(await render('109308847',[],false)).view.innerHTML;
 assert.match(html,/Listing data could not load/);assert.match(html,/View Gacha Mark/);
 assert.equal((await render('109863355',shard,true,true)).view.innerHTML,'New route');
});
test('Passport sources are escaped and invalid routes perform no lookup',async()=>{
 const row=shard.find(r=>r.cert==='109863355');const html=(await render(row.cert,[{...row,name:'<script>bad</script>'}])).view.innerHTML;
 assert.doesNotMatch(html,/<script>/);assert.match(html,/&lt;script&gt;/);
 assert.match((await render('bad')).view.innerHTML,/Invalid Passport cert ref/);
});
test('architecture copy and saved-only Passport handoffs are wired without live claims',()=>{
 assert.match(page,/if\(a==='passport'\)return passport/);assert.match(page,/Open Card Passport/);
 assert.match(page,/Live verification has not been performed by this page/);assert.match(page,/opening it does not run a check or issue a report/);
 assert.match(read('public/cleancheck.html'),/Open Card Passport · saved presentation/);
 assert.match(read('public/certificate.html'),/Where Passport fits/);
 assert.doesNotMatch(page,/__CARD_PASSPORT_JS__/);
});
