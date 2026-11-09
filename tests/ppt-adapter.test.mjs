// Offline transport stubs only. No network request or usable API credential.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../functions/api/check.js', import.meta.url), 'utf8');
const {onRequestGet} = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const context = q => ({request: new Request(`https://example.invalid/api/check?q=${encodeURIComponent(q)}`), env: {PPT_KEY: 'offline-test-only'}});

async function withTransport(payload, run, status = 200) {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response(JSON.stringify(payload), {status}); };
  try { await run(() => calls); } finally { globalThis.fetch = original; }
}

test('short queries and missing configuration never use transport', async () => {
  await withTransport({}, async calls => {
    assert.equal((await onRequestGet(context('ab'))).status, 400);
    assert.equal((await onRequestGet({...context('Rayquaza'), env: {}})).status, 503);
    assert.equal(calls(), 0);
  });
});

test('asking-only prices do not become sold results', async () => {
  await withTransport({data: [{name: 'Synthetic asking-only edge case', prices: {market: 999, low: 888}}]}, async () => {
    const result = await (await onRequestGet(context('asking'))).json();
    assert.deepEqual(result.cards, []);
  });
});

test('upstream failure is not returned as successful pricing', async () => {
  await withTransport({}, async () => {
    const response = await onRequestGet(context('Rayquaza'));
    assert.equal(response.status, 502);
    assert.equal((await response.json()).cards, undefined);
  }, 429);
});

test('transport, invalid JSON and malformed price data fail as structured unavailable responses', async () => {
  const original = globalThis.fetch;
  try {
    for (const transport of [
      async () => { throw new Error('private transport detail'); },
      async () => new Response('not JSON'),
      async () => new Response(JSON.stringify({})),
      async () => new Response(JSON.stringify({ data: {} })),
      async () => new Response(JSON.stringify({ data: [null] })),
      async () => new Response(JSON.stringify({ data: [{ ebay: { salesByGrade: { psa10: {} } } }] })),
      ...[
        { count: 0, medianPrice: 10, minPrice: 5, maxPrice: 15 },
        { count: 2, medianPrice: 10, minPrice: 15, maxPrice: 5 },
        { count: 2, medianPrice: '10', minPrice: 5, maxPrice: 15 },
      ].map(sold => async () => new Response(JSON.stringify({ data: [{ ebay: { salesByGrade: { psa10: sold } } }] }))),
    ]) {
      globalThis.fetch = transport;
      const result = await onRequestGet(context('Rayquaza'));
      assert.equal(result.status, 502);
      assert.equal(result.headers.get('cache-control'), 'no-store');
      assert.equal((await result.json()).error, 'Lookup is unavailable right now.');
    }
    assert.equal((await onRequestGet({ ...context('Rayquaza'), env: undefined })).status, 503);
  } finally { globalThis.fetch = original; }
});

const cache = '/tmp/opencode/ppt_ebay.json';
test('real cache maps exact grade-specific sold fields, not asking fields', {skip: !fs.existsSync(cache)}, async () => {
  const cached = JSON.parse(fs.readFileSync(cache, 'utf8'));
  // Poison listing values in a disposable in-memory copy, not the cache.
  const changed = structuredClone(cached);
  for (const card of changed.data) card.prices = {market: 98765.43, low: 98765.43};
  await withTransport(changed, async calls => {
    const response = await onRequestGet(context('Rayquaza'));
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(calls(), 1);
    assert.equal(result.cards.length, cached.data.length);
    for (let i = 0; i < result.cards.length; i++) {
      const input = cached.data[i];
      const output = result.cards[i];
      assert.equal(output.name, input.name);
      for (const [label, grade] of [['psa10', 'psa10'], ['psa9', 'psa9'], ['raw', 'ungraded']]) {
        const sold = input.ebay.salesByGrade[grade];
        assert.deepEqual(output[label], sold ? {
          median: sold.medianPrice, min: sold.minPrice, max: sold.maxPrice, n: sold.count,
           last: sold.lastSaleDate, mkt: sold.smartMarketPrice?.price, conf: sold.smartMarketPrice?.confidence,
           updated: sold.lastMarketUpdate, sources: sold.salesBySource,
        } : null);
      }
    }
  });
});
