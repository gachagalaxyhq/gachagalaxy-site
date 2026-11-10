#!/usr/bin/env python3
"""Phase 7 review-queue tests against a REAL local PostgreSQL (see run.sh).

Connects only to 127.0.0.1:$PHASE7_PORT (the throwaway cluster run.sh made).
Staff calls go the PostgREST way: login as `authenticator`, SET LOCAL ROLE
authenticated, set request.jwt.claims, call public.review_transition.
"""
import json, os, subprocess, sys, threading, time, traceback, uuid
import psycopg2
import psycopg2.errors

REPO = os.environ['PHASE7_REPO']
PORT = int(os.environ['PHASE7_PORT'])
PSQL = os.environ['PHASE7_PSQL']
MIG = os.path.join(REPO, 'supabase', 'migrations')
HERE = os.path.join(REPO, 'tests', 'phase7')
ENV = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'}

U = {name: str(uuid.uuid5(uuid.NAMESPACE_URL, 'phase7-test:' + name)) for name in
     ['matthew', 'rev2', 'pub1', 'pubrev', 'nonstaff', 'inactive', 'admin2']}

RESULTS = []


def conn(user='postgres', autocommit=True):
    c = psycopg2.connect(host='127.0.0.1', port=PORT, user=user, dbname='postgres')
    c.autocommit = autocommit
    return c


def psql(user, *args, check=True):
    cmd = [PSQL, '-X', '-q', '-h', '127.0.0.1', '-p', str(PORT), '-U', user, '-d', 'postgres',
           '-v', 'ON_ERROR_STOP=1', *args]
    p = subprocess.run(cmd, env=ENV, capture_output=True, text=True)
    if check and p.returncode != 0:
        raise AssertionError(f'psql failed: {" ".join(args)}\n{p.stderr}')
    return p


def apply(name, user='postgres'):
    psql(user, '-f', os.path.join(MIG, name))


def q(sql, args=None, user='postgres'):
    with conn(user) as c, c.cursor() as cur:
        cur.execute(sql, args)
        return cur.fetchall() if cur.description else None


def q1(sql, args=None, user='postgres'):
    rows = q(sql, args, user)
    return rows[0][0] if rows else None


def claims(who, aal='aal2', role='authenticated'):
    return json.dumps({'sub': U[who], 'role': role, 'aal': aal})


class Session:
    """One PostgREST-like client connection for a given JWT."""
    def __init__(self, who=None, aal='aal2', role='authenticated'):
        self.c = conn('authenticator', autocommit=False)
        self.role = role
        self.claims = claims(who, aal, role) if who else json.dumps({'role': role})

    def call(self, sql, args=()):
        cur = self.c.cursor()
        try:
            cur.execute('set local role ' + self.role)
            cur.execute("select set_config('request.jwt.claims', %s, true)", (self.claims,))
            cur.execute(sql, args)
            out = cur.fetchone()[0] if cur.description else None
            self.c.commit()
            return out
        except Exception:
            self.c.rollback()
            raise
        finally:
            cur.close()

    def rpc(self, review, action, version, key=None, args=None):
        return self.call('select public.review_transition(%s, %s, %s, %s, %s::jsonb)',
                         (review, action, version, key or str(uuid.uuid4()), json.dumps(args or {})))

    def close(self):
        self.c.close()


def err(fn):
    """Run fn, return (sqlstate, message) of the expected database error."""
    try:
        fn()
    except psycopg2.Error as e:
        return e.pgcode, (e.diag.message_primary or '')
    raise AssertionError('expected a database error, call succeeded')


def eq(a, b, msg=''):
    if a != b:
        raise AssertionError(f'{msg}: expected {b!r}, got {a!r}')


def test(fn):
    name = fn.__name__
    t0 = time.time()
    try:
        fn()
        RESULTS.append((name, True, ''))
        print(f'  ok    {name} ({time.time() - t0:.2f}s)')
    except Exception as e:
        RESULTS.append((name, False, str(e)))
        print(f'  FAIL  {name}: {e}')
        traceback.print_exc()
    return fn


INTAKE_SNAPSHOT_SQL = r"""
select jsonb_build_object(
 'functions', (select jsonb_agg(jsonb_build_object('sig', p.oid::regprocedure::text,
     'src', md5(p.prosrc), 'secdef', p.prosecdef, 'config', p.proconfig,
     'acl', p.proacl::text, 'owner', p.proowner::regrole::text) order by p.oid::regprocedure::text)
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where (n.nspname = 'public' and p.proname in ('claim_mark','claim_mark_gate','claim_mark_v2','mark_intake_status_v2'))
      or n.nspname = 'mark_intake_private'),
 'columns', (select jsonb_agg(jsonb_build_object('t', c.table_schema || '.' || c.table_name, 'c', c.column_name,
     'type', c.data_type, 'null', c.is_nullable, 'def', c.column_default) order by c.table_schema, c.table_name, c.ordinal_position)
   from information_schema.columns c where c.table_schema = 'mark_intake_private'
      or (c.table_schema = 'public' and c.table_name in ('mark_requests','marks','mark_events'))),
 'constraints', (select jsonb_agg(jsonb_build_object('t', con.conrelid::regclass::text, 'n', con.conname,
     'd', pg_get_constraintdef(con.oid)) order by con.conrelid::regclass::text, con.conname)
   from pg_constraint con join pg_class k on k.oid = con.conrelid join pg_namespace n on n.oid = k.relnamespace
   where n.nspname = 'mark_intake_private' or k.relname in ('mark_requests','marks','mark_events')),
 'table_acl', (select jsonb_agg(jsonb_build_object('t', k.oid::regclass::text, 'acl', k.relacl::text,
     'rls', k.relrowsecurity) order by k.oid::regclass::text)
   from pg_class k join pg_namespace n on n.oid = k.relnamespace
   where (n.nspname = 'mark_intake_private' or k.relname in ('mark_requests','marks','mark_events')) and k.relkind = 'r'),
 'policies', (select jsonb_agg(jsonb_build_object('t', tablename, 'p', policyname, 'q', qual) order by tablename, policyname)
   from pg_policies where schemaname in ('public','mark_intake_private')),
 'schema_acl', (select nspacl::text from pg_namespace where nspname = 'mark_intake_private'),
 'intake_triggers', (select coalesce(jsonb_agg(tgname order by tgname), '[]') from pg_trigger
   where tgrelid = 'mark_intake_private.requests'::regclass and not tgisinternal)
)::text"""


