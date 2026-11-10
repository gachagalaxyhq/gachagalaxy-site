// Opt-in real PostgreSQL rehearsal. Creates/stops its OWN disposable cluster;
// never accepts a connection URL, reads credentials, or uses an existing server.
// Run: MARK_TEST_POSTGRES_BIN=/usr/lib/postgresql/16/bin node --test tests/mark-intake-postgres.mjs
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import vm from 'node:vm';

const exec = promisify(execFile);
const bin = process.env.MARK_TEST_POSTGRES_BIN;
if (!bin?.startsWith('/')) throw new Error('Explicit absolute MARK_TEST_POSTGRES_BIN required; no external database accepted');
let root, started = false;
const env = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }; // No PG*, keys, or user startup files inherited.
const migration = await readFile(new URL('../supabase/migrations/20261107_mark_intake_v2.sql', import.meta.url), 'utf8');
const sql = async text => (await exec(join(bin, 'psql'), ['-X', '-h', root, '-U', 'intake_local_owner', '-d', 'postgres',
  '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', text], { env, timeout: 15000, maxBuffer: 1024 * 1024 })).stdout.trim();
const claim = (cert, grader = 'PSA', email = 'synthetic@example.invalid') =>
  `select public.claim_mark_v2('${grader}','${cert}','${email}');`;
const result = text => JSON.parse(text.split('\n').find(line => line.startsWith('{')));
const handlerSource = await readFile(new URL('../functions/api/mark-request.js', import.meta.url), 'utf8');
const intakeApi = await import('data:text/javascript;base64,' + Buffer.from(handlerSource).toString('base64'));
const pageSource = await readFile(new URL('../public/check.html', import.meta.url), 'utf8');
// All three scoped bindings are required since the gate token was added (otherwise 503 before transport).
const localConfig = { MARK_INTAKE_API_KEY:'local-only', MARK_INTAKE_RPC_TOKEN:'local-only', MARK_INTAKE_GATE:'local-only' };
// Transport adapter only: every successful response comes from the actual SQL
// RPC under the actual scoped role, on this harness's disposable server.
async function localGateway(url, options) {
  const args = JSON.parse(options.body);
  const quote = s => "'" + s.replaceAll("'", "''") + "'";
  const name = new URL(url).pathname.split('/').at(-1);
  assert.ok(['claim_mark_v2','mark_intake_status_v2'].includes(name));
  const call = name === 'claim_mark_v2'
    ? `select public.claim_mark_v2(${[args.p_grader,args.p_cert,args.p_email].map(quote).join(',')})`
    : 'select public.mark_intake_status_v2()';
  try { return Response.json(result(await sql('set role mark_intake_rpc; '+call))); }
  catch (error) { return Response.json({}, {status:/Intake approval required/.test(error.stderr)?409:500}); }
}
async function intakePage(handler, transport = fn => fn()) {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id,{value:'',disabled:false,textContent:'',className:'',events:{},
      addEventListener(name, fn){this.events[name]=fn;}});
    return elements.get(id);
  };
  const calls = [];
  const context = vm.createContext({URLSearchParams,console,document:{getElementById:element},
    location:{search:'?cert=00109-863-355&grader=PSA'},fetch:async (url,options) => {
      assert.equal(url,'/api/mark-request'); calls.push(options?.method||'GET');
      return transport(() => options?.method==='POST'
        ? handler.onRequestPost({env:localConfig,request:new Request('https://local.invalid'+url,options)})
        : handler.onRequestGet({env:localConfig}));
    }});
  const script = [...pageSource.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1];
  // Await status completion without replacing the production status function.
  await vm.runInContext(script.replace('  loadStatus();','  return loadStatus();'),context);
  element('remail').value=' FRONTEND@EXAMPLE.INVALID ';
  return {element,calls,submit:()=>element('rq').events.submit({preventDefault(){}})};
}
async function reset(used = 9) {
  await sql(`truncate mark_intake_private.requests;
    update mark_intake_private.policy set approved=true, legacy_reconciled=true,
    scope='global', used=${used}, approval_reference='SYNTHETIC LOCAL FIXTURE ONLY';`);
}
async function waitFor(query, predicate) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (predicate(await sql(query))) return;
    await new Promise(r => setTimeout(r, 30));
  }
  throw new Error('Expected independent-session lock state not observed');
}
async function contention(queries, ending = 'commit') {
  // A dedicated backend holds the very policy lock used by the RPC. Contenders
  // MUST be observed waiting on it, not merely submitted through Promise.all.
  const holder = sql(`set application_name='intake_lock_holder'; begin;
    select singleton from mark_intake_private.policy for update;
    select pg_sleep(3); ${ending};`);
  await waitFor(`select count(*) from pg_stat_activity where application_name='intake_lock_holder' and wait_event='PgSleep'`, s => s === '1');
  const pending = queries.map((q, i) => sql(`set application_name='intake_contender_${i}'; ${q}`)
    .then(value => ({ value }), error => ({ error })));
  await waitFor(`select count(distinct pid) from pg_stat_activity where application_name like 'intake_contender_%' and wait_event_type='Lock'`, s => Number(s) === queries.length);
  await holder;
  return Promise.all(pending);
}

