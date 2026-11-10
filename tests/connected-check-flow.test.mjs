import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import http from 'node:http';
import {createRequire} from 'node:module';

// Closed local fixtures: no provider, intake, chain or external network requests.
const root=new URL('../',import.meta.url);
const read=p=>fs.readFileSync(new URL(p,root),'utf8');
const html={check:read('public/check.html'),cleancheck:read('public/cleancheck.html')};
const listing=JSON.parse(read('public/data/cc/109.json')).find(c=>c.cert==='109863355'&&c.grader==='PSA');
const own=JSON.parse(read('public/data/own-claims.json'));
const sold={name:'Rayquaza & "VMAX" <test>',set:'Evolving Skies / #?&',number:'218/203',psa10:{median:1234.56,min:999.01,max:2000.99,n:2,last:'2026-01-02',updated:'2026-01-03',sources:{eBay:2}}};
const settle=()=>new Promise(resolve=>setImmediate(resolve));
async function boot(name,search='',{records=[],rows=[listing],failOwn=false,failCC=false,cards=[sold]}={}){
  const elements=new Map(),calls=[],history=[];
  function el(id){if(!elements.has(id))elements.set(id,{value:'',innerHTML:'',textContent:'',hidden:false,disabled:false,events:{},addEventListener(k,fn){this.events[k]=fn},focus(){},removeAttribute(k){delete this[k]}});return elements.get(id)}
  const context=vm.createContext({document:{querySelector:s=>el(s.slice(1)),getElementById:el},location:{search,hash:''},window:{addEventListener(){}},URLSearchParams,history:{replaceState(_a,_b,path){history.push(path)}},fetch:async(url,opts)=>{
    calls.push([url,opts]);assert.equal(opts?.method,undefined,'test must never submit a request');
    let data={},ok=true;
    if(url.startsWith('/api/check?'))data={cards};
    else if(url==='/api/mark-request'){data={ok:false,intakeStatus:'unavailable',paymentStatus:'inactive',payUrl:null};ok=false}
    else if(url==='/data/own-claims.json'){data=records;ok=!failOwn}
    else if(/^\/data\/cc\/\d{3}\.json$/.test(url)){data=rows;ok=!failCC}
    else if(url==='/data/cc/index.json')data={certs:1};
    else throw new Error('Unexpected request '+url);
    return {ok,status:ok?200:503,json:async()=>data};
  }});
  for(const script of html[name].matchAll(/<script>([\s\S]*?)<\/script>/g))vm.runInContext(script[1],context);
  await settle();return {el,calls,history,context};
}

