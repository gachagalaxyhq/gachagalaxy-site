// Chain phase of Clean Check. All addresses, contracts and token ids here are made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chParseRef, chLookup, chClassify, chB58 } = require('../src/tokencheck.js');

const addr = n => chB58(Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + n) % 256 || 1));
const CORE = 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d', SPL = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const LOCK = addr(1), PACK = addr(2), ALICE = addr(3), BOB = addr(4);
const MINT_CORE = addr(10), MINT_SPL = addr(11), MINT_GONE = addr(12), ACCT_SPL = addr(13);
const C = '0x' + '1'.repeat(40), EVM_OWNER = '0x' + 'ab'.repeat(20);
const b64 = bytes => Buffer.from(bytes).toString('base64');
const coreData = owner => { const raw = Buffer.from(chB58Decode(owner)); return [b64([1, ...raw, 0, 0]), 'base64']; };
function chB58Decode(s) { const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'; let n = 0n; for (const c of s) n = n * 58n + BigInt(A.indexOf(c));
  const out = []; while (n > 0n) { out.unshift(Number(n % 256n)); n /= 256n; } while (out.length < 32) out.unshift(0); return out; }

test('parses Solana and EVM refs, rejects junk', () => {
  assert.deepEqual(chParseRef(MINT_CORE), { chain: 'solana', address: MINT_CORE });
  assert.deepEqual(chParseRef(`base-${C}-836`), { chain: 'base', contract: C, tokenId: '836' });
  assert.equal(chParseRef('robinhood-0x12-1'), null);
  assert.equal(chParseRef(''), null);
});

test('reads Core owner, SPL holder, missing token and EVM owner through the supplied rpc', async () => {
  const calls = [];
  const rpc = async (chain, method, params) => {
    calls.push(chain + ':' + (method || 'batch'));
    if (method === 'getMultipleAccounts') return { value: params[0].map(a =>
      a === MINT_CORE ? { owner: CORE, data: coreData(ALICE) } : a === MINT_SPL ? { owner: SPL, data: ['', 'base64'] } : null) };
    if (method === 'getTokenLargestAccounts') return { value: [{ address: ACCT_SPL, amount: '1' }] };
    if (method === 'getAccountInfo') return { value: { data: { parsed: { info: { owner: PACK } } } } };
    return params.map(r => r.params[0].data.endsWith('1') ? { id: r.id, result: '0x' + '0'.repeat(24) + 'ab'.repeat(20) }
      : { id: r.id, error: { code: 3, message: 'execution reverted' } });
  };
  const s = await chLookup([
    { key: 'PSA/1', ref: MINT_CORE, record: 'r1' }, { key: 'PSA/1', ref: `base-${C}-1`, record: 'r2' },
    { key: 'PSA/2', ref: MINT_SPL, record: 'r3' }, { key: 'PSA/2', ref: `robinhood-${C}-2`, record: 'r4' },
    { key: 'PSA/3', ref: MINT_GONE, record: 'r5' }, { key: 'PSA/4', ref: 'nope', record: 'r6' },
  ], rpc, { gapMs: 0 });
  const by = Object.fromEntries(s.map(x => [x.record, x]));
  assert.equal(by.r1.holder, ALICE); assert.equal(by.r1.standard, 'core');
  assert.equal(by.r2.holder, EVM_OWNER); assert.equal(by.r2.exists, true);
  assert.equal(by.r3.holder, PACK); assert.equal(by.r3.standard, 'spl');
  assert.equal(by.r4.exists, false);
  assert.equal(by.r5.exists, false);
  assert.equal(by.r6.error, 'bad_ref');
  assert.ok(calls.includes('base:batch') && calls.includes('robinhood:batch'));
});

const st = (key, chain, holder, exists = true) => ({ key, chain, holder, exists, record: key + chain });
const opts = { lockups: [LOCK], packs: [PACK] };

test('copy parked in a lock-up is a clean move', () => {
  const { results } = chClassify([st('PSA/1', 'solana', LOCK), st('PSA/1', 'base', EVM_OWNER)], opts);
  assert.equal(results[0].kind, 'clean_move'); assert.equal(results[0].parked, 1);
});

test('copy gone on one chain is a clean move', () => {
  const { results } = chClassify([st('PSA/1', 'robinhood', null, false), st('PSA/1', 'solana', ALICE)], opts);
  assert.equal(results[0].kind, 'clean_move'); assert.equal(results[0].gone, 1);
});

test('live copy in a pack address next to an owned copy is high priority', () => {
  const { results } = chClassify([st('PSA/1', 'solana', PACK), st('PSA/1', 'base', EVM_OWNER)], opts);
  assert.equal(results[0].kind, 'pack_pool_double'); assert.equal(results[0].level, 'high');
});

test('two live copies with different holders is a double record', () => {
  const { results } = chClassify([st('PSA/1', 'solana', ALICE), st('PSA/1', 'solana', BOB)], opts);
  assert.equal(results[0].kind, 'double_record'); assert.equal(results[0].level, 'high');
});

test('two live copies with one holder is low priority', () => {
  const { results } = chClassify([st('PSA/1', 'solana', ALICE), st('PSA/1', 'solana', ALICE)], opts);
  assert.equal(results[0].kind, 'same_holder_double'); assert.equal(results[0].level, 'low');
});

test('nothing on chain needs review', () => {
  const { results } = chClassify([st('PSA/1', 'solana', null, false), st('PSA/1', 'base', null, false)], opts);
  assert.equal(results[0].kind, 'all_gone');
});

test('EVM address case does not matter for lock-up and pack lists', () => {
  const up = '0x' + 'CD'.repeat(20);
  const { results } = chClassify([st('PSA/1', 'base', up.toLowerCase()), st('PSA/1', 'solana', ALICE)], { lockups: [up] });
  assert.equal(results[0].kind, 'clean_move');
});

test('summary counts each kind', () => {
  const { summary } = chClassify([
    st('PSA/1', 'solana', LOCK), st('PSA/1', 'base', EVM_OWNER),
    st('PSA/2', 'solana', PACK), st('PSA/2', 'base', EVM_OWNER),
    st('PSA/3', 'solana', ALICE), st('PSA/3', 'solana', BOB),
  ], opts);
  assert.deepEqual(summary, { clean_move: 1, pack_pool_double: 1, double_record: 1 });
});
