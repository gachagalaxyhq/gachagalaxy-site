// Synthetic rehearsal only. No manifest file, DB URL, credential, network or
// apply option is accepted. This is NOT an importer for any legacy database.
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { planCutover } from './mark-cutover.mjs';

const exec = promisify(execFile);
const env = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' };
const literal = value => "'" + value.replaceAll("'", "''") + "'";
const hash = value => createHash('sha256').update(value).digest('hex');
const ensure = (ok, code) => { if (!ok) throw new Error(code); };

export function syntheticManifest({ retained = false } = {}) {
  return { contract: 'mark-legacy-reconciliation-v1',
    snapshot: { reference: 'SYNTHETIC-SNAPSHOT', sha256: hash('SYNTHETIC-NOT-REAL-HISTORY'), complete: true, rowCount: 2 },
    historicalUsed: 14, usageReference: 'SYNTHETIC-USAGE',
    records: [
      { legacyId: 'SYNTHETIC-LEGACY-1', targetId: '00000000-0000-0000-0000-000000000001',
        grader: 'PSA', cert: '980001', status: 'requested', free: true,
        disposition: 'import-requested', reference: 'SYNTHETIC-MAPPING' },
      { legacyId: 'SYNTHETIC-LEGACY-2', targetId: retained ? null : '00000000-0000-0000-0000-000000000002',
        grader: 'CGC', cert: '980002', status: retained ? 'fulfilled' : 'requested', free: false,
        disposition: retained ? 'retain-legacy' : 'import-requested', reference: 'SYNTHETIC-MAPPING' }
    ], approvals: Object.fromEntries(['schemaReview', 'policy', 'identityContactRules', 'legacyWriteFreeze',
      'legacyGrantClosure', 'contactOperations', 'abuseControls', 'gatewayPrivileges', 'stagingRehearsal']
      .map(key => [key, 'SYNTHETIC-NOT-OWNER-APPROVAL'])) };
}

// Includes complete rows, timestamps, audit and receipt state, not just counts.
// The lock below is acquired BEFORE comparing this state, including on replay.
export const targetStateSQL = `select jsonb_build_object(
  'policy', (select coalesce(jsonb_agg(to_jsonb(policy_row) order by singleton), '[]'::jsonb) from mark_intake_private.policy policy_row),
  'requests', (select coalesce(jsonb_agg(to_jsonb(r) order by id), '[]'::jsonb) from mark_intake_private.requests r),
  'audit', (select coalesce(jsonb_agg(to_jsonb(a) order by event_id), '[]'::jsonb) from mark_intake_private.contact_audit a),
  'receipts', (select coalesce(jsonb_agg(to_jsonb(x) order by manifest_sha256), '[]'::jsonb) from mark_rehearsal.receipts x)
)::text`;

// Pure compiler, restricted to the two hard-coded fixtures. No real normalized
// export can be supplied even by an importing caller. Contacts use reserved
// .invalid addresses and created_at is explicitly synthetic, never legacy history.
export function rehearsalTransaction(manifest, expectedDigest, expectedTarget) {
  const plan = planCutover(manifest);
  const encoded = JSON.stringify(manifest);
  ensure([syntheticManifest(), syntheticManifest({ retained: true })]
    .some(fixture => JSON.stringify(fixture) === encoded), 'BUILT_IN_SYNTHETIC_FIXTURE_ONLY');
  ensure(plan.inputSha256 === expectedDigest, 'MANIFEST_DIGEST_MISMATCH');
  ensure(plan.evidenceComplete, 'UNAPPROVED_EXCLUSION_OR_EVIDENCE');
  ensure(typeof expectedTarget === 'string' && expectedTarget.length < 1024 * 1024, 'TARGET_PRECONDITION_REQUIRED');
  // Validate JSON here; PostgreSQL compares jsonb structurally, not key order.
  JSON.parse(expectedTarget);
  const rows = literal(JSON.stringify(plan.mapping));
  const digest = literal(expectedDigest);
  const block = `declare current_state jsonb; receipt mark_rehearsal.receipts%rowtype; p mark_intake_private.policy%rowtype;
    begin
      if encode(sha256(convert_to(${literal(encoded)},'UTF8')),'hex') <> ${digest} then
        raise exception 'MANIFEST_DIGEST_MISMATCH';
      end if;
      current_state := (${targetStateSQL});
      if current_state is distinct from ${literal(expectedTarget)}::jsonb then
        raise exception 'STALE_TARGET_PRECONDITION';
      end if;
      select * into strict p from mark_intake_private.policy;
      if p.approved or p.legacy_reconciled or p.scope is not null or p.approval_reference is not null
        or p.free_limit <> 10 then raise exception 'CLOSED_TARGET_REQUIRED'; end if;
      select * into receipt from mark_rehearsal.receipts where manifest_sha256=${digest};
      if found then
        if receipt.mapping is distinct from ${rows}::jsonb or p.used is distinct from ${plan.historicalUsed}
          or (select count(*) from mark_rehearsal.receipts) <> 1
          or exists(select 1 from mark_intake_private.contact_audit)
          or (select coalesce(jsonb_agg(jsonb_build_object('id',id,'grader',grader,'cert',cert,
            'email',email,'status',status,'free',free,'created_at',created_at) order by id),'[]'::jsonb)
            from mark_intake_private.requests) is distinct from receipt.imported_rows then
          raise exception 'REPLAY_STATE_MISMATCH';
        end if;
      else
        if p.used is not null or exists(select 1 from mark_intake_private.requests)
          or exists(select 1 from mark_intake_private.contact_audit)
          or exists(select 1 from mark_rehearsal.receipts) then
          raise exception 'EMPTY_UNRECONCILED_TARGET_REQUIRED';
        end if;
        insert into mark_intake_private.requests(id,grader,cert,email,status,free,created_at)
          select (r->>'targetId')::uuid,r->>'grader',r->>'cert',
            'synthetic-' || (r->>'cert') || '@example.invalid',r->>'status',(r->>'free')::boolean,
            '2000-01-01T00:00:00Z'::timestamptz
          from jsonb_array_elements(${rows}::jsonb) r;
        update mark_intake_private.policy set used=${plan.historicalUsed};
        insert into mark_rehearsal.receipts(manifest_sha256,mapping,imported_rows)
          select ${digest},${rows}::jsonb,
            jsonb_agg(to_jsonb(r) order by id) from mark_intake_private.requests r;
      end if;
    end`;
  return `begin;
    set local standard_conforming_strings=on;
    set local lock_timeout='2s'; set local statement_timeout='5s';
    lock table mark_intake_private.policy, mark_intake_private.requests,
      mark_intake_private.contact_audit, mark_rehearsal.receipts in exclusive mode;
    do ${literal(block)};
    commit;`;
}

