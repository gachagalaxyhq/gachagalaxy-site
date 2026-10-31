// Photo phase of Clean Check. All certs, ids and links here are made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { pcParseQr, pcCheck, pcShared, pcRun } = require('../src/photocheck.js');

const qr = (text) => ({ format: 'QRCode', text, side: 'back' });
const bar = (text, format = 'Code128') => ({ format, text, side: 'front' });
const item = (id, cert, codes) => ({ key: 'PSA/' + cert, id, grader: 'PSA', cert, codes });

test('parses PSA QR links, the /psa suffix and non-PSA links', () => {
  assert.deepEqual(pcParseQr('https://www.psacard.com/cert/11112222/'), { psa: true, cert: '11112222', suffix: false, text: 'https://www.psacard.com/cert/11112222/' });
  assert.equal(pcParseQr('https://psacard.com/cert/11112222/psa').suffix, true);
  assert.equal(pcParseQr('http://www.psacard.com/cert/11112222/PSA/').suffix, true);
  assert.equal(pcParseQr('https://www.psacard.com/cert/11112222?x=1').cert, '11112222');
  assert.equal(pcParseQr('https://psacard.com.evil.example/cert/1/').psa, false);
  assert.equal(pcParseQr('99990000').psa, false);
});

test('matching QR and barcode is a match', () => {
  const r = pcCheck(item('a', '11112222', [qr('https://www.psacard.com/cert/11112222/'), bar('11112222', 'ITF')]));
  assert.equal(r.kind, 'match'); assert.equal(r.level, 'ok');
});

test('barcode alone (old label, no QR) is still a match', () => {
  assert.equal(pcCheck(item('a', '11112222', [bar('0011112222')])).kind, 'match');
});

test('QR ending in /psa is flagged high even when the cert matches', () => {
  const r = pcCheck(item('a', '11112222', [qr('https://www.psacard.com/cert/11112222/psa'), bar('11112222')]));
  assert.equal(r.kind, 'qr_psa_suffix'); assert.equal(r.level, 'high');
});

test('QR or barcode showing a different cert is flagged', () => {
  assert.equal(pcCheck(item('a', '11112222', [qr('https://www.psacard.com/cert/33334444/')])).kind, 'qr_mismatch');
  assert.equal(pcCheck(item('a', '11112222', [bar('33334444')])).kind, 'barcode_mismatch');
});

test('non-PSA QR (vault sticker) is ignored, not flagged', () => {
  const r = pcCheck(item('a', '11112222', [qr('55556666')]));
  assert.equal(r.kind, 'no_code'); assert.equal(r.level, 'unchecked'); assert.equal(r.ignored, 1);
  assert.equal(pcCheck(item('a', '11112222', [qr('55556666'), bar('11112222')])).kind, 'match');
});

test('nothing readable is unchecked, not clean', () => {
  const r = pcCheck(item('a', '11112222', []));
  assert.equal(r.kind, 'no_code'); assert.equal(r.level, 'unchecked');
});

test('one slab seen behind several tokens is slab_shared', () => {
  const res = pcShared([
    pcCheck(item('t1', '11112222', [qr('https://www.psacard.com/cert/77776666/'), bar('77776666')])),
    pcCheck(item('t2', '11112222', [qr('https://www.psacard.com/cert/77776666/')])),
    pcCheck(item('t3', '77776666', [qr('https://www.psacard.com/cert/77776666/')])),
    pcCheck(item('t4', '88880000', [qr('https://www.psacard.com/cert/88880000/')])),
  ]);
  assert.deepEqual(res.map(r => r.kind), ['slab_shared', 'slab_shared', 'slab_shared', 'match']);
  assert.deepEqual(res[2].sharedWith.sort(), ['t1', 't2']);
});

test('same cert listed twice with the same slab is left to the chain phase', () => {
  const res = pcShared([
    pcCheck(item('m1', '12121212', [qr('https://www.psacard.com/cert/12121212/')])),
    pcCheck(item('m2', '12121212', [qr('https://www.psacard.com/cert/12121212/')])),
  ]);
  assert.deepEqual(res.map(r => r.kind), ['match', 'match']);
});

test('run gives a summary by kind', () => {
  const { summary } = pcRun([
    item('a', '1', [bar('1')]), item('b', '2', []), item('c', '3', [qr('https://www.psacard.com/cert/3/psa')]),
  ]);
  assert.deepEqual(summary, { match: 1, no_code: 1, qr_psa_suffix: 1 });
});