def intake_snapshot(include_triggers=False):
    s = json.loads(q1(INTAKE_SNAPSHOT_SQL))
    trig = s.pop('intake_triggers')
    return (s, trig) if include_triggers else s


def claim_as_rpc(grader, cert, email):
    """claim_mark_v2 (3 args) as mark_intake_rpc, as the handler's bearer does."""
    with conn('supabase_admin') as c, c.cursor() as cur:
        cur.execute('set role mark_intake_rpc')
        cur.execute('select public.claim_mark_v2(%s,%s,%s)', (grader, cert, email))
        return cur.fetchone()[0]


def claim_as_anon(grader, cert, email, token='local-gate-test-only'):
    s = Session(role='anon')
    try:
        return s.call('select public.claim_mark_v2(%s,%s,%s,%s)', (grader, cert, email, token))
    finally:
        s.close()


# ============================================================== setup
def bootstrap():
    psql('supabase_admin', '-f', os.path.join(HERE, 'supabase_stub.sql'))
    for name in ['20261026_a5_public_marks.sql', '20261107_mark_intake_v2.sql',
                 '20261107_mark_intake_gate.sql', '20261107_mark_contact_ops.sql']:
        apply(name)
    psql('postgres', '-f', os.path.join(HERE, 'legacy_stub.sql'))
    # Test-only: open the intake policy so claims succeed (never done in prod by Phase 7).
    q("""update mark_intake_private.policy set approved = true, legacy_reconciled = true,
         scope = 'global', used = 0, approval_reference = 'LOCAL-TEST-ONLY'""")
    q('insert into auth.users (id, email) select v::uuid, k || \'@example.invalid\' from '
      'jsonb_each_text(%s::jsonb) as j(k, v)', (json.dumps(U),), user='supabase_admin')


def apply_phase7():
    apply('20261110_phase7_review_queue.sql')
    apply('20261110_phase7_backfill.sql')
    psql('postgres', '-v', 'matthew_uid=' + U['matthew'], '-f',
         os.path.join(REPO, 'supabase', 'seeds', 'phase7_seed_first_admin.sql'))
    q("""insert into mark_review.staff (user_id, role, granted_by, active) values
         (%(rev2)s, 'reviewer', %(m)s, true), (%(pub1)s, 'publisher', %(m)s, true),
         (%(pubrev)s, 'publisher', %(m)s, true), (%(pubrev)s, 'reviewer', %(m)s, true),
         (%(inactive)s, 'reviewer', %(m)s, false), (%(inactive)s, 'admin', %(m)s, false),
         (%(admin2)s, 'admin', %(m)s, true)""",
      {'rev2': U['rev2'], 'pub1': U['pub1'], 'pubrev': U['pubrev'], 'inactive': U['inactive'],
       'admin2': U['admin2'], 'm': U['matthew']})


def new_review(cert, grader='PSA'):
    claim_as_rpc(grader, cert, f'c{cert}@example.invalid')
    return q1("""select rv.id::text from mark_review.reviews rv join mark_intake_private.requests rq
                 on rq.id = rv.request_id where rq.grader = %s and rq.cert = %s""", (grader, cert))


def status(review):
    return q('select status, version from mark_review.reviews where id = %s', (review,))[0]


S = {}