before(async () => {
  root = await mkdtemp('/tmp/opencode/mark-pg-local-');
  await exec(join(bin, 'initdb'), ['-D', join(root, 'data'), '-U', 'intake_local_owner', '-A', 'trust', '--no-locale'], { env });
  await exec(join(bin, 'pg_ctl'), ['-D', join(root, 'data'), '-l', join(root, 'server.log'), '-o',
    `-c listen_addresses='' -c unix_socket_directories='${root}' -c unix_socket_permissions=0700 -c max_connections=40`, '-w', 'start'], { env });
  started = true;
  await sql('create role anon; create role authenticated; create role service_role;');
  await sql(migration);
  console.log('Disposable socket-only PostgreSQL:', await sql('show server_version;'));
});
after(async () => {
  if (started) await exec(join(bin, 'pg_ctl'), ['-D', join(root, 'data'), '-m', 'immediate', '-w', 'stop'], { env });
  if (root) await rm(root, { recursive: true, force: true });
});

test('actual frontend → handler → scoped SQL RPC saves, retries, separates graders, and never issues or charges', async () => {
  const reviewed = intakeApi.createMarkIntake({reviewed:true,fetcher:localGateway});
  // The default migration, even with the reviewed handler, has no configured usage.
  const closed = await intakePage(reviewed);
  assert.equal(closed.element('rgo').disabled,true);
  // Live check.html copy for an unconfirmed/closed status (was 'Request intake unavailable').
  assert.match(closed.element('rn').textContent,/Request availability could not be confirmed\. No request has been sent/);
  await closed.submit();
  assert.deepEqual(closed.calls,['GET']);
  assert.equal(await sql('select used is null from mark_intake_private.policy'),'t');
  assert.equal(await sql('select count(*) from mark_intake_private.requests'),'0');
  await reset(9); // Fixture only; never inferred history or production approval.
  let release,wait=false;
  const p = await intakePage(reviewed,fn=>wait?new Promise(resolve=>{release=()=>resolve(fn());}):fn());
  assert.equal(p.element('rgo').disabled,false);
  assert.match(p.element('freeleft').textContent,/1 of 10/);
  wait=true;
  const pending=p.submit();
  assert.equal(p.element('rgo').disabled,true);
  assert.equal(p.element('remail').disabled,true);
  assert.match(p.element('rn').textContent,/Sending request/);
  await p.submit(); // Double click cannot send a second request.
  assert.deepEqual(p.calls,['GET','POST']);
  wait=false;release();await pending;
  assert.match(p.element('rn').textContent,/Request saved.*PSA cert 109863355/);
  assert.match(p.element('rn').textContent,/Complimentary request allocation recorded/);
  assert.match(p.element('rn').textContent,/not an issued Mark.*No payment collected/);
  assert.equal(p.element('rgo').disabled,false);
  const first=JSON.parse(await sql("select row_to_json(r) from mark_intake_private.requests r"));
  assert.equal(first.email,'frontend@example.invalid');assert.equal(first.status,'requested');
  p.element('remail').value='replacement@example.invalid';
  await p.submit();
  assert.match(p.element('rn').textContent,/Request already exists.*Original contact/);
  assert.match(p.element('rn').textContent,new RegExp(first.id));
  assert.equal(await sql('select email from mark_intake_private.requests'),'frontend@example.invalid');
  assert.equal(await sql('select used from mark_intake_private.policy'),'10');
  p.element('rgr').value='CGC';await p.submit();
  assert.match(p.element('rn').textContent,/Request saved for CGC/);
  assert.match(p.element('rn').textContent,/No complimentary allocation recorded.*no paid processing started/);
  assert.equal(await sql('select count(distinct id) from mark_intake_private.requests'),'2');
  assert.equal(await sql('select used from mark_intake_private.policy'),'10');
  // Revocation between status and submit must override the enabled client.
  await sql('update mark_intake_private.policy set approved=false');
  p.element('rcert').value='777777';await p.submit();
  assert.equal(p.element('rgo').disabled,true);
  // Live check.html copy for a 503 'unavailable' POST (was 'configured policy is not approved').
  assert.match(p.element('rn').textContent,/Requests are currently unavailable\. No request saved, payment collected or Mark issued/);
  assert.equal(await sql('select count(*) from mark_intake_private.requests'),'2');
  // Restore the default closed state for subsequent independent tests.
  await sql('truncate mark_intake_private.requests; update mark_intake_private.policy set approved=false,legacy_reconciled=false,scope=null,used=null,approval_reference=null');
});