test('Price Check carries encoded identity and known grade, never cert or provider pricing',async()=>{
  const original=JSON.stringify(sold),b=await boot('check','?q=Rayquaza');
  const h=b.el('out').innerHTML;
  const href=h.match(/class="certificate-action" href="([^"]+)"/)[1].replaceAll('&amp;','&');
  const url=new URL(href,'https://local.invalid');
  assert.equal(url.pathname,'/cleancheck');
  for(const [key,value] of Object.entries({name:sold.name,set:sold.set,number:sold.number,grade:'PSA 10'}))assert.equal(url.searchParams.get(key),value);
  assert.deepEqual([...url.searchParams.keys()].sort(),['grade','name','number','set']);
  assert.doesNotMatch(h,/<test>|<img|cert=|mkt|smartMarketPrice/);
  assert.match(h,/Check this slab's certificate/);
  for(const text of ['$1,234.56','$999.01','$2,000.99','2 historical sales','Last sale 2026-01-02 UTC','Provider updated 2026-01-03 UTC','historical sold median','Basis: reported completed PSA 10 sales','separate dated evidence record'])assert.ok(h.includes(text),text);
  assert.match(h,/<details><summary>Sold-price source and sample<\/summary><p>Source: PokemonPriceTracker/);
  assert.equal(JSON.stringify(sold),original);
});
test('missing metadata and no PSA 10 sample are not silently invented',async()=>{
  const b=await boot('check','?q=Rayquaza',{cards:[{...sold,psa10:{...sold.psa10,last:null,updated:null,sources:null}},{...sold,psa10:null}]});
  const h=b.el('out').innerHTML;
  assert.match(h,/Last sale unknown/);assert.match(h,/Provider updated unknown/);assert.match(h,/Marketplaces: unknown/);
  assert.match(h,/sample, dates and basis unavailable/);
  const links=[...h.matchAll(/class="certificate-action" href="([^"]+)"/g)];
  assert.equal(links.length,2);assert.doesNotMatch(links[1][1],/grade=|cert=/);
});
test('context-only arrival leaves cert and grader unselected and runs no certificate lookup',async()=>{
  const b=await boot('cleancheck','?'+new URLSearchParams({name:'<img onerror=bad>',set:'Set & A',number:'1/2',grade:'PSA 10',certification:'109863355'}));
  assert.equal(b.el('cert').value,'');assert.equal(b.el('grader').value,'');
  assert.equal(b.el('context-identity').textContent,'<img onerror=bad> · Set & A · #1/2 · PSA 10');
  assert.equal(b.el('search-context').hidden,false);
  assert.equal(b.calls.some(([u])=>u.includes('own-claims')||/\/cc\/\d/.test(u)),false);
  b.el('cert').value=listing.cert;b.el('grader').value='PSA';b.el('f').events.submit({preventDefault(){}});await settle();
  assert.match(b.el('out').innerHTML,/Nidoking-Holo/);assert.doesNotMatch(b.el('out').innerHTML,/<img/);
  const saved=new URLSearchParams(b.history.at(-1));assert.equal(saved.get('name'),'<img onerror=bad>');assert.equal(saved.get('cert'),listing.cert);
});
test('saved listing has explicit coverage and secondary request, not an all-clear',async()=>{
  const b=await boot('cleancheck','?cert='+listing.cert+'&grader=PSA');const h=b.el('out').innerHTML;
  for(const text of ['Saved listing: found — 1 saved record','Gacha Mark: not_found','Grader lookup: not_checked','QR-to-cert comparison: not_checked','Private cross-platform matching: not_checked — planned, not live','Physical authenticity: not_checked',
    // Ask/date follow the saved shard row (they move with each Collector Crypt refresh).
    'Asking $'+listing.ask.toLocaleString('en-US'),'Source date '+listing.listed])assert.ok(h.includes(text),text);
  assert.match(h,/Request a Gacha Mark evidence review/);assert.doesNotMatch(h,/class="result-action"|verdict clear/);
  assert.match(h,/<details class="meta"><summary>Record source<\/summary>Collector Crypt/);
});
test('actual saved Mark is primary and suppresses card-specific duplicate request',async()=>{
  const mark=own.find(c=>c.source==='mark'&&c.grader==='PSA');assert.ok(mark);
  const b=await boot('cleancheck','?cert='+mark.cert+'&grader=PSA',{records:own,rows:[]});const h=b.el('out').innerHTML;
  assert.match(h,/Gacha Mark: found/);assert.match(h,new RegExp('class="result-action" href="/platform\\?saved=1#/cert/'+mark.cert+'">View existing Gacha Mark'));
  assert.ok(h.includes(mark.card));assert.ok(h.includes(mark.when.slice(0,10)));
  assert.doesNotMatch(h,/#request|Request a Gacha Mark evidence review/);
});
test('source failures remain not_checked and preserve available records',async()=>{
  for(const [failOwn,failCC] of [[true,false],[false,true],[true,true]]){
    const b=await boot('cleancheck','?cert='+listing.cert+'&grader=PSA',{failOwn,failCC});const h=b.el('out').innerHTML;
    assert.match(h,/Incomplete source check/);
    assert.ok(h.includes(failOwn?'Gacha Mark: not_checked':'Gacha Mark: not_found'));
    assert.ok(h.includes(failCC?'Saved listing: not_checked':'Saved listing: found'));
    assert.equal(h.includes('Nidoking-Holo'),!failCC);
    assert.doesNotMatch(h,/verdict clear/);
  }
});
test('malformed source is unchecked; empty successful source is not_found',async()=>{
  for(const records of [[null],{bad:true}]){
    const b=await boot('cleancheck','?cert='+listing.cert+'&grader=PSA',{records});
    assert.match(b.el('out').innerHTML,/Gacha Mark: not_checked/);
  }
  const b=await boot('cleancheck','?cert='+listing.cert+'&grader=PSA',{rows:[]});
  assert.match(b.el('out').innerHTML,/Saved listing: not_found/);
});
test('same digits under CGC cannot borrow PSA Mark and long CGC certs remain supported',async()=>{
  const mark={source:'mark',grader:'PSA',cert:listing.cert,card:'PSA-only Mark'};
  const b=await boot('cleancheck','?cert='+listing.cert+'&grader=CGC',{records:[mark],rows:[listing]});
  assert.doesNotMatch(b.el('out').innerHTML,/PSA-only Mark|View existing/);
  const cgc={source:'mark',grader:'CGC',cert:'1401015277013',card:'CGC saved Mark'};
  const c=await boot('cleancheck','?cert='+cgc.cert+'&grader=CGC',{records:[cgc],rows:[]});
  assert.match(c.el('out').innerHTML,/View existing Gacha Mark in register/);
  assert.doesNotMatch(c.el('out').innerHTML,/#\/cert\/1401015277013/);
});
test('invalid entered certificate and edited input cannot retain a previous result',async()=>{
  const b=await boot('cleancheck','?cert='+listing.cert+'&grader=PSA');
  b.el('cert').value='abc109863355';b.el('cert').events.input();
  assert.equal(b.el('out').innerHTML,'');const before=b.calls.length;
  b.el('f').events.submit({preventDefault(){}});await settle();
  assert.equal(b.calls.length,before);assert.match(b.el('out').textContent,/Enter a PSA cert/);
});
test('stale response cannot overwrite edited certificate context',async()=>{
  const b=await boot('cleancheck');
  b.el('cert').value=listing.cert;b.el('f').events.submit({preventDefault(){}});
  b.el('cert').value='123456';b.el('cert').events.input();await settle();
  assert.equal(b.el('out').innerHTML,'');assert.equal(b.el('go').disabled,false);
});
test('navigation and inactive payment behavior stay intact with no auth or checkout added',async()=>{
  for(const page of Object.values(html)){
    assert.match(page,/href="\/platform\?saved=1#\/api">Public data/);
    assert.match(page,/Payments are inactive|payments are inactive/);
    assert.doesNotMatch(page,/localStorage|signIn|signUp|checkout\.stripe/);
  }
  const b=await boot('check');assert.equal(b.el('rgo').disabled,true);
  assert.match(b.el('payment-status').textContent,/Payments are inactive/);
});

test('real browser completes local connected flow with no external transport or mobile overflow',async()=>{
  // Pinned devDependencies in this repo (puppeteer-core 25.16.0, @sparticuz/chromium 153.0.0); was an out-of-repo /tmp path.
  const require=createRequire(new URL('../package.json',import.meta.url));
  const puppeteer=require('puppeteer-core'),chromium=require('@sparticuz/chromium').default;
  const server=http.createServer((req,res)=>{
    const u=new URL(req.url,'http://local.invalid');res.setHeader('content-type',u.pathname.startsWith('/api/')||u.pathname.endsWith('.json')?'application/json':'text/html');
    if(u.pathname==='/check')res.end(html.check);
    else if(u.pathname==='/cleancheck')res.end(html.cleancheck);
    else if(u.pathname==='/api/check')res.end(JSON.stringify({cards:[sold]}));
    else if(u.pathname==='/api/mark-request'){res.statusCode=503;res.end(JSON.stringify({ok:false,paymentStatus:'inactive',payUrl:null}))}
    else if(u.pathname==='/data/own-claims.json')res.end(JSON.stringify(own));
    else if(u.pathname==='/data/cc/109.json')res.end(JSON.stringify([listing]));
    else if(u.pathname==='/data/cc/index.json')res.end('{"certs":1}');
    else{res.statusCode=404;res.end('not found')}
  });
  await new Promise(resolve=>server.listen(0,'0.0.0.0',resolve));
  let browser;
  try{
    browser=await puppeteer.launch({executablePath:await chromium.executablePath(),args:chromium.args,headless:true});
    const page=await browser.newPage(),errors=[],blocked=[];
    const origin='http://127.0.0.1:'+server.address().port;
    page.on('pageerror',e=>errors.push(e.message));await page.setRequestInterception(true);
    page.on('request',r=>{if(r.url().startsWith(origin+'/')&&r.method()==='GET')r.continue();else{blocked.push(r.url());r.abort()}});
    await page.goto(origin+'/check?q=Rayquaza');await page.waitForSelector('.certificate-action');
    await Promise.all([page.waitForNavigation(),page.click('.certificate-action')]);
    assert.equal(await page.$eval('#cert',e=>e.value),'');assert.equal(await page.$eval('#grader',e=>e.value),'');
    assert.equal(await page.$eval('#context-identity',e=>e.textContent),sold.name+' · '+sold.set+' · #'+sold.number+' · PSA 10');
    await page.type('#cert',listing.cert);await page.select('#grader','PSA');await page.click('#go');
    await page.waitForFunction(()=>document.querySelector('#out').innerText.includes('Saved listing: found'));
    assert.match(await page.$eval('#out',e=>e.innerText),/Nidoking-Holo/);
    for(const width of [390,1280]){
      await page.setViewport({width,height:900});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'Clean Check width '+width);
    }
    const mark=own.find(c=>c.source==='mark'&&c.grader==='PSA');
    await page.goto(origin+'/cleancheck?cert='+mark.cert+'&grader=PSA');await page.waitForSelector('.result-action');
    assert.match(await page.$eval('.result-action',e=>e.textContent),/View existing Gacha Mark/);
    assert.equal(await page.$$eval('#out a[href*="#request"]',els=>els.length),0);
    await page.goto(origin+'/check?q=Rayquaza');await page.waitForSelector('.certificate-action');
    for(const width of [390,1280]){await page.setViewport({width,height:900});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'Price Check width '+width)}
    assert.deepEqual(errors,[]);assert.deepEqual(blocked,[]);
  }finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve))}
});