# ============================================================== tests
def run_suite(pre_snapshot):
    S['m'] = Session('matthew'); S['m1'] = Session('matthew', aal='aal1')
    S['r2'] = Session('rev2'); S['p1'] = Session('pub1'); S['pr'] = Session('pubrev')
    S['ns'] = Session('nonstaff'); S['in'] = Session('inactive'); S['a2'] = Session('admin2')
    S['anon'] = Session(role='anon')

    @test
    def backfill_18_marks_published_with_registry_per_event():
        rows = q("""select cert, status, registry, tx, version, (select count(*) from mark_review.events e
                    where e.review_id = rv.id) from mark_review.reviews rv where origin = 'backfill' order by cert""")
        eq(len(rows), 18, 'backfill rows')
        eq({r[1] for r in rows}, {'published'}, 'statuses')
        onchain = json.load(open(os.path.join(REPO, 'src/onchain.json')))['events']
        for cert, _, reg, tx, ver, nev in rows:
            eq(tx, min(onchain[cert], key=lambda e: e['t'])['tx'], f'{cert} issuance tx')
            eq((ver, nev), (1, 1), f'{cert} version/events')
        first6 = q("""select rv.cert, rv.registry, e.payload from mark_review.reviews rv join mark_review.events e
                      on e.review_id = rv.id where rv.origin = 'backfill' and e.payload->>'receipt_source' =
                      'operations/pre-issuance-receipts-check.json'""")
        eq(len(first6), 6, 'first six citing receipt check')
        for cert, reg, p in first6:
            eq(reg, '0x30dfbca3978ce186e6107a93cedc7d2971d30950', f'{cert} issuance registry')
            eq(p['receipt_verified'], True, 'receipt_verified')
            for ev in p['events']:
                want = ('0x30dfbca3978ce186e6107a93cedc7d2971d30950' if ev['t'].startswith('2026-09-23')
                        else '0x2a585396dd0248a060045b3f557076fb1b4cb0eb')
                eq(ev['registry'], want, f'{cert} {ev["t"]}')
        eq(q1("select count(*) from mark_review.events e join mark_review.reviews rv on rv.id = e.review_id "
              "where rv.origin='backfill' and (e.payload->>'receipt_verified')::boolean"), 18, 'all verified')

    @test
    def backfill_rerun_is_noop():
        before = q1('select count(*) from mark_review.events')
        apply('20261110_phase7_backfill.sql')
        eq(q1('select count(*) from mark_review.events'), before, 'events after rerun')
        eq(q1("select count(*) from mark_review.reviews where origin='backfill'"), 18, 'rows after rerun')

    @test
    def preexisting_requests_enqueued_except_issued_cards():
        eq(q1("""select count(*) from mark_review.reviews rv join mark_intake_private.requests rq
                 on rq.id = rv.request_id where rq.cert = '980001'"""), 1, 'pre-existing request enqueued')
        eq(q1("""select count(*) from mark_review.reviews where request_id = (select id from
                 mark_intake_private.requests where grader='PSA' and cert='158538600')"""), 0,
           'request for issued Mark must not open a second review')
        eq(q1("""select count(*) from mark_review.reviews rv join mark_intake_private.requests rq
                 on rq.id = rv.request_id where rq.grader='CGC' and rq.cert='158538600'"""), 1, 'CGC separate')
        out = S['m'].call('select public.review_queue(null, 200)')
        eq(out['requests_for_open_card'], 1, 'requests_for_open_card')
        eq(out['requests_without_review'], 0, 'requests_without_review')
        eq(any('email' in json.dumps(r) for r in out['reviews']), False, 'no email in queue')

    @test
    def intake_new_claim_enqueues_and_contract_unchanged():
        d = claim_as_rpc('PSA', '700001', 'a@example.invalid')
        eq(set(d), {'contract', 'id', 'grader', 'cert', 'status', 'free', 'existing', 'remaining',
                    'freeLimit', 'policy_scope'}, 'response keys')
        eq((d['status'], d['existing']), ('requested', False), 'new claim')
        eq(q('select status, version, origin from mark_review.reviews where request_id = %s', (d['id'],))[0],
           ('queued', 1, 'intake'), 'enqueued review')
        rid = q1('select id::text from mark_review.reviews where request_id = %s', (d['id'],))
        S['m'].rpc(rid, 'claim', 1)
        d2 = claim_as_anon('PSA', '700001', 'b@example.invalid')  # 4-arg gate wrapper as anon
        eq((d2['status'], d2['existing'], d2['id']), ('requested', True, d['id']),
           'duplicate claim on a reviewed cert still returns requested')
        eq(err(lambda: claim_as_anon('PSA', '700002', 'x@example.invalid', token='wrong'))[0], 'PT403', 'gate')

    @test
    def intake_survives_enqueue_failure():
        # Break the queue (owner): the claim must still commit and return 'requested'.
        with conn() as c, c.cursor() as cur:
            cur.execute('alter table mark_review.reviews add constraint t_break check (cert <> %s)', ('700003',))
        try:
            d = claim_as_rpc('PSA', '700003', 'z@example.invalid')
            eq(d['status'], 'requested', 'claim status')
            eq(q1('select count(*) from mark_intake_private.requests where id = %s', (d['id'],)), 1, 'kept')
            eq(S['m'].call('select public.review_queue(null, 1)')['requests_without_review'], 1, 'gap visible')
        finally:
            q('alter table mark_review.reviews drop constraint t_break')
        eq(q1('select mark_review.enqueue_backlog()'), 1, 'backlog repair')

    @test
    def intake_objects_unchanged_except_enqueue_trigger():
        snap, trig = intake_snapshot(include_triggers=True)
        eq(snap, pre_snapshot, 'intake functions/tables/grants/policies')
        eq(trig, ['mark_review_enqueue'], 'only new intake-side object')

    @test
    def happy_path_claim_approve():
        rid = new_review('700010')
        a = S['m'].rpc(rid, 'claim', 1)
        eq((a['ok'], a['status'], a['version']), (True, 'in_review', 2), 'claim')
        b = S['m'].rpc(rid, 'release', 2)
        eq(b['status'], 'queued', 'release')
        S['r2'].rpc(rid, 'claim', 3)
        c = S['r2'].rpc(rid, 'approve', 4, args={'evidence_sha256': 'a' * 64, 'checks': {'live_grader': 'not_checked'},
                                                    'actor': U['pub1'], 'status': 'published', 'grader': 'CGC'})
        eq((c['status'], c['version']), ('approved', 5), 'approve')
        row = q('select approved_by::text, grader, last_actor::text, evidence_sha256 from mark_review.reviews where id=%s', (rid,))[0]
        eq(row, (U['rev2'], 'PSA', U['rev2'], 'a' * 64), 'client-supplied actor/status/grader ignored')
        S['m'].rpc(rid, 'withdraw', 5, args={'reason': 'duplicate'})
        eq(status(rid), ('withdrawn', 6), 'withdraw from approved')

    @test
    def reject_reopen_and_withdraw_paths():
        rid = new_review('700011')
        S['r2'].rpc(rid, 'claim', 1)
        eq(err(lambda: S['r2'].rpc(rid, 'reject', 2))[1], 'REASON_REQUIRED', 'reject needs reason')
        S['r2'].rpc(rid, 'reject', 2, args={'reason': 'photo unreadable'})
        eq(status(rid), ('rejected', 3), 'rejected')
        eq(err(lambda: S['r2'].rpc(rid, 'reopen', 3, args={'reason': 'new photo'}))[1], 'ROLE_FORBIDDEN', 'reopen admin only')
        out = S['m'].rpc(rid, 'reopen', 3, args={'reason': 'new photo'})
        eq((out['status'], out['version']), ('queued', 1), 'reopen creates new queued review')
        eq(status(rid), ('rejected', 3), 'source stays terminal')
        rid2 = new_review('700012')
        S['m'].rpc(rid2, 'withdraw', 1, args={'reason': 'customer asked'})
        eq(status(rid2), ('withdrawn', 2), 'withdraw from queued')
        rid3 = new_review('700013')
        S['r2'].rpc(rid3, 'claim', 1)
        S['a2'].rpc(rid3, 'release', 2)  # admin may release someone else's claim
        S['r2'].rpc(rid3, 'claim', 3)
        S['a2'].rpc(rid3, 'reject', 4, args={'reason': 'admin reject'})
        eq(status(rid3), ('rejected', 5), 'admin reject of other assignee')

    @test
    def forbidden_transitions_and_terminal_states():
        rid = new_review('700020')
        for action in ['release', 'approve', 'reject', 'prepare', 'submit', 'revert', 'confirm',
                       'publish', 'revoke', 'reopen']:
            code, msg = err(lambda: S['m'].rpc(rid, action, 1, args={'reason': 'x'}))
            eq((code, msg), ('PT409', 'INVALID_TRANSITION'), f'queued --{action}-->')
        S['r2'].rpc(rid, 'claim', 2 - 1)
        eq(err(lambda: S['r2'].rpc(rid, 'claim', 2))[1], 'INVALID_TRANSITION', 'double claim')
        S['r2'].rpc(rid, 'reject', 2, args={'reason': 'no'})
        for action in ['claim', 'release', 'approve', 'reject', 'withdraw', 'prepare', 'publish', 'revoke']:
            eq(err(lambda: S['m'].rpc(rid, action, 3, args={'reason': 'x'}))[1], 'INVALID_TRANSITION',
               f'rejected --{action}-->')
        eq(err(lambda: S['m'].rpc(rid, 'frobnicate', 3))[1], 'INVALID_ARGUMENT', 'unknown action')
        eq(err(lambda: S['m'].rpc(str(uuid.uuid4()), 'claim', 1))[1], 'REVIEW_NOT_FOUND', 'unknown review')

    @test
    def roles_enforced():
        rid = new_review('700030')
        eq(err(lambda: S['p1'].rpc(rid, 'claim', 1))[1], 'ROLE_FORBIDDEN', 'publisher cannot claim')
        S['r2'].rpc(rid, 'claim', 1)
        eq(err(lambda: S['m'].rpc(rid, 'approve', 2))[1], 'NOT_ASSIGNEE', 'non-assignee approve')
        eq(err(lambda: S['a2'].rpc(rid, 'approve', 2))[1], 'ROLE_FORBIDDEN', 'admin-only cannot approve')
        eq(err(lambda: S['p1'].rpc(rid, 'approve', 2))[1], 'ROLE_FORBIDDEN', 'publisher cannot approve')
        eq(err(lambda: S['r2'].rpc(rid, 'withdraw', 2, args={'reason': 'x'}))[1], 'ROLE_FORBIDDEN', 'reviewer withdraw')
        S['r2'].rpc(rid, 'approve', 2)
        eq(err(lambda: S['r2'].rpc(rid, 'prepare', 3))[1], 'ROLE_FORBIDDEN', 'reviewer cannot prepare')
        eq(err(lambda: S['m'].rpc(rid, 'prepare', 3))[1], 'ROLE_FORBIDDEN', 'admin cannot prepare')
        pub = q1("select id::text from mark_review.reviews where origin='backfill' order by cert limit 1")
        eq(err(lambda: S['r2'].rpc(pub, 'revoke', 1, args={'reason': 'x'}))[1], 'ROLE_FORBIDDEN', 'reviewer revoke')
        eq(err(lambda: S['p1'].rpc(pub, 'revoke', 1, args={'reason': 'x'}))[1], 'ROLE_FORBIDDEN', 'publisher revoke')

    @test
    def non_mfa_rejected():
        rid = new_review('700040')
        eq(err(lambda: S['m1'].rpc(rid, 'claim', 1)), ('PT403', 'MFA_REQUIRED'), 'aal1')
        nomfa = Session('matthew'); nomfa.claims = json.dumps({'sub': U['matthew'], 'role': 'authenticated'})
        eq(err(lambda: nomfa.rpc(rid, 'claim', 1))[1], 'MFA_REQUIRED', 'no aal claim')
        eq(err(lambda: S['m1'].call('select public.review_queue(null, 10)'))[1], 'MFA_REQUIRED', 'queue read aal1')
        nomfa.close()
        eq(status(rid), ('queued', 1), 'unchanged')

    @test
    def non_staff_and_anon_rejected():
        rid = new_review('700050')
        eq(err(lambda: S['ns'].rpc(rid, 'claim', 1)), ('PT403', 'NOT_STAFF'), 'non-staff')
        eq(err(lambda: S['in'].rpc(rid, 'claim', 1)), ('PT403', 'NOT_STAFF'), 'inactive staff')
        nouid = Session(); nouid.claims = json.dumps({'role': 'authenticated', 'aal': 'aal2'})
        eq(err(lambda: nouid.rpc(rid, 'claim', 1))[1], 'NOT_AUTHENTICATED', 'no sub')
        nouid.close()
        eq(err(lambda: S['anon'].rpc(rid, 'claim', 1))[0], '42501', 'anon cannot execute')
        eq(err(lambda: S['anon'].call('select public.review_queue(null, 10)'))[0], '42501', 'anon queue')
        for who in ['anon', 'ns', 'm']:
            for t in ['reviews', 'events', 'staff', 'flags', 'config_events']:
                eq(err(lambda: S[who].call(f'select count(*) from mark_review.{t}'))[0], '42501',
                   f'{who} direct read {t}')
        eq(err(lambda: S['m'].call("update mark_review.flags set issuance_enabled = true"))[0], '42501', 'flag write')
        eq(err(lambda: S['m'].call("insert into mark_review.staff values (%s,'publisher',true,%s)",
                                   (U['matthew'], U['matthew'])))[0], '42501', 'self-grant')
        eq(status(rid), ('queued', 1), 'unchanged')

    @test
    def approver_cannot_publish_same_review():
        rid = new_review('700060')
        S['pr'].rpc(rid, 'claim', 1)
        S['pr'].rpc(rid, 'approve', 2)
        eq(err(lambda: S['pr'].rpc(rid, 'prepare', 3, args=prep_args())),
           ('PT403', 'SEPARATE_PUBLISHER_REQUIRED'), 'approver == publisher')
        eq(err(lambda: S['p1'].rpc(rid, 'prepare', 3, args=prep_args())),
           ('PT403', 'ISSUANCE_DISABLED'), 'other publisher still blocked by flag')
        eq(status(rid), ('approved', 3), 'unchanged')

    @test
    def issuance_transitions_blocked_while_flags_off():
        rid = new_review('700070')
        S['r2'].rpc(rid, 'claim', 1); S['r2'].rpc(rid, 'approve', 2)
        eq(err(lambda: S['p1'].rpc(rid, 'prepare', 3, args=prep_args()))[1], 'ISSUANCE_DISABLED', 'prepare')
        # Even the owner cannot push a row into an issuance state or flip the flags.
        eq(err(lambda: q("update mark_review.reviews set status='prepared' where id=%s", (rid,)))[1],
           'ISSUANCE_DISABLED', 'owner direct update')
        for col in ['issuance_enabled', 'payments_enabled', 'live_grader_lookup']:
            eq(err(lambda: q(f'update mark_review.flags set {col} = true'))[0], '23514', f'{col} CHECK')
        eq(err(lambda: q('delete from mark_review.flags'))[0], '42501', 'flags row cannot be deleted')
        eq(err(lambda: q("insert into mark_review.reviews (origin, grader, cert, status) values "
                         "('intake','PSA','700071','published')"))[0], '42501', 'insert in non-initial state')
        eq(q1('select require_separate_publisher from mark_review.flags'), True, 'four-eyes default on')

    @test
    def full_issuance_chain_in_simulated_unlock_rolled_back():
        """Proves the post-approval edges work once a future migration unlocks issuance.
        Done inside ONE superuser transaction that is rolled back."""
        rid = new_review('700080')
        S['r2'].rpc(rid, 'claim', 1); S['r2'].rpc(rid, 'approve', 2)
        c = conn('supabase_admin', autocommit=False); cur = c.cursor()
        try:
            cur.execute('alter table mark_review.flags drop constraint issuance_locked_off')
            cur.execute('update mark_review.flags set issuance_enabled = true')

            def as_(who, action, v, args=None):
                cur.execute('savepoint s')
                cur.execute('set local role authenticated')
                cur.execute("select set_config('request.jwt.claims', %s, true)", (claims(who),))
                try:
                    cur.execute('select public.review_transition(%s,%s,%s,%s,%s::jsonb)',
                                (rid, action, v, str(uuid.uuid4()), json.dumps(args or {})))
                    out = cur.fetchone()[0]
                    cur.execute('release savepoint s')
                    return out
                except psycopg2.Error as e:
                    cur.execute('rollback to savepoint s')
                    return e.diag.message_primary
                finally:
                    cur.execute('reset role')
            eq(as_('rev2', 'prepare', 3, prep_args()), 'ROLE_FORBIDDEN', 'approver w/o publisher role')
            eq(as_('pub1', 'prepare', 3, prep_args())['status'], 'prepared', 'prepare')
            tx = '0x' + 'ab' * 32
            eq(as_('pub1', 'submit', 4, {'tx': tx})['status'], 'submitted', 'submit')
            eq(as_('pub1', 'revert', 5, {'reason': 'dropped'})['status'], 'prepared', 'revert')
            eq(as_('pub1', 'submit', 6, {'tx': tx})['status'], 'submitted', 'resubmit')
            eq(as_('pub1', 'confirm', 7, {'block_number': 1, 'block_hash': '0x' + 'cd' * 32,
                                          'receipt_status': '0x2'}), 'INVALID_RECEIPT', 'failed receipt')
            eq(as_('pub1', 'confirm', 7, {'block_number': 151000000, 'block_hash': '0x' + 'cd' * 32,
                                          'receipt_status': '0x1'})['status'], 'confirmed', 'confirm')
            eq(as_('pub1', 'publish', 8)['status'], 'published', 'publish')
            eq(as_('matthew', 'revoke', 9, {'reason': 'test'})['status'], 'revoked', 'revoke')
        finally:
            c.rollback(); c.close()
        eq(status(rid), ('approved', 3), 'rolled back')
        eq(err(lambda: q('update mark_review.flags set issuance_enabled = true'))[0], '23514', 'lock restored')

    @test
    def revoke_published_mark_sets_public_revoked():
        cert = q1("select cert from mark_review.reviews where origin='backfill' order by cert desc limit 1")
        q("""insert into public.marks (cert, card_name, grade, low_usd, point_usd, high_usd, confidence, network)
             values (%s, 'Test', 'PSA 10', 1, 2, 3, 50, 'robinhood-testnet')""", (cert,))
        rid, ver = q("select id::text, version from mark_review.reviews where origin='backfill' and cert=%s", (cert,))[0]
        eq(err(lambda: S['m'].rpc(rid, 'revoke', ver))[1], 'REASON_REQUIRED', 'reason')
        out = S['m'].rpc(rid, 'revoke', ver, args={'reason': 'returned slab'})
        eq(out['status'], 'revoked', 'revoked')
        eq(q('select revoked, revoked_reason from public.marks where cert=%s', (cert,))[0], (True, 'returned slab'), 'public')
        p = q1("select payload from mark_review.events where review_id=%s and action='revoke'", (rid,))
        eq((p['previous_revoked'], p['public_mark_found']), (False, True), 'payload')
        eq(err(lambda: S['m'].rpc(rid, 'reopen', ver + 1, args={'reason': 'x'}))[1], 'INVALID_TRANSITION', 'terminal')
        eq(claim_as_rpc('PSA', cert, 'r@example.invalid')['status'], 'requested', 'intake still fine')

    @test
    def idempotent_repeat_returns_same_result():
        rid = new_review('700090')
        key = str(uuid.uuid4())
        a = S['r2'].rpc(rid, 'claim', 1, key=key)
        b = S['r2'].rpc(rid, 'claim', 1, key=key)
        eq(b, a, 'same body')
        eq(status(rid), ('in_review', 2), 'applied once')
        eq(q1('select count(*) from mark_review.events where idempotency_key=%s', (key,)), 1, 'one event')
        eq(err(lambda: S['r2'].rpc(rid, 'release', 2, key=key)), ('PT409', 'IDEMPOTENCY_CONFLICT'), 'diff input')
        eq(err(lambda: S['m'].rpc(rid, 'claim', 1, key=key))[1], 'IDEMPOTENCY_CONFLICT', 'other actor same key')
        stale = S['m'].rpc(rid, 'release', 1)
        eq((stale['ok'], stale['code'], stale['status'], stale['version']),
           (False, 'STALE_VERSION', 'in_review', 2), 'stale version returns state')

    @test
    def concurrent_claims_one_winner():
        rid = new_review('700100')
        n = 20
        sessions = [Session('rev2' if i % 2 else 'matthew') for i in range(n)]
        out = [None] * n
        holder = conn('postgres', autocommit=False); hc = holder.cursor()
        hc.execute('select 1 from mark_review.reviews where id=%s for update', (rid,))

        def go(i):
            try:
                out[i] = sessions[i].rpc(rid, 'claim', 1)
            except psycopg2.Error as e:
                out[i] = e.diag.message_primary
        ts = [threading.Thread(target=go, args=(i,)) for i in range(n)]
        for t in ts: t.start()
        deadline = time.time() + 10
        while time.time() < deadline and q1("""select count(*) from pg_stat_activity where usename='authenticator'
                and wait_event_type='Lock'""", user='supabase_admin') < n:
            time.sleep(0.05)
        eq(q1("select count(*) from pg_stat_activity where usename='authenticator' and wait_event_type='Lock'",
              user='supabase_admin'), n, 'all sessions blocked on the row lock')
        holder.rollback(); holder.close()
        for t in ts: t.join(15)
        for s in sessions: s.close()
        wins = [o for o in out if isinstance(o, dict) and o.get('ok')]
        stale = [o for o in out if isinstance(o, dict) and o.get('code') == 'STALE_VERSION']
        eq((len(wins), len(stale)), (1, n - 1), f'winners/stale {out}')
        eq(q1("select count(*) from mark_review.events where review_id=%s and action='claim'", (rid,)), 1, 'events')

    @test
    def concurrent_duplicate_open_review_clean_conflict():
        # Two rejected reviews of the same card (intake + reopen history) reopened at once
        # by two admins: exactly one new open review; the other gets OPEN_REVIEW_EXISTS.
        rid1 = new_review('700110')
        S['r2'].rpc(rid1, 'claim', 1); S['r2'].rpc(rid1, 'reject', 2, args={'reason': 'a'})
        rid2 = S['m'].rpc(rid1, 'reopen', 3, args={'reason': 'b'})['review_id']
        S['r2'].rpc(rid2, 'claim', 1); S['r2'].rpc(rid2, 'reject', 2, args={'reason': 'c'})
        barrier = threading.Barrier(2); out = {}
        sa, sb = Session('matthew'), Session('admin2')
        def go(name, s, rid):
            barrier.wait()
            try:
                out[name] = s.rpc(rid, 'reopen', 3, args={'reason': 'retry'})
            except psycopg2.Error as e:
                out[name] = (e.pgcode, e.diag.message_primary)
        ts = [threading.Thread(target=go, args=('a', sa, rid1)), threading.Thread(target=go, args=('b', sb, rid2))]
        for t in ts: t.start()
        for t in ts: t.join(15)
        sa.close(); sb.close()
        vals = list(out.values())
        ok = [v for v in vals if isinstance(v, dict) and v.get('ok')]
        conflict = [v for v in vals if v == ('PT409', 'OPEN_REVIEW_EXISTS')]
        eq((len(ok), len(conflict)), (1, 1), f'outcomes {out}')
        eq(q1("""select count(*) from mark_review.reviews where grader='PSA' and cert='700110'
                 and status not in ('rejected','withdrawn')"""), 1, 'one open review')
        # Deterministic variant: a real waiter on the unique index.
        rid3 = q1("select id::text from mark_review.reviews where cert='700110' and status='queued'")
        S['m'].rpc(rid3, 'withdraw', 1, args={'reason': 'reset'})
        holder = Session('admin2'); holder.c.autocommit = False
        cur = holder.c.cursor()
        cur.execute('set local role authenticated')
        cur.execute("select set_config('request.jwt.claims', %s, true)", (holder.claims,))
        cur.execute('select public.review_transition(%s,%s,%s,%s,%s::jsonb)',
                    (rid1, 'reopen', 3, str(uuid.uuid4()), json.dumps({'reason': 'hold'})))
        res = {}
        waiter = Session('matthew')
        t = threading.Thread(target=lambda: res.update(r=err(lambda: waiter.rpc(rid2, 'reopen', 3, args={'reason': 'w'})))); t.start()
        deadline = time.time() + 10
        while time.time() < deadline and q1("""select count(*) from pg_stat_activity where usename='authenticator'
                and wait_event_type='Lock'""", user='supabase_admin') < 1:
            time.sleep(0.05)
        try:
            eq(q1("select count(*) from pg_stat_activity where usename='authenticator' and wait_event_type='Lock'",
                  user='supabase_admin'), 1, 'waiter blocked on the unique index')
        finally:
            holder.c.commit(); t.join(15); holder.close(); waiter.close()
        eq(res['r'], ('PT409', 'OPEN_REVIEW_EXISTS'), 'waiter gets clean conflict')

    @test
    def events_append_only():
        eid = q1('select id from mark_review.events order by id limit 1')
        eq(err(lambda: q("update mark_review.events set payload='{}' where id=%s", (eid,)))[0], '42501', 'update')
        eq(err(lambda: q('delete from mark_review.events where id=%s', (eid,)))[0], '42501', 'delete')
        eq(err(lambda: q('truncate mark_review.events cascade'))[0], '42501', 'truncate')
        eq(err(lambda: q('delete from mark_review.reviews'))[0], '42501', 'reviews delete')
        eq(err(lambda: q('update mark_review.config_events set op = op'))[0], '42501', 'config_events')
        eq(err(lambda: q("update mark_review.reviews set cert='123456' where origin='backfill'"))[0], '42501', 'identity')
        # Caller-supplied seq/hash are overwritten by the trigger.
        rid = new_review('700120')
        q("""insert into mark_review.events (review_id, seq, action, to_status, actor_kind, idempotency_key,
             request_sha256, result, version_after, hash, prev_hash) values (%s, 99, 'note', 'queued', 'migration',
             gen_random_uuid(), repeat('0',64), '{}', 1, repeat('f',64), 'forged')""", (rid,))
        eq(q("select seq, prev_hash = (select hash from mark_review.events where review_id=%s and seq=1) "
             "from mark_review.events where review_id=%s and action='note'", (rid, rid))[0], (2, True), 'forged fields')

    @test
    def staff_and_flag_changes_audited():
        n = q1("select count(*) from mark_review.config_events where table_name='staff'")
        q("update mark_review.staff set active=false where user_id=%s", (U['admin2'],))
        q("update mark_review.staff set active=true where user_id=%s", (U['admin2'],))
        eq(q1("select count(*) from mark_review.config_events where table_name='staff'"), n + 2, 'audited')
        eq(q1("""select count(*) from mark_review.config_events where table_name='staff' and op='INSERT'
                 and row_after->>'user_id'=%s""", (U['matthew'],)), 2, 'seed audited')

    @test
    def hash_chain_verifies_and_detects_tamper():
        bad = q('select review_id, events, first_bad_seq from mark_review.verify_chain() where not ok')
        eq(bad, [], 'all chains verify')
        eq(q1('select count(*) from mark_review.verify_chain()'), q1('select count(*) from mark_review.reviews'), 'all')
        c = conn('supabase_admin', autocommit=False); cur = c.cursor()
        try:
            cur.execute('alter table mark_review.events disable trigger events_no_update')
            cur.execute("""update mark_review.events set payload = payload || '{"x":1}' where id =
                           (select id from mark_review.events where action='claim' order by id limit 1)""")
            cur.execute('select count(*) from mark_review.verify_chain() where not ok')
            eq(cur.fetchone()[0], 1, 'owner edit detected')
        finally:
            c.rollback(); c.close()
        c = conn('supabase_admin', autocommit=False); cur = c.cursor()
        try:  # status edit without an event is detected too
            cur.execute('alter table mark_review.reviews disable trigger reviews_guard')
            cur.execute("update mark_review.reviews set status='withdrawn' where id=(select id from "
                        "mark_review.reviews where status='queued' order by created_at limit 1)")
            cur.execute('select count(*) from mark_review.verify_chain() where not ok')
            eq(cur.fetchone()[0], 1, 'state/chain mismatch detected')
        finally:
            c.rollback(); c.close()

    @test
    def rls_defence_in_depth():
        # Simulate someone exposing the schema: grant usage+select inside a rolled-back txn.
        c = conn('supabase_admin', autocommit=False); cur = c.cursor()
        try:
            cur.execute('grant usage on schema mark_review to authenticated')
            cur.execute('grant select on all tables in schema mark_review to authenticated')
            def count(who, aal, table):
                cur.execute('savepoint s'); cur.execute('set local role authenticated')
                cur.execute("select set_config('request.jwt.claims', %s, true)", (claims(who, aal),))
                cur.execute(f'select count(*) from mark_review.{table}'); n = cur.fetchone()[0]
                cur.execute('reset role'); cur.execute('release savepoint s'); return n
            total = count('matthew', 'aal2', 'reviews')
            eq(total > 18, True, 'staff+aal2 sees rows')
            eq(count('matthew', 'aal1', 'reviews'), 0, 'aal1 sees nothing')
            eq(count('nonstaff', 'aal2', 'reviews'), 0, 'non-staff sees nothing')
            eq(count('inactive', 'aal2', 'events'), 0, 'inactive sees nothing')
            eq(count('matthew', 'aal2', 'flags'), 0, 'no flags policy')
            eq(count('matthew', 'aal2', 'staff'), 2, 'own staff rows only')
        finally:
            c.rollback(); c.close()

    @test
    def security_definer_functions_have_fixed_search_path_and_minimal_grants():
        rows = q("""select p.oid::regprocedure::text, p.prosecdef, p.proconfig, p.proacl::text
                    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                    where n.nspname = 'mark_review' or p.proname in ('review_transition','review_queue')""")
        for sig, secdef, cfg, acl in rows:
            eq(any(c.startswith('search_path=pg_catalog') for c in (cfg or [])), True, f'{sig} search_path')
            grantees = {a.split('=')[0] for a in (acl or '{}').strip('{}').split(',') if a}
            allowed = {'postgres'} | ({'authenticated'} if sig.startswith(('review_transition', 'review_queue',
                                                                            'mark_review.has_role')) else set())
            eq(grantees - allowed, set(), f'{sig} grants {acl}')
        eq(q1("select has_schema_privilege('authenticated','mark_review','usage')"), False, 'schema usage')
        eq(q1("select has_schema_privilege('anon','mark_review','usage')"), False, 'anon schema usage')
        eq(q1("select has_function_privilege('anon','public.review_transition(uuid,text,integer,uuid,jsonb)','execute')"),
           False, 'anon execute')
        eq(q1("select has_function_privilege('service_role','public.review_transition(uuid,text,integer,uuid,jsonb)','execute')"),
           False, 'service_role execute')
        eq(q1("select count(*) from pg_tables where schemaname='mark_review' and not rowsecurity"), 0, 'RLS on')

    for s in S.values():
        s.close()


