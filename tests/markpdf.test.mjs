// node --test tests/markpdf.test.mjs   (needs jspdf@2.5.2 resolvable; set NODE_PATH)
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { jsPDF } = require('jspdf');
const { buildMarkPdf, markPdfStatus, markPdfAscii } = require('../src/markpdf.js');

const NOW = Date.parse('2026-10-26T09:00:00Z');
const base = {
  cert: '154790134', name: 'Giratina VSTAR', num: '#GG69', set: 'Crown Zenith', year: '2023', grader: 'PSA',
  grade: 'PSA 10', gradeLabel: 'GEM-MT 10', low: 524, point: 650, high: 776, conf: 75, prices: 47,
  network: 'robinhood-mainnet', kind: 'mark', revoked: false,
  ev: [{ t: '2026-10-10T07:14:15Z', low: 524, point: 650, high: 776, tx: '0x' + 'a'.repeat(64),
         explorer: 'https://explorer.chain.robinhood.com', registry: '0xc427A992f0460b86744e9a6E24Cd242770D240d8' }],
};
const text = c => {
  const d = buildMarkPdf(jsPDF, c, {}, NOW, { validDays: 30 });
  const f = path.join(os.tmpdir(), 'mk-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.pdf');
  const buf = Buffer.from(d.output('arraybuffer'));
  fs.writeFileSync(f, buf);
  try { return buf.subarray(0, 5).toString() + '\n' + execFileSync('pdftotext', ['-raw', f, '-']).toString().replace(/\s+/g, ' '); }
  finally { fs.unlinkSync(f); }
};

test('status: active, expired, revoked, none', () => {
  assert.equal(markPdfStatus(base, NOW, 30).k, 'active');
  assert.equal(markPdfStatus({ ...base, ev: [{ ...base.ev[0], t: '2026-08-01T00:00:00Z' }] }, NOW, 30).k, 'expired');
  assert.equal(markPdfStatus({ ...base, revoked: true }, NOW, 30).k, 'revoked');
  assert.equal(markPdfStatus({ ...base, ev: [] }, NOW, 30).k, 'none');
});

test('pdf is a valid single A4 page with core fields', () => {
  const d = buildMarkPdf(jsPDF, base, {}, NOW, { validDays: 30 });
  assert.equal(d.getNumberOfPages(), 1);
  const s = text(base);
  assert.ok(s.startsWith('%PDF-'));
  for (const w of ['Giratina VSTAR', '154790134', '$650', 'ACTIVE', 'gachagalaxy.io/platform#/cert/154790134', 'not completed sales'])
    assert.ok(s.includes(w), 'missing ' + w);
});

test('testnet/example records are watermarked pre-production', () => {
  const s = text({ ...base, network: 'robinhood-testnet', kind: 'example' });
  assert.ok(s.includes('PRE-PRODUCTION'));
  assert.ok(s.includes('Not a production Gacha Mark'));
  assert.ok(!text(base).includes('PRE-PRODUCTION'));
});

test('revoked records say so and carry no valid-until date', () => {
  const s = text({ ...base, revoked: true });
  assert.ok(s.includes('REVOKED'));
  assert.ok(!s.includes('2026-11-09'));
});

test('never claims sold prices unless basis is sold', () => {
  assert.ok(!text(base).includes('Price basis: completed sales'));
  assert.ok(text({ ...base, priceBasis: 'sold' }).includes('Price basis: completed sales'));
});

test('ascii sanitiser keeps PDF text Latin-safe', () => {
  assert.equal(markPdfAscii('Pokémon – ex · “x”'), 'Pokemon - ex | "x"');
});

test('handles missing images and long names without throwing', () => {
  const c = { ...base, name: 'Mega Evolution Promo First Partner Illustration S1 Full Art Chimchar', ev: [] };
  assert.doesNotThrow(() => buildMarkPdf(jsPDF, c, { slab: null, qr: null, seal: null }, NOW));
});
