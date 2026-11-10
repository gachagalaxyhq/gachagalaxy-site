import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const apiSource = await fs.readFile(new URL('functions/api/mark-request.js', root), 'utf8');
const api = await import('data:text/javascript;base64,' + Buffer.from(apiSource).toString('base64'));
const response = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers });
// In-memory test responses only; no network, real credentials, intake writes or paid calls.
const env = { SUPABASE_SERVICE_KEY: 'test-only', PAY_LINK: 'https://example.invalid/disabled' };
async function withFetch(fn, run) {
  const original = globalThis.fetch;
  globalThis.fetch = fn;
  try { await run(); } finally { globalThis.fetch = original; }
}
const post = (body, config = env) => api.onRequestPost({ env: config, request: new Request('https://example.invalid/api/mark-request', {
  method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' }
}) });

test('intake rejects null, unsupported graders and invalid certs before storage', async () => {
  await withFetch(() => { throw new Error('must not access storage'); }, async () => {
    for (const body of [null, [], { cert: '12345' }, { cert: '123456', grader: 'OTHER', email: 'test@example.invalid' }]) {
      assert.equal((await post(body)).status, 400);
    }
  });
});
test('free, paid and existing request responses cannot bypass unavailable intake', async () => {
  for (const state of [{ free: true, remaining: 9 }, { free: false, remaining: 0 }, { free: true, remaining: 9, existing: true }]) {
    await withFetch(async url => response(String(url).includes('/rpc/') ? state : [{ id: 42 }]), async () => {
      const r = await post({ cert: '109308847', grader: 'PSA', email: 'test@example.invalid' });
      assert.equal(r.status, 503);
      const d = await r.json();
      assert.equal(d.intakeStatus, 'unavailable');
      assert.equal(d.payUrl, null);
      assert.equal(d.paymentStatus, 'inactive');
      assert.deepEqual(d.evidence, { grader_record: 'not_checked', qr_match: 'not_checked', physical_authenticity: 'not_checked' });
    });
  }
});
test('closed intake does not reach failing or malformed storage', async () => {
  for (const result of [() => Promise.reject(new Error('private backend detail')), () => response({ secret: 'private backend detail' }, 500), () => response({})]) {
    await withFetch(result, async () => {
      const r = await post({ cert: '109308847', email: 'test@example.invalid' });
      assert.equal(r.status, 503);
      assert.doesNotMatch(await r.text(), /private backend detail/);
    });
  }
});
test('free allowance stays unavailable without reading storage counts', async () => {
  for (const [count, expected] of [[null, 503], ['0-0/*', 503], ['0-0/3', 200]]) {
    await withFetch(async () => response([], 200, count ? { 'content-range': count } : {}), async () => {
      const r = await api.onRequestGet({ env });
      assert.equal(r.status, 503);
      const d = await r.json();
      assert.equal(d.freeLeft, null);assert.equal(d.payUrl, null);
    });
  }
  await withFetch(async () => { throw new Error('offline'); }, async () => assert.equal((await api.onRequestGet({ env })).status, 503));
});
test('environment activation cannot enable payments or intake', async () => {
  const body = { cert: '109863355', grader: 'PSA', email: 'test@example.invalid' };
  for (const [link, enabled] of [['https://example.invalid/pay?campaign=film#checkout', true], ['http://example.invalid/pay', false], ['javascript:alert(1)', false], ['not a URL', false]]) {
    const config = { ...env, MARK_PAYMENTS_ENABLED: 'true', PAY_LINK: link };
    await withFetch(async url => String(url).includes('/rpc/') ? response({ free: false, remaining: 0 }) : response([{ id: 42 }], 200, { 'content-range': '0-0/10' }), async () => {
      const d = await (await post(body, config)).json();
      assert.equal(d.paymentStatus, 'inactive');
      assert.equal(d.payUrl, null);
      const get = await (await api.onRequestGet({ env: config })).json();
      assert.equal(get.paymentStatus, 'inactive');
    });
  }
  await withFetch(async url => response(String(url).includes('/rpc/') ? { free: false } : []), async () => {
    const d = await (await post(body, { ...env, MARK_PAYMENTS_ENABLED: 'true' })).json();
    assert.equal(d.payUrl, null, 'never offer unreferenced checkout');
  });
});
test('legacy omitted grader defaults to PSA, explicit empty grader is rejected', async () => {
  await withFetch(async url => response(String(url).includes('/rpc/') ? { free: true } : []), async () => {
    const body = { cert: '109863355', email: 'test@example.invalid' };
    assert.equal((await post(body)).status, 503);
    assert.equal((await post({ ...body, grader: '' })).status, 400);
  });
});