// The ONLY execution target is a cluster created here. No inherited PG* or
// startup files, no TCP, no existing socket/server, no persisted credential.
// Callback is for local tests; the CLI never accepts SQL or input data.
export async function withSyntheticTarget(bin, callback) {
  ensure(typeof bin === 'string' && bin.startsWith('/'), 'ABSOLUTE_POSTGRES_BIN_REQUIRED');
  let root, started = false;
  try {
    root = await mkdtemp('/tmp/opencode/mark-import-synthetic-');
    await exec(join(bin, 'initdb'), ['-D', join(root, 'data'), '-U', 'mark_synthetic_owner', '-A', 'trust', '--no-locale'], { env });
    await exec(join(bin, 'pg_ctl'), ['-D', join(root, 'data'), '-l', join(root, 'server.log'), '-o',
      `-c listen_addresses='' -c unix_socket_directories='${root}' -c unix_socket_permissions=0700`, '-w', 'start'], { env });
    started = true;
    // execFile has no stdin option; use a child pipe, keeping SQL off argv.
    const { spawn } = await import('node:child_process');
    const query = text => new Promise((resolve, reject) => {
      const child = spawn(join(bin, 'psql'), ['-X', '-h', root, '-U', 'mark_synthetic_owner', '-d', 'postgres',
        '-A', '-t', '-q', '-v', 'ON_ERROR_STOP=1'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
      child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 2 * 1024 * 1024) child.kill('SIGKILL'); });
      child.stderr.on('data', chunk => { stderr += chunk; if (stderr.length > 2 * 1024 * 1024) child.kill('SIGKILL'); });
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('close', code => { clearTimeout(timer); code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr || 'LOCAL_PSQL_FAILED')); });
      child.stdin.on('error', () => {});
      child.stdin.end(text);
    });
    await query('create role anon; create role authenticated; create role service_role;');
    for (const name of ['20261107_mark_intake_v2.sql', '20261107_mark_contact_ops.sql']) {
      await query(await readFile(new URL('../supabase/migrations/' + name, import.meta.url), 'utf8'));
    }
    // Test-only receipt state, not a deployment migration or exclusion table.
    await query(`create schema mark_rehearsal; revoke all on schema mark_rehearsal from public;
      create table mark_rehearsal.receipts(manifest_sha256 text primary key check(manifest_sha256 ~ '^[a-f0-9]{64}$'),
        mapping jsonb not null, imported_rows jsonb not null);
      alter table mark_rehearsal.receipts enable row level security;
      revoke all on mark_rehearsal.receipts from public,anon,authenticated,service_role,mark_intake_rpc;`);
    return await callback({ query, state: () => query(targetStateSQL) });
  } finally {
    if (started) await exec(join(bin, 'pg_ctl'), ['-D', join(root, 'data'), '-m', 'immediate', '-w', 'stop'], { env });
    if (root) await rm(root, { recursive: true, force: true });
  }
}

export async function main(args) {
  ensure(args.length === 3 && args[0] === '--synthetic' && args[1] === '--postgres-bin', 'SYNTHETIC_USAGE_ONLY');
  return withSyntheticTarget(args[2], async ({ query, state }) => {
    const manifest = syntheticManifest();
    const digest = planCutover(manifest).inputSha256;
    await query(rehearsalTransaction(manifest, digest, await state()));
    const committed = await state();
    await query(rehearsalTransaction(manifest, digest, committed));
    ensure(await state() === committed, 'REPLAY_CHANGED_TARGET');
    const final = JSON.parse(committed);
    ensure(final.requests.length === 2 && final.receipts.length === 1 && final.policy[0].used === 14 &&
      final.policy[0].approved === false && final.policy[0].legacy_reconciled === false, 'REHEARSAL_VERIFICATION_FAILED');
    return { syntheticOnly: true, imported: 2, historicalUsed: 14, replayUnchanged: true,
      publicIntakeEnabled: false, paymentsEnabled: false, liveVerified: false };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.stdout.write(JSON.stringify(await main(process.argv.slice(2))) + '\n'); }
  catch { process.stderr.write('Synthetic rehearsal refused or failed; no live verification.\n'); process.exitCode = 1; }
}
