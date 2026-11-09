import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadRevoked, plan } from '../scripts/republish_marks.mjs';

test('revoked Marks are skipped, others republished', () => {
  const r = loadRevoked(JSON.stringify({ revoked: [{ grader: 'psa', cert: '109308847', reason: 'x', at: '2026-11-09' }] }));
  assert.deepEqual(plan(['109308847', '100863346'], r), { publish: ['100863346'], skipped: ['109308847'] });
});
test('malformed revocation list fails closed', () => {
  for (const bad of ['{}', '{"revoked":{}}', '{"revoked":[{"grader":"PSA","cert":"../x"}]}', 'nope'])
    assert.throws(() => loadRevoked(bad));
});
test('shipped revocation list is valid', () => {
  loadRevoked(fs.readFileSync(new URL('../src/revoked.json', import.meta.url), 'utf8'));
});