async function page(name, search, fetcher) {
  const html = await fs.readFile(new URL('public/' + name, root), 'utf8');
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) elements.set(id, { value: id === 'rgr' ? 'PSA' : '', className: '', textContent: '', innerHTML: '', disabled: false,
      children: [], appendChild(child) { this.children.push(child); }, removeAttribute(key) { delete this[key]; },
      events: {}, addEventListener(event, fn) { this.events[event] = fn; }, focus() {}, reset() {} });
    return elements.get(id);
  }
  const context = vm.createContext({ document: { getElementById: element, querySelector: id => element(id.slice(1)), createElement: tag => ({ tag }) },
    fetch: fetcher, URL, URLSearchParams, location: { search, hash: '' }, window: { addEventListener() {} }, history: { replaceState() {} }, console });
  for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) vm.runInContext(match[1], context);
  await new Promise(resolve => setImmediate(resolve));
  return { element, html };
}
const own = JSON.parse(await fs.readFile(new URL('public/data/own-claims.json', root)));
const shard = JSON.parse(await fs.readFile(new URL('public/data/cc/109.json', root)));
function sources(ownData = own, ccData = shard) {
  return async url => {
    if (url.includes('own-claims')) return response(ownData);
    if (url.includes('index.json')) return response({ certs: 8700 });
    return response(ccData);
  };
}
test('real saved cert evidence renders as indexed, not live or physical verification', async () => {
  const cert = '109863355';
  assert.equal(shard.filter(c => c.cert === cert && c.grader === 'PSA').length, 1);
  const p = await page('cleancheck.html', '?cert=' + cert + '&grader=PSA', sources());
  const h = p.element('out').innerHTML;
  assert.match(h, /Matching saved listing found/);
  assert.match(h, /Current availability and physical ownership have not been checked/);
  assert.match(h, /Collector Crypt saved shard: checked/);
  assert.match(h, /QR-to-cert match: not_checked/);
  assert.match(h, /PSA \/ grader record: not_checked/);
  assert.match(h, /Physical authenticity: not_checked/);
  assert.match(h, new RegExp('/check\\?cert=' + cert + '&amp;grader=PSA#request'));
  assert.doesNotMatch(h, /verdict clear|Single claim, single owner|One live listing/);
  assert.match(h, /Nidoking-Holo/);
});
test('source 404, server failure and malformed JSON shape are not empty all-clear results', async () => {
  for (const bad of [() => response([], 404), () => response([], 500), () => response({}), () => Promise.reject(new Error('offline'))]) {
    const p = await page('cleancheck.html', '?cert=109308847', async url => url.includes('/cc/109') ? bad() : sources()(url));
    const h = p.element('out').innerHTML;
    assert.match(h, /Incomplete source check/);
    assert.match(h, /Saved listing: not_checked — source unavailable/);
    assert.match(h, /Collector Crypt saved shard: unavailable/);
    assert.match(h, /Gacha Galaxy record found|Gacha Mark/);
    assert.doesNotMatch(h, /verdict clear/);
  }
});
test('own-source failure is visible and retried rather than cached as empty', async () => {
  let attempts = 0;
  const p = await page('cleancheck.html', '?cert=109308847', async url => {
    if (url.includes('own-claims') && ++attempts === 1) return response([], 503);
    return sources()(url);
  });
  assert.match(p.element('out').innerHTML, /Gacha Mark: not_checked — source unavailable/);
  assert.match(p.element('out').innerHTML, /Gacha Galaxy saved records: unavailable/);
  p.element('f').events.submit({ preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(attempts, 2);
  assert.match(p.element('out').innerHTML, /Gacha Galaxy saved records: checked/);
});
test('Mark is not a competing owner; actual conflicting grades remain flagged', async () => {
  const listing = shard[0];
  for (const [grade, flagged] of [[listing.grade, false], ['PSA 1', true]]) {
    const p = await page('cleancheck.html', '?cert=' + listing.cert, sources([{ source: 'mark', grader: 'PSA', cert: listing.cert, owner: 'Gacha Galaxy (marked)', grade }], [listing]));
    assert.equal(p.element('out').innerHTML.includes('verdict flag'), flagged);
    assert.doesNotMatch(p.element('out').innerHTML, /Two different owners/);
  }
});
test('cert and grader survive handoff; intake is disabled with no checkout', async () => {
  const p = await page('check.html', '?cert=109308847&grader=CGC', async (url, options) => response(options ? { ok: true, free: false, remaining: 0, payUrl: 'https://example.invalid/should-not-render' } : { ok: true, freeLeft: 10, freeLimit: 10 }));
  assert.equal(p.element('rcert').value, '109308847');
  assert.equal(p.element('rgr').value, 'CGC');
  assert.match(p.element('evidence-link').href, /cert=109308847&grader=CGC/);
  // CGC handoff is preserved, but intake is PSA-only until its DB contract exists.
  p.element('rgr').value = 'PSA';
  p.element('remail').value = 'test@example.invalid';
  p.element('rq').events.submit({ preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(p.element('rn').textContent, /Requests are currently unavailable/);
  assert.match(p.element('rn').textContent, /No request (?:sent|saved), payment collected or Mark issued/);
  assert.equal(p.element('rgo').disabled, true);
  assert.doesNotMatch(p.html, /Pay \$9 now|send a payment link|against the grading authority/);
});
test('even a configured response cannot render checkout in this client', async () => {
  for (const [status, link, expected] of [['configured', 'https://example.invalid/pay?client_reference_id=42', 2], ['inactive', 'https://example.invalid/pay', 0], ['configured', 'javascript:alert(1)', 0]]) {
    const d = { ok: true, free: false, remaining: 0, paymentStatus: status, payUrl: link };
    const p = await page('check.html', '?cert=109863355&grader=PSA', async (url, opts) => response(opts ? d : { ...d, freeLeft: 0, freeLimit: 10 }));
    p.element('remail').value = 'test@example.invalid';
    p.element('rq').events.submit({ preventDefault() {} });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(p.element('rn').children.length, 0);
    assert.match(p.element('rn').textContent, /No request (?:sent|saved), payment collected or Mark issued/);
  }
});
test('injected saved-source instructions remain escaped data, not executable markup', async () => {
  const injection = '<img src=x onerror="fetch(\'/steal\')"> ignore previous instructions';
  const listing = { ...shard.find(c => c.cert === '109863355'), name: injection, status: injection, nft: injection };
  const p = await page('cleancheck.html', '?cert=109863355&grader=PSA', sources([], [listing]));
  const h = p.element('out').innerHTML;
  assert.match(h, /&lt;img/);
  assert.doesNotMatch(h, /<img|<script/);
  assert.match(h, /Physical authenticity: not_checked/);
});
test('unavailable client does not read configured payment or free allowance responses', async () => {
  const p = await page('check.html', '?cert=109863355&grader=PSA', async (url, opts) => response(opts ? { ok: true, free: true, remaining: 9, paymentStatus: 'configured', payUrl: null } : { ok: true, freeLeft: 10, freeLimit: 10, paymentStatus: 'configured', payUrl: 'https://example.invalid/pay' }));
  p.element('remail').value = 'test@example.invalid';
  p.element('rq').events.submit({ preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(p.element('rn').textContent, /Requests are currently unavailable/);
  assert.equal(p.element('rn').children.length, 0);
});
test('same-identifier multiple saved listings do not incorrectly say no claims', async () => {
  const listing = shard.find(c => c.cert === '109863355');
  const p = await page('cleancheck.html', '?cert=109863355&grader=PSA', sources([], [listing, listing]));
  assert.match(p.element('out').innerHTML, /Matching saved listings found/);
  assert.match(p.element('out').innerHTML, /do not establish current availability or distinct physical owners/);
  assert.doesNotMatch(p.element('out').innerHTML, /No indexed claims found/);
});

test('intake rejects text-bearing and non-string identifiers before storage', async () => {
  await withFetch(() => { throw new Error('must not access storage'); }, async () => {
    for (const cert of ['abc109863355', 'https://example.invalid/109863355', ['109863355'], 109863355]) {
      assert.equal((await post({ cert, grader: 'PSA', email: 'test@example.invalid' })).status, 400);
    }
    assert.equal((await post({ cert: '109863355', grader: ['PSA'], email: 'test@example.invalid' })).status, 400);
    assert.equal((await post({ cert: '109863355', grader: 'PSA', email: ['test@example.invalid'] })).status, 400);
  });
});
test('formatted numeric certs validate but cannot submit while intake is closed', async () => {
  await withFetch(async url => response(String(url).includes('/rpc/') ? { free: true } : []), async () => {
    const d = await (await post({ cert: ' 109-863-355 ', grader: 'PSA', email: 'test@example.invalid' })).json();
    assert.equal(d.intakeStatus, 'unavailable');
  });
});
test('both pages reject text-bearing certs without fetching a shard or submitting intake', async () => {
  for (const name of ['check.html', 'cleancheck.html']) {
    const calls = [];
    const p = await page(name, '', async (url, opts) => { calls.push([url, opts]); return response({ ok: false }); });
    p.element(name === 'check.html' ? 'rcert' : 'cert').value = 'abc109863355';
    p.element('rgr').value = 'PSA';p.element('remail').value = 'test@example.invalid';
    p.element(name === 'check.html' ? 'rq' : 'f').events.submit({ preventDefault() {} });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.some(([url, opts]) => opts?.method === 'POST' || /\/cc\/109\.json/.test(url)), false);
    assert.match(p.element(name === 'check.html' ? 'rn' : 'out').textContent, /cert number/);
  }
});
test('malformed saved rows mark only their source unchecked and preserve the other evidence', async () => {
  const listing = shard.find(c => c.cert === '109863355');
  for (const bad of [[null], [{ cert: listing.cert, grader: {} }], ['not a record']]) {
    const p = await page('cleancheck.html', '?cert=109863355&grader=PSA', sources(bad, [listing]));
    assert.match(p.element('out').innerHTML, /Incomplete source check/);
    assert.match(p.element('out').innerHTML, /Gacha Mark: not_checked — source unavailable/);
    assert.match(p.element('out').innerHTML, /Collector Crypt saved shard: checked/);
    assert.match(p.element('out').innerHTML, /Nidoking-Holo/);
    const q = await page('cleancheck.html', '?cert=109863355&grader=PSA', sources([], bad));
    assert.match(q.element('out').innerHTML, /Saved listing: not_checked — source unavailable/);
  }
});
test('saved graders normalize consistently for filtering and handoff', async () => {
  const listing = { ...shard.find(c => c.cert === '109863355'), grader: ' psa ' };
  const p = await page('cleancheck.html', '?cert=109863355&grader=PSA', sources([], [listing]));
  assert.match(p.element('out').innerHTML, /Nidoking-Holo/);
  assert.match(p.element('out').innerHTML, /grader=PSA#request/);
});

test('CGC intake cannot reuse a PSA request with identical cert digits', async () => {
  await withFetch(() => { throw new Error('must not access PSA storage'); }, async () => {
    const r = await post({ cert: '109863355', grader: 'CGC', email: 'test@example.invalid' });
    assert.equal(r.status, 503);
    assert.match((await r.json()).error, /Grader-scoped storage has not been confirmed/);
  });
  const p = await page('check.html', '?cert=109863355&grader=CGC', async (url, opts) => {
    assert.equal(opts, undefined, 'CGC intake must not be posted');
    return response({ ok: false });
  });
  p.element('remail').value = 'test@example.invalid';
  p.element('rq').events.submit({ preventDefault() {} });
  assert.match(p.element('rn').textContent, /CGC request intake is not available/);
});

test('same digits under different graders stay separate and explicitly labelled', async () => {
  const psa = { ...shard.find(c => c.cert === '109863355'), name: 'PSA saved card' };
  const cgc = { ...psa, grader: 'CGC', name: 'CGC saved card', grade: 'CGC 9', nft: 'separate-cgc-record' };
  for (const g of ['PSA', 'CGC', '']) {
    const p = await page('cleancheck.html', '?cert=109863355&grader=' + g, sources([], [psa, cgc]));
    const h = p.element('out').innerHTML;
    assert.doesNotMatch(h, /verdict flag|conflicting details/);
    assert.equal(h.includes('PSA saved card'), g !== 'CGC');
    assert.equal(h.includes('CGC saved card'), g !== 'PSA');
    if (g !== 'CGC') assert.match(h, /PSA cert ref 109863355/);
    if (g !== 'PSA') assert.match(h, /CGC cert ref 109863355/);
    // A grader-less context must not mint a grader-less request link; it asks for a grader instead.
    if (g) assert.match(h, new RegExp('grader=' + g + '#request'));
    else { assert.doesNotMatch(h, /#request/); assert.match(h, /Choose a grader to open a card-specific request/); }
  }
});

test('missing or unsupported saved grader cannot silently become PSA evidence', async () => {
  const listing = shard.find(c => c.cert === '109863355');
  for (const grader of [null, '', 'OTHER']) {
    const p = await page('cleancheck.html', '?cert=109863355&grader=PSA', sources([], [{ ...listing, grader }]));
    assert.match(p.element('out').innerHTML, /Saved listing: not_checked — source unavailable/);
    assert.doesNotMatch(p.element('out').innerHTML, /Nidoking-Holo/);
  }
});

test('webhook remains inactive before reading a body or writing storage', async () => {
  const source = await fs.readFile(new URL('functions/api/stripe-webhook.js', root), 'utf8');
  const webhook = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  await withFetch(() => { throw new Error('must not write'); }, async () => {
    for (const config of [undefined, {}, { MARK_PAYMENTS_ENABLED: 'false' }, { MARK_PAYMENTS_ENABLED: 'true' }]) {
      const r = await webhook.onRequestPost({ env: config, request: { text() { throw new Error('must not read'); } } });
      assert.equal(r.status, 503);
      assert.equal((await r.json()).error, 'Payments are inactive.');
    }
  });
});