def prep_args():
    return {'prepared_sha256': 'b' * 64, 'calldata_sha256': 'c' * 64,
            'registry': '0x2A585396dd0248A060045b3f557076fB1B4Cb0eb'}


def lifecycle(pre_snapshot):
    @test
    def rollback_refuses_while_staff_audit_exists():
        p = psql('postgres', '-f', os.path.join(MIG, '20261110_phase7_review_queue_rollback.sql'), check=False)
        eq(p.returncode != 0 and 'rollback refused' in p.stderr, True, 'refused')
        eq(q1("select to_regnamespace('mark_review') is not null"), True, 'schema kept')

    @test
    def rollback_restores_exact_intake_state():
        psql('postgres', '-c', "set phase7.rollback_discard_audit = 'yes'",
             '-f', os.path.join(MIG, '20261110_phase7_review_queue_rollback.sql'))
        eq(q1("select to_regnamespace('mark_review')"), None, 'schema gone')
        eq(q1("select to_regprocedure('public.review_transition(uuid,text,integer,uuid,jsonb)')"), None, 'rpc gone')
        snap, trig = intake_snapshot(include_triggers=True)
        eq(snap, pre_snapshot, 'intake identical to pre-Phase-7')
        eq(trig, [], 'no intake trigger')
        n = q1('select count(*) from mark_intake_private.requests')
        eq(claim_as_rpc('PSA', '700200', 'q@example.invalid')['status'], 'requested', 'intake works')
        eq(q1('select count(*) from mark_intake_private.requests'), n + 1, 'claim stored')

    @test
    def reapply_after_rollback():
        apply_phase7()
        eq(q1("select count(*) from mark_review.reviews where origin='backfill'"), 18, 'backfill')
        eq(q1("""select count(*) from mark_intake_private.requests rq where not exists (select 1 from
                 mark_review.reviews rv where rv.request_id = rq.id)"""),
           q1("""select count(*) from mark_intake_private.requests rq where exists (select 1 from mark_review.reviews rv
                 where rv.origin='backfill' and rv.grader=rq.grader and rv.cert=rq.cert)"""),
           'every request enqueued except issued cards')
        eq(q('select * from mark_review.verify_chain() where not ok'), [], 'chains')
        rid = q1("select id::text from mark_review.reviews where origin='intake' and status='queued' limit 1")
        s = Session('matthew'); eq(s.rpc(rid, 'claim', 1)['status'], 'in_review', 'works'); s.close()
        eq(intake_snapshot(), pre_snapshot, 'intake still identical')

    @test
    def rollback_and_reapply_again_clean():
        # No staff events yet in a fresh apply -> rollback needs no opt-in.
        psql('postgres', '-c', "set phase7.rollback_discard_audit = 'yes'",
             '-f', os.path.join(MIG, '20261110_phase7_review_queue_rollback.sql'))
        apply('20261110_phase7_review_queue.sql'); apply('20261110_phase7_backfill.sql')
        psql('postgres', '-f', os.path.join(MIG, '20261110_phase7_review_queue_rollback.sql'))
        apply('20261110_phase7_review_queue.sql'); apply('20261110_phase7_backfill.sql')
        eq(q1("select count(*) from mark_review.reviews where origin='backfill'"), 18, 'final state')


def main():
    print('bootstrap: stub auth/roles, existing migrations, legacy stubs')
    bootstrap()
    # Pre-existing intake requests (before Phase 7), incl. one for an issued Mark.
    claim_as_rpc('PSA', '980001', 'p1@example.invalid')
    claim_as_rpc('PSA', '158538600', 'p2@example.invalid')
    claim_as_rpc('CGC', '158538600', 'p3@example.invalid')
    pre = intake_snapshot()
    print('apply: phase7 review queue, backfill, seed')
    apply_phase7()
    print('suite:')
    run_suite(pre)
    print('lifecycle:')
    lifecycle(pre)
    passed = sum(1 for _, ok, _ in RESULTS if ok)
    failed = [n for n, ok, _ in RESULTS if not ok]
    print(f'\nphase7 db: {passed} passed, {len(failed)} failed' + (f' -> {failed}' if failed else ''))
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