test('frontend lost-response retry reaches real handler and retains the committed request', async () => {
  await reset(8);
  const reviewed = intakeApi.createMarkIntake({reviewed:true,fetcher:localGateway});
  let lose=false;
  const p=await intakePage(reviewed,async fn=>{const response=await fn();if(lose){lose=false;throw new Error('lost reply after commit');}return response;});
  lose=true;await p.submit();
  assert.match(p.element('rn').textContent,/could not be confirmed.*Retry with the same grader and cert/);
  assert.equal(p.element('rgo').disabled,false);
  assert.equal(p.element('rcert').value,'00109-863-355');
  assert.equal(await sql('select count(*) from mark_intake_private.requests'),'1');
  await p.submit();
  assert.match(p.element('rn').textContent,/Request already exists/);
  assert.equal(await sql('select used from mark_intake_private.policy'),'9');
  // Actual exported production handler remains closed despite approved fixture DB.
  const production=await intakePage(intakeApi);
  assert.equal(production.element('rgo').disabled,true);
  await production.submit();assert.deepEqual(production.calls,['GET']);
  await sql('truncate mark_intake_private.requests; update mark_intake_private.policy set approved=false,legacy_reconciled=false,scope=null,used=null,approval_reference=null');
});

test('frontend validation and actual database failure show errors, retain inputs and allow retry', async () => {
  await reset(9);
  const reviewed=intakeApi.createMarkIntake({reviewed:true,fetcher:localGateway});
  const p=await intakePage(reviewed);
  for(const [id,value,expected] of [['rcert','abc109863355',/cert number/],['rgr','OTHER',/Choose the grader/],['remail','bad',/valid contact email/]]){
    const original=p.element(id).value;p.element(id).value=value;await p.submit();
    assert.match(p.element('rn').textContent,expected);assert.deepEqual(p.calls,['GET']);
    p.element(id).value=original;
  }
  await sql(`create function mark_intake_private.frontend_fail() returns trigger language plpgsql as $$
    begin raise exception 'private failure'; end $$;
    create trigger frontend_fail after insert on mark_intake_private.requests
    for each row execute function mark_intake_private.frontend_fail();`);
  await p.submit();
  assert.match(p.element('rn').textContent,/could not be confirmed/);
  assert.doesNotMatch(p.element('rn').textContent,/private failure|Request saved/);
  assert.equal(p.element('rgo').disabled,false);
  assert.equal(p.element('remail').disabled,false);
  assert.equal(await sql('select count(*) from mark_intake_private.requests'),'0');
  assert.equal(await sql('select used from mark_intake_private.policy'),'9');
  await sql('drop trigger frontend_fail on mark_intake_private.requests; drop function mark_intake_private.frontend_fail()');
  await p.submit();assert.match(p.element('rn').textContent,/Request saved/);
  await sql('truncate mark_intake_private.requests; update mark_intake_private.policy set approved=false,legacy_reconciled=false,scope=null,used=null,approval_reference=null');
});

