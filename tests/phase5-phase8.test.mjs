import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const root=path.resolve(new URL('..',import.meta.url).pathname);
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const template=read('src/platform.tpl.html');
const {cardPassport,passportSourceUrl}=createRequire(import.meta.url)('../src/card-passport.js');
const existing=read('public/platform.html');
const D=JSON.parse(existing.split('const D=')[1].split(';const $=')[0]);
// Reuse published values and assets; inject current owned source, never run render.py.
D.certs=JSON.parse(read('src/certs.json'));
const scannerCode=template.slice(template.indexOf('const SG='),template.indexOf('const API=[]'));
const listing=(ask,gap,grade='PSA 10',market='Collector Crypt',decoded=true)=>[market,grade,ask,100,gap,'123456',decoded,'saved-id'];
const group=(i,L,extra={})=>({i,cn:'Rayquaza VMAX',cl:'Evolving Skies · #218',no:'218',g:'PSA 10',se:true,L,...extra});
function scan(cards,...args){const ctx=vm.createContext({decodedGroups:()=>cards,Number});vm.runInContext(scannerCode,ctx);ctx.args=args;return vm.runInContext('scanRows(...args)',ctx);}

test('scanner combines search, market, grader, grade and direction before selecting a group row',()=>{
 const cards=[group(1,[listing(80,-20),listing(140,40)]),group(2,[listing(70,-30,'CGC 9')],{cn:'Eevee',cl:'Promo · #173'})];
 assert.equal(scan(cards,'','','')[1][0][1][2],140);
 assert.equal(scan(cards,'Collector Crypt','PSA','10','rayquaza 218','below')[0][0][1][2],80);
 assert.equal(scan(cards,'','','','eevee','below')[0][0][0].i,2);
 for(const args of [['Elsewhere','',''],['','BGS',''],['','','8'],['','','','missing'],['','PSA','9']])assert.equal(scan(cards,...args).flat().length,0);
 assert.equal(scan(cards,'','','','','above')[0].length,0);
});
test('scanner preserves selection thresholds, largest absolute gap, sort and ten-row caps',()=>{
 const invalid=[listing(19,-81),listing(120,0),listing(400,300),listing(90,-10,'PSA 7'),listing(90,-10,'PSA 10','Collector Crypt',false),listing(90,NaN),[...listing(90,-10)].map((v,i)=>i===3?0:v)];
 assert.equal(scan([group(1,invalid)],'','','').flat().length,0);
 const cards=Array.from({length:15},(_,i)=>group(i,[listing(80,-20-i),listing(130,30+i)]));
 const both=scan(cards,'','','');assert.equal(both[0].length,0);assert.equal(both[1].length,10);assert.equal(both[1][0][0].i,14);
 const below=scan(cards,'','','','','below');assert.equal(below[0].length,10);assert.equal(below[0][0][0].i,14);
});
test('Passport cert validation is 6–13 digits in both owned files',()=>{
 for(const size of [6,10,11,12,13])assert.equal(cardPassport('CGC','1'.repeat(size),[],[]).status,'missing');
 for(const cert of ['12345','1'.repeat(14),'123456x',' 123456'])assert.equal(cardPassport('PSA',cert,[],[]).status,'invalid');
 assert.ok(template.includes("!/^\\d{6,13}$/.test(cert||'')"));
 assert.ok(template.includes("grader==='PSA'?(D.oc.events||{})[cert]:[]"),'cert-only legacy history cannot attach to another grader');
});
test('Passport source links require an explicit public HTTPS URL and preserve source data',()=>{
 for(const value of ['javascript:alert(1)','data:text/html,x','//collectorcrypt.com/a','http://collectorcrypt.com/a','https://user:pass@collectorcrypt.com/a','https://localhost/a','https://127.0.0.1/a','https://[::1]/a','https://private.local/a','https://collectorcrypt.com:8443/a','https://collectorcrypt.com/\nunsafe','https://collectorcrypt.com\\@evil.com/a'])assert.equal(passportSourceUrl(value),null,value);
 const row={cert:'1234567890123',grader:'CGC',name:'Saved card',ask:123,source_url:'https://collectorcrypt.com/listing/saved'};
 const before=JSON.stringify(row);const p=cardPassport('CGC',row.cert,[row],[]);
 assert.equal(p.listingSources[0].url,row.source_url);assert.equal(p.listings[0],row);assert.equal(JSON.stringify(row),before);
 assert.equal(cardPassport('CGC',row.cert,[{...row,source_url:undefined,nft:'not-a-url'}],[]).listingSources[0].url,null);
});
test('owned changes leave shared design, sign-in, routes, animations and embedded assets intact',()=>{
 for(const [start,end] of [['<style>','</style>'],['function collection(','function watchlist('],['function route()','</script><script>']]){
  assert.equal(template.slice(template.indexOf(start),template.indexOf(end,template.indexOf(start))),existing.slice(existing.indexOf(start),existing.indexOf(end,existing.indexOf(start))),start);
 }
 const images=text=>text.match(/data:image\/[^\s"<>]+/g)||[];
 const originalImages=images(existing);for(const image of images(template))assert.ok(originalImages.includes(image),'embedded asset retained verbatim');
 assert.equal(D.certs.length,18);assert.doesNotMatch(template,/if\(a==='(?:borrow|borrowing)'/);
 assert.match(template,/payments remain inactive/);
});

test('current owned source passes isolated Chromium scanner and Passport interactions',async t=>{
 const browserCache=path.join(os.homedir(),'.cache/ms-playwright');
 const cached=fs.existsSync(browserCache)?fs.readdirSync(browserCache).filter(name=>name.startsWith('chromium-')).map(name=>path.join(browserCache,name,'chrome-linux64/chrome')):[];
 const chromium=[process.env.CHROMIUM_BIN,...cached,'/usr/bin/chromium','/usr/bin/chromium-browser'].filter(Boolean).find(file=>fs.existsSync(file));
 if(!chromium){t.skip('No installed Chromium; pure scanner/model tests still ran');return;}
 const probe=`<script>(async()=>{const out={errors:[]};const check=(ok,label)=>{if(!ok)out.errors.push(label)};window.addEventListener('error',e=>out.errors.push(e.message));window.addEventListener('unhandledrejection',e=>out.errors.push(String(e.reason)));try{
 const copied=[];Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>copied.push(value)}});
 await new Promise(r=>setTimeout(r,150));
 check(document.querySelector('#scanner-query'),'scanner search');
 document.querySelector('#scanner-query').value='no such card xyz';document.querySelector('#scanner-search').requestSubmit();
 check(document.querySelector('#view').textContent.includes('No saved pricing groups match'),'search empty state');
 document.querySelector('#scanner-reset').click();
 const direction=document.querySelector('#scanner-direction');direction.value='below';direction.dispatchEvent(new Event('change'));
 check(!Array.from(document.querySelectorAll('#view h2')).some(el=>el.textContent==='Above saved reference'),'direction filter');
 check(document.querySelector('#view').textContent.includes('Listing date: unknown'),'unknown row dates');
 const gap=document.querySelector('.sc details');check(gap,'row explanation');if(gap){gap.open=true;check(gap.textContent.includes('not a same-certificate comparison'),'comparison identity');}
 out.scannerRows=document.querySelectorAll('.sc tbody tr').length;
 for(const cert of ['109863355','109308847','110153218']){
 location.hash='#/passport/PSA/'+cert;await new Promise(r=>setTimeout(r,250));
 const article=document.querySelector('.passport-detail');check(article,'Passport '+cert);if(!article)continue;
 check(article.querySelectorAll('.btn-p').length===1,'one primary share action '+cert);
 if(cert==='109863355')check(article.textContent.includes('$2,600')&&article.textContent.includes('No Gacha Mark in these records'),'saved ask and absent Mark');
 if(cert==='109308847'){
 check(article.textContent.includes('Existing Mark publication history'),'publication history');
 check(article.querySelectorAll('ol li').length===6,'all six existing events');
 check(article.textContent.includes('$1,900')&&article.textContent.includes('Unknown — not supplied'),'existing value and unknown observation date');
 check(!article.textContent.includes('Gacha Mark reference:'),'no duplicate ambiguous price reference');
 }
 if(cert==='110153218')check(article.textContent.includes('Available saved QR evidence')&&article.textContent.includes('6 Nov 2026'),'dated saved evidence');
 check(!article.textContent.includes('javascript:'),'no unsafe source links');
 if(article.querySelector('.passport-price'))check(article.textContent.includes('External listing link not supplied'),'source link absence');
 await document.querySelector('#passport-share').onclick();
 check(document.querySelector('#passport-share-status').textContent==='Passport link copied.','share result');
 check(copied.at(-1).endsWith('/platform?saved=1#/passport/PSA/'+cert),'copied canonical saved link');
 if(cert==='109863355'){
 Object.defineProperty(navigator,'clipboard',{configurable:true,value:undefined});await document.querySelector('#passport-share').onclick();
 check(document.querySelector('#passport-share-status').textContent.includes('Copy unavailable'),'clipboard fallback');
 Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>copied.push(value)}});
 }
 }
 out.markCount=D.certs.length;check(D.certs.length===18,'18 Marks preserved');
 out.viewport={width:innerWidth,scrollWidth:document.documentElement.scrollWidth};
 check(document.documentElement.scrollWidth<=innerWidth,'no horizontal page overflow');
 }catch(e){out.errors.push(e.stack)}
 const pre=document.createElement('pre');pre.id='phase58-result';pre.textContent=JSON.stringify(out);document.body.append(pre);
 })();</script>`;
 let page=template.replace('__CC_DATA__',JSON.stringify(D)).replace('__UPDATED__','6 Nov 2026, 06:57 UTC');
 for(const [marker,file] of [['__CARD_PASSPORT_JS__','card-passport.js'],['__CATALOGUE_JS__','catalogue.js'],['__CHAINCHECK_JS__','chaincheck.js'],['__MARKPDF_JS__','markpdf.js']])page=page.replace(marker,()=>read('src/'+file));
 // Chromium's desktop window has a 500px minimum; use a real 390px iframe for narrow inspection.
 page=page.replace('</body>',probe+'</body>');
 const requests=[];
 const server=http.createServer((req,res)=>{
  requests.push(req.url);res.setHeader('Content-Security-Policy',"default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self' data:");
  const pathname=new URL(req.url,'http://localhost').pathname;
  if(pathname==='/narrow'){res.setHeader('Content-Type','text/html');res.end('<iframe style="border:0;width:390px;height:1000px" src="/platform?saved=1#/scanner"></iframe><script>const timer=setInterval(()=>{const result=document.querySelector("iframe").contentDocument.querySelector("#phase58-result");if(result){document.body.append(result.cloneNode(true));clearInterval(timer)}},50)</script>');return;}
  if(pathname==='/platform'){res.setHeader('Content-Type','text/html');res.end(page);return;}
  if(pathname.startsWith('/api/')){res.writeHead(503);res.end('{}');return;}
  const file=path.resolve(root,'public','.'+pathname);
  if(!file.startsWith(path.join(root,'public')+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);res.end();return;}
  res.setHeader('Content-Type',file.endsWith('.json')?'application/json':file.endsWith('.js')?'text/javascript':file.endsWith('.webp')?'image/webp':'application/octet-stream');fs.createReadStream(file).pipe(res);
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 for(const width of [1280,390]){
  const profile=fs.mkdtempSync(path.join(os.tmpdir(),'phase58-browser-'));
  try{
   const result=await new Promise((resolve,reject)=>{
    const child=spawn(chromium,['--headless','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--no-proxy-server','--disable-background-networking','--disable-component-update','--disable-sync','--disable-extensions','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', '--user-data-dir='+profile,'--window-size='+width+',1000','--virtual-time-budget=6000','--dump-dom',`http://127.0.0.1:${server.address().port}/${width===390?'narrow':'platform?saved=1#/scanner'}`]);
    let stdout='',stderr='';child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);
    const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('Chromium inspection timed out'))},30000);
    child.on('error',reject);child.on('close',code=>{clearTimeout(timer);resolve({code,stdout,stderr})});
   });
   assert.equal(result.code,0,result.stderr.slice(-1500));
   const match=/<pre id="phase58-result">([\s\S]*?)<\/pre>/.exec(result.stdout);
   assert.ok(match,'Browser probe completed at width '+width);
   const report=JSON.parse(match[1].replace(/&quot;/g,'"').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>'));
   assert.equal(report.viewport.width,width,'inspection uses the requested CSS viewport width');
   assert.deepEqual(report.errors,[],JSON.stringify(report));t.diagnostic(JSON.stringify({width,...report}));
  }finally{fs.rmSync(profile,{recursive:true,force:true});}
 }
 assert.equal(requests.filter(url=>url.startsWith('/api/')).length,0,'No API requests in saved inspection');
});
