// All requests/RPC replies below are synthetic in-memory objects. No submission,
// database, wallet, chain RPC, environment credentials, or child operation scripts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readSources, inspectSources, main } from './readiness.mjs';

const sources = await readSources();
const api = await import('data:text/javascript;base64,' + Buffer.from(sources.intake).toString('base64'));
globalThis.fetch = () => { throw new Error('NETWORK_FORBIDDEN'); };
const env = Object.freeze({ MARK_INTAKE_API_KEY: 'synthetic', MARK_INTAKE_RPC_TOKEN: 'synthetic', MARK_INTAKE_GATE: 'synthetic' });
const aggregate = () => ({ contract: 'mark-intake-v2', policy_scope: 'global', freeLimit: 10, remaining: 0 });
const claim = () => ({ ...aggregate(), id: '00000000-0000-0000-0000-000000000001',
  grader: 'PSA', cert: '123456', status: 'requested', free: false, existing: false });
const post = (handler, email = 'first@example.invalid') => handler.onRequestPost({ env,
  request: new Request('https://example.invalid/api/mark-request', { method: 'POST',
    body: JSON.stringify({ grader: 'PSA', cert: '123456', email }) }) });
const handler = data => api.createMarkIntake({ reviewed: true, fetcher: async () => Response.json(data) });

test('current source contract is recognized but never authorizes phase7/deployment', () => {
  const report = inspectSources(sources);
  assert.equal(report.sourceContractMatches, true);
  assert.equal(typeof report.sourceIntakeGate, 'boolean');
  assert.equal(report.phase7Ready, false);
  assert.equal(report.backendDeploymentAuthorized, false);
  assert.equal(report.blockers.length, 5);
});

test('source drift in status, binding, or payment gate fails the contract guard', () => {
  for (const [key, from, to] of [
    ['schema', "check (status = 'requested')", "check (status in ('requested','approved'))"],
    ['intake', "d.status !== 'requested'", "d.status !== 'approved'"],
    ['intake', '!env?.MARK_INTAKE_GATE', 'false'],
    ['payment', 'const PAYMENTS_AVAILABLE = false;', 'const PAYMENTS_AVAILABLE = true;']
  ]) {
    assert.ok(sources[key].includes(from));
    assert.equal(inspectSources({ ...sources, [key]: sources[key].replace(from, to) }).sourceContractMatches, false);
  }
});

test('CLI rejects apply mode and arbitrary input paths before reading anything', async () => {
  for (const args of [[], ['--apply'], ['--check', 'private.json'], ['--db-url', 'not-a-db']])
    await assert.rejects(main(args), /INVALID_ARGUMENTS/);
});

test('public GET ignores ID/cert query and strips extra private RPC fields', async () => {
  const calls = [];
  const h = api.createMarkIntake({ reviewed: true, fetcher: async (url, options) => {
    calls.push({ name: url.split('/').at(-1), args: JSON.parse(options.body) });
    return Response.json({ ...aggregate(), id: 'private-id', cert: '123456', email: 'private@example.invalid', status: 'requested' });
  } });
  const values = [];
  for (const query of ['', '?id=1', '?id=2&cert=123456', '?status=approved']) {
    const response = await h.onRequestGet({ env, request: new Request('https://example.invalid/api/mark-request' + query) });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const value = await response.json(); values.push(value);
    assert.deepEqual(Object.keys(value).sort(), ['ok','intakeStatus','supportedGraders','freeLeft','freeLimit','allowanceScope','paymentStatus','payUrl','evidence'].sort());
    assert.doesNotMatch(JSON.stringify(value), /private-id|private@example|123456|requested/);
  }
  for (const value of values) assert.deepEqual(value, values[0]);
  for (const call of calls) assert.deepEqual(call, { name: 'mark_intake_status_v2', args: { p_token: 'synthetic' } });
});

test('accepted POST allowlists output and never returns RPC contact or review metadata', async () => {
  const response = await post(handler({ ...claim(), email: 'private@example.invalid', reviewer: 'private-operator', notes: 'private-note' }));
  assert.equal(response.status, 200);
  const value = await response.json();
  assert.deepEqual(Object.keys(value).sort(), ['ok','intakeStatus','id','cert','grader','free','remaining','freeLimit','allowanceScope','existing','status','paymentStatus','payUrl','evidence'].sort());
  assert.equal(value.status, 'requested'); assert.equal(value.paymentStatus, 'inactive'); assert.equal(value.payUrl, null);
  assert.doesNotMatch(JSON.stringify(value), /private|example.invalid/);
});

test('all non-requested RPC statuses are rejected, not relabeled', async () => {
  // These are probe values, NOT an approved or existing workflow vocabulary.
  for (const status of ['pending','in_review','approved','rejected','signed','published','fulfilled',null]) {
    const response = await post(handler({ ...claim(), status }));
    assert.equal(response.status, 502);
    const value = await response.json();
    assert.equal(value.code, 'REQUEST_UNCONFIRMED');
    assert.equal(Object.hasOwn(value, 'status'), false);
    assert.equal(Object.hasOwn(value, 'id'), false);
  }
});

test('duplicate UUID is returned without requester authentication: never use it as an access capability', async () => {
  const h = handler({ ...claim(), existing: true });
  const first = await (await post(h, 'first@example.invalid')).json();
  const other = await (await post(h, 'other@example.invalid')).json();
  assert.equal(first.id, other.id); assert.equal(first.existing, true);
  assert.equal(other.status, 'requested');
  // Mock proves handler behavior only, not stored contact ownership or deployed DB behavior.
});

test('missing each required binding prevents even synthetic transport access', async () => {
  for (const name of Object.keys(env)) {
    const incomplete = { ...env }; delete incomplete[name];
    const h = api.createMarkIntake({ reviewed: true, fetcher: () => assert.fail('transport must not run') });
    const response = await h.onRequestGet({ env: incomplete });
    assert.equal(response.status, 503);
  }
});

test('explicit closed factory never reads bindings and webhook source remains disabled', async () => {
  const forbidden = new Proxy({}, { get() { assert.fail('must not read bindings'); } });
  const h = api.createMarkIntake({ reviewed: false, fetcher: () => assert.fail('no transport') });
  assert.equal((await h.onRequestGet({ env: forbidden })).status, 503);
  const webhook = await import('data:text/javascript;base64,' + Buffer.from(sources.payment).toString('base64'));
  assert.equal((await webhook.onRequestPost({ env: forbidden, request: null })).status, 503);
});