test('contact operations migration: real PostgreSQL owner-only audited erasure retains decisions', async () => {
  await reset(9);
  await sql(await readFile(new URL('../supabase/migrations/20261107_mark_contact_ops.sql', import.meta.url), 'utf8'));
  const first = result(await sql(claim('890000')));
  await sql(`update mark_intake_private.requests set created_at='2020-01-01' where id='${first.id}'`);
  for (const role of ['anon','authenticated','service_role','mark_intake_rpc']) {
    await assert.rejects(sql(`set role ${role}; select mark_intake_private.read_contact('${first.id}','SYNTHETIC')`), /permission denied/);
    await assert.rejects(sql(`set role ${role}; select mark_intake_private.erase_contacts(array['${first.id}'::uuid],now(),'SYNTHETIC')`), /permission denied/);
    await assert.rejects(sql(`set role ${role}; select * from mark_intake_private.contact_audit`), /permission denied/);
  }
  assert.equal(await sql(`select mark_intake_private.read_contact('${first.id}','SYNTHETIC')`), 'synthetic@example.invalid');
  await assert.rejects(sql(`select mark_intake_private.erase_contacts(array['${first.id}'::uuid,
    'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid],'2021-01-01','SYNTHETIC')`), /selection mismatch/);
  assert.equal(await sql('select email from mark_intake_private.requests'), 'synthetic@example.invalid');
  assert.equal(await sql(`select mark_intake_private.erase_contacts(array['${first.id}'::uuid],'2021-01-01','SYNTHETIC')`), '1');
  const retry = result(await sql(claim('890000', 'PSA', 'replacement@example.invalid')));
  assert.equal(retry.id, first.id); assert.equal(retry.existing, true); assert.equal(retry.free, true);
  assert.equal(await sql('select email is null from mark_intake_private.requests'), 't');
  assert.equal(await sql('select used from mark_intake_private.policy'), '10');
  assert.equal(await sql(`select string_agg(action,',' order by event_id) from mark_intake_private.contact_audit`), 'read,erase');
  // Keep the pre-existing nine tests independent if the entire file is run.
  await sql(`drop function mark_intake_private.read_contact(uuid,text);
    drop function mark_intake_private.erase_contacts(uuid[],timestamptz,text);
    drop table mark_intake_private.contact_audit;
    truncate mark_intake_private.requests;
    alter table mark_intake_private.requests alter column email set not null;
    update mark_intake_private.policy set approved=false, legacy_reconciled=false, scope=null, used=null, approval_reference=null;`);
});

test('unapproved/unknown policy, partial approval, and missing singleton fail closed', async () => {
  await assert.rejects(sql(claim('800000')), /Intake approval required/);
  await assert.rejects(sql('select public.mark_intake_status_v2()'), /Intake approval required/);
  for (const patch of ["approved=true", "approved=true,legacy_reconciled=true,scope='global',used=0",
    "approved=true,legacy_reconciled=true,scope='global',used=0,approval_reference=' '"]) {
    await assert.rejects(sql(`update mark_intake_private.policy set ${patch}`), /check constraint/);
  }
  await sql('begin; delete from mark_intake_private.policy; commit;');
  await assert.rejects(sql(claim('800000')), /Intake approval required/);
  await sql('insert into mark_intake_private.policy(singleton) values(true)');
  assert.equal(await sql('select count(*) from mark_intake_private.requests'), '0');
});

