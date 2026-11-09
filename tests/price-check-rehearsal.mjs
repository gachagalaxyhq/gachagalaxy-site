// Local HTTP + real browser rehearsal. Upstream transport replays authorized saved
// provider bytes, NEVER a fresh provider request. Synthetic cases are labelled.
import fs from 'node:fs';
import http from 'node:http';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
const require = createRequire('/tmp/opencode/mark-review-isolated/package.json');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium').default;
const root = new URL('../', import.meta.url);
const bytes = fs.readFileSync('/tmp/opencode/ppt_ebay.json');
const saved = JSON.parse(bytes);
const html = fs.readFileSync(new URL('public/check.html', root), 'utf8');
const source = fs.readFileSync(new URL('functions/api/check.js', root), 'utf8');
const {onRequestGet} = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
assert.equal(hash(bytes), '8dd31162e2e54df5cfe279de592eed369eda215a63b23254a1a36eefe5b8df80');
assert.equal(hash(html.slice(html.indexOf('<div class="data-strip">'), html.indexOf('<footer>'))), '338dd53847e5cfa734156634a1688fdba63813c732722f6f183b96c2ddfa1ded');
assert.equal(hash(html.slice(html.indexOf('</script><script>'))), 'b67bb7c7b7d4f1d5c754412f9f4bf963ac828b5f04d18ebc77a2a18097febb63');
const originalFetch = globalThis.fetch;
let mode = 'saved', transportCalls = 0;
globalThis.fetch = async url => {
  // Closed transport: no request can reach the network, even on a code regression.
  assert.equal(new URL(url).origin, 'https://www.pokemonpricetracker.com');
  transportCalls++;
  if (mode === 'saved') return new Response(bytes);
  if (mode === 'empty') return Response.json({data: []});
  if (mode === 'failure') return new Response('{}', {status: 429});
  const changed = structuredClone(saved.data[0]);
  if (mode === 'missing-grade') delete changed.ebay.salesByGrade.psa10;
  if (mode === 'missing-metadata') {
    delete changed.ebay.salesByGrade.psa10.lastSaleDate;
    delete changed.ebay.salesByGrade.psa10.lastMarketUpdate;
    delete changed.ebay.salesByGrade.psa10.salesBySource;
  }
  return Response.json({data: [changed]});
};
const server = http.createServer(async (req, res) => {
  try {
    if (req.url.startsWith('/api/check')) {
      const response = await onRequestGet({request: new Request('http://127.0.0.1'+req.url), env: mode==='unconfigured'?{}:{PPT_KEY:'local-replay-not-a-credential'}});
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(await response.text());
    } else if (req.url === '/check') {
      res.writeHead(200, {'content-type':'text/html'}); res.end(html);
    } else { res.writeHead(404); res.end(); }
  } catch (error) { res.writeHead(500); res.end(error.message); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await puppeteer.launch({executablePath:await chromium.executablePath(),args:chromium.args,headless:true});
  const page = await browser.newPage();
  await page.setCacheEnabled(false);
  const errors = [], blocked = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setRequestInterception(true);
  page.on('request', request => {
    if (request.url().startsWith(origin+'/api/mark-request')) { blocked.push('Mark intake GET blocked locally'); return request.abort(); }
    if (request.url().startsWith(origin+'/') || request.url().startsWith('data:')) return request.continue();
    blocked.push(request.url()); return request.abort();
  });
  await page.goto(origin+'/check');
  const search = async () => {
    await page.$eval('#q', el => {el.value='Rayquaza VMAX';});
    await page.click('#go');
    await page.waitForFunction(() => !document.querySelector('#go').disabled);
    return page.$eval('#out', el => el.innerText);
  };
  const real = await search();
  assert.equal(await page.$$eval('#out article', els => els.length), 9);
  for (let i=0;i<saved.data.length;i++) {
    const g=saved.data[i].ebay.salesByGrade.psa10;
    const text=await page.$eval(`#out article:nth-child(${i+1})`, el => el.innerText);
    assert.ok(text.includes('$'+g.medianPrice.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})));
    assert.ok(text.includes(g.count.toLocaleString('en-US')+' historical sales'));
    assert.ok(text.includes(g.lastSaleDate.slice(0,10)+' UTC'));
    assert.ok(text.includes(g.lastMarketUpdate.slice(0,10)+' UTC'));
    for(const [name,n] of Object.entries(g.salesBySource)) assert.ok(text.includes(name+': '+n));
  }
  assert.match(real,/Small sample/);
  assert.match(real,/No reported sale in the last 7 days/);
  console.log(JSON.stringify({basis:'Unmodified saved provider response through actual handler and actual page over local HTTP; not production upstream success',sha256:hash(bytes),cards:9,firstCard:await page.$eval('#out article',el=>el.innerText)},null,2));
  const cases = [];
  for (const [next,expected] of [['missing-grade','no PSA 10 sales'],['missing-metadata','Last sale unknown'],['empty','No match.'],['failure','Lookup is unavailable right now.'],['unconfigured','Lookup is not configured.']]) {
    mode=next;
    const text=await search();
    const message=await page.$eval('#msg',el=>el.innerText);
    assert.ok((text+' '+message).toLowerCase().includes(expected.toLowerCase()), JSON.stringify({next,text,message}));
    if(next==='missing-metadata') {assert.match(text,/Provider updated unknown/);assert.match(text,/Sources unknown/);assert.doesNotMatch(text,/NaN|Invalid Date/);}
    if(['empty','failure','unconfigured'].includes(next)) assert.equal(await page.$$eval('#out article',els=>els.length),0);
    cases.push({syntheticEdgeCase:next,message,passed:true});
  }
  assert.deepEqual(errors,[]);
  assert.equal(transportCalls,5); // unconfigured must not use upstream transport
  console.log(JSON.stringify({cases,browserErrors:errors,blocked,transportReplayCalls:transportCalls,externalUpstreamCalls:0,markSectionsUnchanged:true},null,2));
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve=>server.close(resolve));
  globalThis.fetch=originalFetch;
}