test('20 independent blocked sessions race for one remaining slot without over-allocation', async () => {
  await reset(9);
  const rows = await contention(Array.from({ length: 20 }, (_, i) => claim(String(810000 + i))));
  assert.ok(rows.every(r => !r.error));
  const ds = rows.map(r => result(r.value));
  assert.equal(ds.filter(d => d.free).length, 1);
  assert.equal(ds.filter(d => !d.free).length, 19);
  assert.ok(ds.every(d => d.remaining === 0));
  assert.equal(new Set(ds.map(d => d.id)).size, 20);
  assert.equal(await sql('select used from mark_intake_private.policy'), '10');
  assert.equal(await sql('select count(*) from mark_intake_private.requests where free'), '1');
});

test('12 independent duplicate retries preserve one ID/contact/allocation; graders stay separate', async () => {
  await reset(8);
  const rows = await contention(Array.from({ length: 12 }, (_, i) => claim('820000', 'PSA', `synthetic${i}@example.invalid`)));
  assert.ok(rows.every(r => !r.error));
  const ds = rows.map(r => result(r.value));
  assert.equal(new Set(ds.map(d => d.id)).size, 1);
  assert.equal(ds.filter(d => !d.existing).length, 1);
  assert.ok(ds.every(d => d.free && d.remaining === 1 && !('email' in d)));
  const contact = await sql('select email from mark_intake_private.requests');
  const retry = result(await sql(claim('820000', 'PSA', 'replacement@example.invalid')));
  assert.equal(retry.existing, true);
  assert.equal(await sql('select email from mark_intake_private.requests'), contact);
  const cgc = result(await sql(claim('820000', 'CGC')));
  assert.notEqual(cgc.id, retry.id);
  assert.equal(cgc.free, true);
  assert.equal(await sql('select used from mark_intake_private.policy'), '10');
});

test('rolled-back allocation releases the slot to a blocked independent retry', async () => {
  await reset(9);
  const first = sql(`set application_name='intake_rollback_holder'; begin; ${claim('830000')}
    select pg_sleep(3); rollback;`);
  await waitFor(`select count(*) from pg_stat_activity where application_name='intake_rollback_holder' and wait_event='PgSleep'`, s => s === '1');
  const retry = sql(`set application_name='intake_rollback_retry'; ${claim('830000')}`);
  await waitFor(`select count(*) from pg_stat_activity where application_name='intake_rollback_retry' and wait_event_type='Lock'`, s => s === '1');
  await first;
  const d = result(await retry);
  assert.equal(d.free, true); assert.equal(d.existing, false);
  assert.equal(await sql('select count(*) from mark_intake_private.requests'), '1');
  assert.equal(await sql('select used from mark_intake_private.policy'), '10');
});

test('committed approval revocation is respected by a blocked session', async () => {
  await reset(9);
  const holder = sql(`set application_name='intake_revoke_holder'; begin;
    update mark_intake_private.policy set approved=false; select pg_sleep(3); commit;`);
  await waitFor(`select count(*) from pg_stat_activity where application_name='intake_revoke_holder' and wait_event='PgSleep'`, s => s === '1');
  const retry = sql(`set application_name='intake_revoke_retry'; ${claim('840000')}`).then(value => ({ value }), error => ({ error }));
  await waitFor(`select count(*) from pg_stat_activity where application_name='intake_revoke_retry' and wait_event_type='Lock'`, s => s === '1');
  await holder;
  assert.match((await retry).error?.stderr || '', /Intake approval required/);
  assert.equal(await sql('select count(*) from mark_intake_private.requests'), '0');
  assert.equal(await sql('select used from mark_intake_private.policy'), '9');
});

test('counter-update failure rolls back inserted request and retry commits only once', async () => {
  await reset(9);
  await sql(`create function mark_intake_private.fail_update() returns trigger language plpgsql as $$
    begin raise exception 'synthetic update failure'; end $$;
    create trigger fail_update after update on mark_intake_private.policy for each row execute function mark_intake_private.fail_update();`);
  await assert.rejects(sql(claim('850000')), /synthetic update failure/);
  assert.equal(await sql('select count(*) from mark_intake_private.requests'), '0');
  assert.equal(await sql('select used from mark_intake_private.policy'), '9');
  await sql('drop trigger fail_update on mark_intake_private.policy');
  const d = result(await sql(claim('850000')));
  const retry = result(await sql(claim('850000'))); // First committed response intentionally not used by retry.
  assert.equal(retry.id, d.id); assert.equal(retry.existing, true);
  assert.equal(await sql('select used from mark_intake_private.policy'), '10');
});

test('real PostgreSQL roles, RLS, function configuration and invalid direct RPC inputs', async () => {
  await reset(14);
  for (const role of ['anon', 'authenticated', 'service_role', 'mark_intake_rpc']) {
    await assert.rejects(sql(`set role ${role}; select * from mark_intake_private.requests`), /permission denied/);
    await assert.rejects(sql(`set role ${role}; update mark_intake_private.policy set used=0`), /permission denied/);
    if (role !== 'mark_intake_rpc') {
      await assert.rejects(sql(`set role ${role}; ${claim('860000')}`), /permission denied/);
      await assert.rejects(sql(`set role ${role}; select public.mark_intake_status_v2()`), /permission denied/);
    }
  }
  const d = result(await sql(`set role mark_intake_rpc; ${claim('860000')}`));
  assert.equal(d.free, false); assert.equal(d.remaining, 0);
  assert.equal(await sql('select used from mark_intake_private.policy'), '14');
  for (const args of ["NULL,'123456','a@example.invalid'", "'OTHER','123456','a@example.invalid'",
    "'PSA','000000','a@example.invalid'", "'PSA','123456','A@EXAMPLE.INVALID'", "'PSA','123456','bad'"]) {
    await assert.rejects(sql(`select public.claim_mark_v2(${args})`), /Invalid intake fields/);
  }
  assert.equal(await sql(`select count(*) from pg_class where relnamespace='mark_intake_private'::regnamespace and relrowsecurity`), '2');
  assert.equal(await sql(`select count(*) from pg_policies where schemaname='mark_intake_private'`), '0');
  assert.equal(await sql(`select count(*) from pg_proc where proname in ('claim_mark_v2','mark_intake_status_v2')
    and prosecdef and proconfig=array['search_path=pg_catalog']`), '2');
});

test('migration conflicts abort rather than mutating existing candidate state', async () => {
  const before = await sql('select row_to_json(p) from mark_intake_private.policy p');
  await assert.rejects(sql(migration), /already exists/);
  assert.equal(await sql('select row_to_json(p) from mark_intake_private.policy p'), before);
  assert.equal(await sql('select count(*) from mark_intake_private.requests'), '1');
});

test('NOINHERIT does not remove PUBLIC RPC privileges: existing gateway grants require audit', async () => {
  // Synthetic harmless legacy-like function demonstrates why the clean fixture
  // cannot certify least privilege across an unknown deployed public schema.
  await sql(`create function public.synthetic_legacy_probe() returns integer language sql as $$ select 1 $$;
    grant execute on function public.synthetic_legacy_probe() to public;`);
  try {
    assert.equal((await sql('set role mark_intake_rpc; select public.synthetic_legacy_probe()')).split('\n').at(-1), '1');
    await sql('revoke execute on function public.synthetic_legacy_probe() from public');
    await assert.rejects(sql('set role mark_intake_rpc; select public.synthetic_legacy_probe()'), /permission denied/);
    assert.equal(await sql(`select count(*) from pg_roles where rolname='mark_intake_rpc'
      and not rolcanlogin and not rolinherit and not rolbypassrls and not rolsuper and not rolcreaterole and not rolcreatedb`), '1');
  } finally { await sql('drop function public.synthetic_legacy_probe()'); }
});
