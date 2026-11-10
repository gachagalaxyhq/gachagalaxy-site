-- Phase 7: Mark review queue (database layer).
-- Design: docs/phase7-review-queue-design.md (approved decisions recorded in
-- docs/phase7-review-queue-apply.md). Apply AFTER the intake migrations
-- (v2 -> gate -> contact_ops) and BEFORE 20261110_phase7_backfill.sql.
-- Filename order is NOT apply order; do not use `supabase db push` here.
--
-- What this does NOT change: intake tables/columns, claim_mark_v2 (3 and 4
-- args), mark_intake_status_v2, claim_mark, claim_mark_gate, mark_requests,
-- their grants, or the intake response contract. The only intake-side object
-- added is an AFTER INSERT trigger that enqueues a review; it swallows its own
-- errors so a queue fault can never fail or alter an intake claim.
--
-- Safety: payments, issuance and live grader lookup are pinned OFF by CHECK
-- constraints (enabling any of them needs a new reviewed migration). Staff
-- actions require auth.jwt()->>'aal' = 'aal2'. Applying this before any MFA
-- factor is enrolled is safe: every staff action is simply denied.
begin;
set local lock_timeout = '5s';

create schema mark_review;
revoke all on schema mark_review from public, anon, authenticated, service_role, mark_intake_rpc;

-- ---------------------------------------------------------------- staff/flags
-- One row per (user, role): a person may hold several roles (e.g. admin+reviewer).
create table mark_review.staff (
  user_id    uuid not null references auth.users(id),
  role       text not null check (role in ('reviewer', 'publisher', 'admin')),
  active     boolean not null default true,
  granted_by uuid not null references auth.users(id),
  granted_at timestamptz not null default clock_timestamp(),
  primary key (user_id, role)
);

create table mark_review.flags (
  singleton                  boolean primary key default true check (singleton),
  issuance_enabled           boolean not null default false
                             constraint issuance_locked_off check (not issuance_enabled),
  payments_enabled           boolean not null default false
                             constraint payments_locked_off check (not payments_enabled),
  live_grader_lookup         boolean not null default false
                             constraint live_grader_locked_off check (not live_grader_lookup),
  -- Decision 1: the approver of a review may not perform its publication steps.
  require_separate_publisher boolean not null default true
);

-- Owner-side changes to staff and flags are logged append-only.
create table mark_review.config_events (
  id          bigint generated always as identity primary key,
  table_name  text not null check (table_name in ('staff', 'flags')),
  op          text not null check (op in ('INSERT', 'UPDATE', 'DELETE')),
  row_before  jsonb,
  row_after   jsonb,
  db_user     name not null default session_user,
  happened_at timestamptz not null default clock_timestamp()
);

-- ---------------------------------------------------------------- reviews
create table mark_review.reviews (
  id              uuid primary key default gen_random_uuid(),
  request_id      uuid unique references mark_intake_private.requests(id),
  origin          text not null check (origin in ('intake', 'backfill', 'reopen')),
  reopened_from   uuid references mark_review.reviews(id),
  grader          text not null check (grader in ('PSA', 'CGC')),
  cert            text not null check (cert ~ '^[1-9][0-9]{5,9}$'),
  status          text not null default 'queued' check (status in
                  ('queued', 'in_review', 'approved', 'rejected', 'withdrawn',
                   'prepared', 'submitted', 'confirmed', 'published', 'revoked')),
  version         integer not null default 1 check (version >= 1),
  assigned_to     uuid references auth.users(id),
  approved_by     uuid references auth.users(id),
  decided_by      uuid references auth.users(id),
  last_actor      uuid references auth.users(id),
  decision_reason text check (length(decision_reason) <= 500),
  evidence_sha256 text check (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  prepared_sha256 text check (prepared_sha256 ~ '^[0-9a-f]{64}$'),
  calldata_sha256 text check (calldata_sha256 ~ '^[0-9a-f]{64}$'),
  chain_id        integer check (chain_id = 46630),
  registry        text check (registry ~ '^0x[0-9a-f]{40}$'),
  tx              text check (tx ~ '^0x[0-9a-f]{64}$'),
  block_number    bigint check (block_number > 0),
  block_hash      text check (block_hash ~ '^0x[0-9a-f]{64}$'),
  published_at    timestamptz,
  revoked_reason  text check (length(revoked_reason) <= 500),
  created_at      timestamptz not null default clock_timestamp(),
  updated_at      timestamptz not null default clock_timestamp(),
  constraint reviews_intake_has_request check (origin <> 'intake' or request_id is not null),
  constraint reviews_reopen_has_source check (origin <> 'reopen' or reopened_from is not null),
  constraint reviews_onchain_has_tx check (status not in ('submitted', 'confirmed', 'published', 'revoked')
                                           or (tx is not null and chain_id is not null)),
  constraint reviews_revoked_has_reason check (status <> 'revoked' or revoked_reason is not null),
  constraint reviews_in_review_assigned check (status <> 'in_review' or assigned_to is not null),
  constraint reviews_chain_tx_unique unique (chain_id, tx)
);
-- One open review per card. Rejected/withdrawn rows do not block a new one.
create unique index reviews_one_open on mark_review.reviews (grader, cert)
  where status not in ('rejected', 'withdrawn');

-- ---------------------------------------------------------------- events
-- Append-only, hash-chained per review. seq/prev_hash/hash/created_at are set
-- by a trigger; caller-supplied values are overwritten.
create table mark_review.events (
  id              bigint generated always as identity primary key,
  review_id       uuid not null references mark_review.reviews(id),
  seq             integer not null check (seq >= 1),
  action          text not null,
  from_status     text,
  to_status       text not null,
  actor           uuid,
  actor_kind      text not null check (actor_kind in ('staff', 'system', 'migration')),
  actor_role      text,
  idempotency_key uuid not null,
  request_sha256  text not null check (request_sha256 ~ '^[0-9a-f]{64}$'),
  payload         jsonb not null default '{}'::jsonb,
  result          jsonb not null,
  version_after   integer not null,
  prev_hash       text,
  hash            text not null check (hash ~ '^[0-9a-f]{64}$'),
  created_at      timestamptz not null default clock_timestamp(),
  constraint events_idempotency_key_unique unique (idempotency_key),
  constraint events_review_seq_unique unique (review_id, seq),
  constraint events_staff_has_actor check (actor_kind <> 'staff' or actor is not null)
);

-- hash = sha256( jsonb_build_array(prev_hash, review_id, seq, action, from_status,
--   to_status, actor, actor_kind, actor_role, idempotency_key, request_sha256,
--   payload, result, created_at as UTC 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')::text )
create function mark_review.event_hash(
  p_prev text, p_review uuid, p_seq integer, p_action text, p_from text, p_to text,
  p_actor uuid, p_kind text, p_role text, p_key uuid, p_req text, p_payload jsonb,
  p_result jsonb, p_at timestamptz)
returns text language sql stable set search_path = pg_catalog, pg_temp as $$
  select encode(sha256(convert_to(jsonb_build_array(
    p_prev, p_review, p_seq, p_action, p_from, p_to, p_actor, p_kind, p_role, p_key,
    p_req, p_payload, p_result,
    to_char(p_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))::text, 'UTF8')), 'hex')
$$;

create function mark_review.events_chain() returns trigger
language plpgsql set search_path = pg_catalog, pg_temp as $$
declare v_seq integer; v_hash text;
begin
  -- Serialise writers per review so seq has no gaps or forks.
  perform 1 from mark_review.reviews where id = new.review_id for update;
  if not found then
    raise exception using errcode = '23503', message = 'events require an existing review';
  end if;
  select e.seq, e.hash into v_seq, v_hash from mark_review.events e
    where e.review_id = new.review_id order by e.seq desc limit 1;
  new.seq := coalesce(v_seq, 0) + 1;
  new.prev_hash := v_hash;
  new.created_at := clock_timestamp();
  new.hash := mark_review.event_hash(new.prev_hash, new.review_id, new.seq, new.action,
    new.from_status, new.to_status, new.actor, new.actor_kind, new.actor_role,
    new.idempotency_key, new.request_sha256, new.payload, new.result, new.created_at);
  return new;
end $$;
create trigger events_chain before insert on mark_review.events
  for each row execute function mark_review.events_chain();

create function mark_review.deny_change() returns trigger
language plpgsql set search_path = pg_catalog, pg_temp as $$
begin
  raise exception using errcode = '42501', message = tg_table_name || ' is append-only';
end $$;
create trigger events_no_update before update or delete on mark_review.events
  for each row execute function mark_review.deny_change();
create trigger events_no_truncate before truncate on mark_review.events
  for each statement execute function mark_review.deny_change();
create trigger config_events_no_update before update or delete on mark_review.config_events
  for each row execute function mark_review.deny_change();
create trigger config_events_no_truncate before truncate on mark_review.config_events
  for each statement execute function mark_review.deny_change();
create trigger flags_no_delete before delete on mark_review.flags
  for each row execute function mark_review.deny_change();
create trigger flags_no_truncate before truncate on mark_review.flags
  for each statement execute function mark_review.deny_change();
create trigger staff_no_truncate before truncate on mark_review.staff
  for each statement execute function mark_review.deny_change();
create trigger reviews_no_truncate before truncate on mark_review.reviews
  for each statement execute function mark_review.deny_change();

create function mark_review.audit_config() returns trigger
language plpgsql set search_path = pg_catalog, pg_temp as $$
begin
  insert into mark_review.config_events (table_name, op, row_before, row_after)
  values (tg_table_name, tg_op,
          case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end,
          case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end);
  return null;
end $$;
create trigger staff_audit after insert or update or delete on mark_review.staff
  for each row execute function mark_review.audit_config();
create trigger flags_audit after insert or update or delete on mark_review.flags
  for each row execute function mark_review.audit_config();
insert into mark_review.flags default values;

-- Defence in depth below the RPC: identity is immutable, rows are never deleted,
-- and post-approval states need issuance enabled and a separate publisher.
create function mark_review.reviews_guard() returns trigger
language plpgsql set search_path = pg_catalog, pg_temp as $$
declare f mark_review.flags%rowtype;
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '42501', message = 'reviews cannot be deleted';
  end if;
  if tg_op = 'INSERT' then
    -- Only the owner-run backfill may create a row in a non-initial state.
    if new.origin <> 'backfill' and (new.status <> 'queued' or new.version <> 1
       or new.tx is not null or new.approved_by is not null) then
      raise exception using errcode = '42501', message = 'new reviews start queued';
    end if;
    return new;
  end if;
  if new.id <> old.id or new.grader <> old.grader or new.cert <> old.cert
     or new.origin <> old.origin or new.request_id is distinct from old.request_id
     or new.reopened_from is distinct from old.reopened_from then
    raise exception using errcode = '42501', message = 'review identity is immutable';
  end if;
  if new.status is distinct from old.status
     and new.status in ('prepared', 'submitted', 'confirmed', 'published') then
    select * into f from mark_review.flags where singleton;
    if not found or not f.issuance_enabled then
      raise exception using errcode = 'PT403', message = 'ISSUANCE_DISABLED';
    end if;
    if f.require_separate_publisher and new.approved_by is not null
       and new.last_actor is not distinct from new.approved_by then
      raise exception using errcode = 'PT403', message = 'SEPARATE_PUBLISHER_REQUIRED';
    end if;
  end if;
  return new;
end $$;
create trigger reviews_guard before insert or update or delete on mark_review.reviews
  for each row execute function mark_review.reviews_guard();

-- ---------------------------------------------------------------- auth helpers
create function mark_review.require_staff() returns text[]
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare v_uid uuid := auth.uid(); v_roles text[];
begin
  if v_uid is null then
    raise exception using errcode = 'PT401', message = 'NOT_AUTHENTICATED';
  end if;
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception using errcode = 'PT403', message = 'MFA_REQUIRED';
  end if;
  select array_agg(s.role order by s.role) into v_roles
    from mark_review.staff s where s.user_id = v_uid and s.active;
  if v_roles is null then
    raise exception using errcode = 'PT403', message = 'NOT_STAFF';
  end if;
  return v_roles;
end $$;

-- Used by RLS policies. MFA (aal2) is part of the role test.
create function mark_review.has_role(p_roles text[]) returns boolean
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select coalesce(auth.jwt() ->> 'aal', '') = 'aal2'
     and exists (select 1 from mark_review.staff s
                 where s.user_id = auth.uid() and s.active and s.role = any(p_roles))
$$;

-- ---------------------------------------------------------------- transition RPC
create function public.review_transition(
  p_review uuid, p_action text, p_expected_version integer,
  p_idempotency_key uuid, p_args jsonb default '{}'::jsonb)
returns jsonb language plpgsql volatile security definer
set search_path = pg_catalog, pg_temp as $$
declare
  v_roles   text[];
  v_uid     uuid;
  v_args    jsonb := coalesce(p_args, '{}'::jsonb);
  v_req     text;
  v_p_req   text; v_p_actor uuid; v_p_result jsonb;
  r         mark_review.reviews%rowtype;
  f         mark_review.flags%rowtype;
  v_from    text; v_to text; v_role text;
  v_reason  text;
  v_payload jsonb := '{}'::jsonb;
  v_result  jsonb;
  v_new     uuid;
  v_con     text;
  v_hex     text;
  v_found   boolean;
  v_prev_revoked boolean;
begin
  -- 1. Identity, MFA and staff membership. Role never comes from the request.
  v_roles := mark_review.require_staff();
  v_uid := auth.uid();

  -- 2. Shape of the request.
  if p_review is null or p_idempotency_key is null or p_expected_version is null
     or p_action is null or p_action not in ('claim', 'release', 'approve', 'reject', 'withdraw',
       'prepare', 'submit', 'revert', 'confirm', 'publish', 'revoke', 'reopen')
     or jsonb_typeof(v_args) <> 'object' or length(v_args::text) > 4096 then
    raise exception using errcode = '22023', message = 'INVALID_ARGUMENT';
  end if;
  v_req := encode(sha256(convert_to(jsonb_build_array(
    v_uid, p_review, p_action, p_expected_version, v_args)::text, 'UTF8')), 'hex');

  -- 3. Serialise on the review row.
  select * into r from mark_review.reviews where id = p_review for update;
  if not found then
    raise exception using errcode = 'PT404', message = 'REVIEW_NOT_FOUND';
  end if;

  -- 4. Idempotency (checked under the lock so concurrent retries agree).
  select e.request_sha256, e.actor, e.result into v_p_req, v_p_actor, v_p_result
    from mark_review.events e where e.idempotency_key = p_idempotency_key;
  if found then
    if v_p_req = v_req and v_p_actor = v_uid then
      return v_p_result;
    end if;
    raise exception using errcode = 'PT409', message = 'IDEMPOTENCY_CONFLICT';
  end if;

  -- 5. Optimistic version check: return current state, not an error.
  if r.version <> p_expected_version then
    return jsonb_build_object('ok', false, 'code', 'STALE_VERSION',
      'review_id', r.id, 'status', r.status, 'version', r.version);
  end if;

  select * into f from mark_review.flags where singleton;
  if not found then
    raise exception using errcode = 'PT503', message = 'FLAGS_MISSING';
  end if;

  -- 6. Transition table.
  v_from := r.status;
  v_to := case
    when p_action = 'claim'    and v_from = 'queued'    then 'in_review'
    when p_action = 'release'  and v_from = 'in_review' then 'queued'
    when p_action = 'approve'  and v_from = 'in_review' then 'approved'
    when p_action = 'reject'   and v_from = 'in_review' then 'rejected'
    when p_action = 'withdraw' and v_from in ('queued', 'in_review', 'approved') then 'withdrawn'
    when p_action = 'prepare'  and v_from = 'approved'  then 'prepared'
    when p_action = 'submit'   and v_from = 'prepared'  then 'submitted'
    when p_action = 'revert'   and v_from = 'submitted' then 'prepared'
    when p_action = 'confirm'  and v_from = 'submitted' then 'confirmed'
    when p_action = 'publish'  and v_from = 'confirmed' then 'published'
    when p_action = 'revoke'   and v_from = 'published' then 'revoked'
    when p_action = 'reopen'   and v_from in ('rejected', 'withdrawn') then 'queued'
  end;
  if v_to is null then
    raise exception using errcode = 'PT409', message = 'INVALID_TRANSITION';
  end if;

  -- 7. Role / assignee.
  if p_action = 'claim' then
    v_role := case when 'reviewer' = any(v_roles) then 'reviewer'
                   when 'admin' = any(v_roles) then 'admin' end;
  elsif p_action in ('release', 'reject', 'approve') then
    if r.assigned_to = v_uid and 'reviewer' = any(v_roles) then
      v_role := 'reviewer';
    elsif r.assigned_to = v_uid and p_action <> 'approve' and 'admin' = any(v_roles) then
      v_role := 'admin';
    elsif p_action <> 'approve' and 'admin' = any(v_roles) then
      v_role := 'admin';
    elsif 'reviewer' = any(v_roles) then
      raise exception using errcode = 'PT403', message = 'NOT_ASSIGNEE';
    end if;
  elsif p_action in ('withdraw', 'revoke', 'reopen') then
    v_role := case when 'admin' = any(v_roles) then 'admin' end;
  else -- prepare, submit, revert, confirm, publish
    v_role := case when 'publisher' = any(v_roles) then 'publisher' end;
  end if;
  if v_role is null then
    raise exception using errcode = 'PT403', message = 'ROLE_FORBIDDEN';
  end if;

  -- 8. Four-eyes, then the issuance flag (pinned off in this release).
  if p_action in ('prepare', 'submit', 'revert', 'confirm', 'publish') then
    if f.require_separate_publisher and r.approved_by = v_uid then
      raise exception using errcode = 'PT403', message = 'SEPARATE_PUBLISHER_REQUIRED';
    end if;
    if not f.issuance_enabled then
      raise exception using errcode = 'PT403', message = 'ISSUANCE_DISABLED';
    end if;
  end if;

  -- 9. Arguments (whitelisted per action; anything else is ignored).
  v_reason := nullif(btrim(v_args ->> 'reason'), '');
  if v_reason is not null and length(v_reason) > 500 then
    raise exception using errcode = '22023', message = 'INVALID_REASON';
  end if;
  if p_action in ('reject', 'withdraw', 'revoke', 'revert', 'reopen') and v_reason is null then
    raise exception using errcode = '22023', message = 'REASON_REQUIRED';
  end if;

  if p_action = 'claim' then
    r.assigned_to := v_uid;
    v_payload := jsonb_build_object('assignee', v_uid);
  elsif p_action = 'release' then
    v_payload := jsonb_build_object('previous_assignee', r.assigned_to);
    r.assigned_to := null;
  elsif p_action = 'approve' then
    v_hex := v_args ->> 'evidence_sha256';
    if v_hex is not null and v_hex !~ '^[0-9a-f]{64}$' then
      raise exception using errcode = '22023', message = 'INVALID_EVIDENCE_SHA256';
    end if;
    if v_args ? 'checks' and jsonb_typeof(v_args -> 'checks') <> 'object' then
      raise exception using errcode = '22023', message = 'INVALID_CHECKS';
    end if;
    r.approved_by := v_uid; r.decided_by := v_uid; r.decision_reason := v_reason;
    r.evidence_sha256 := coalesce(v_hex, r.evidence_sha256);
    v_payload := jsonb_build_object('reason', v_reason, 'evidence_sha256', v_hex,
      'checks', v_args -> 'checks', 'grader_lookup', 'not_checked');
  elsif p_action in ('reject', 'withdraw') then
    r.decided_by := v_uid; r.decision_reason := v_reason;
    v_payload := jsonb_build_object('reason', v_reason);
  elsif p_action = 'prepare' then
    if coalesce(v_args ->> 'prepared_sha256', '') !~ '^[0-9a-f]{64}$'
       or coalesce(v_args ->> 'calldata_sha256', '') !~ '^[0-9a-f]{64}$'
       or coalesce(v_args ->> 'registry', '') !~ '^0x[0-9a-fA-F]{40}$' then
      raise exception using errcode = '22023', message = 'INVALID_PREPARATION';
    end if;
    r.prepared_sha256 := v_args ->> 'prepared_sha256';
    r.calldata_sha256 := v_args ->> 'calldata_sha256';
    r.registry := lower(v_args ->> 'registry');
    r.chain_id := 46630;
    v_payload := jsonb_build_object('prepared_sha256', r.prepared_sha256,
      'calldata_sha256', r.calldata_sha256, 'chain_id', 46630, 'registry', r.registry,
      'attester', v_args ->> 'attester');
  elsif p_action = 'submit' then
    if coalesce(v_args ->> 'tx', '') !~ '^0x[0-9a-fA-F]{64}$' then
      raise exception using errcode = '22023', message = 'INVALID_TX';
    end if;
    r.tx := lower(v_args ->> 'tx');
    v_payload := jsonb_build_object('tx', r.tx, 'nonce', v_args -> 'nonce', 'from', v_args ->> 'from');
  elsif p_action = 'revert' then
    v_payload := jsonb_build_object('reason', v_reason, 'tx', r.tx);
    r.tx := null;
  elsif p_action = 'confirm' then
    if coalesce(v_args ->> 'block_number', '') !~ '^[1-9][0-9]{0,17}$'
       or coalesce(v_args ->> 'block_hash', '') !~ '^0x[0-9a-fA-F]{64}$'
       or coalesce(v_args ->> 'receipt_status', '') not in ('1', '0x1') then
      raise exception using errcode = '22023', message = 'INVALID_RECEIPT';
    end if;
    r.block_number := (v_args ->> 'block_number')::bigint;
    r.block_hash := lower(v_args ->> 'block_hash');
    v_payload := jsonb_build_object('block_number', r.block_number, 'block_hash', r.block_hash,
      'receipt_status', v_args ->> 'receipt_status', 'gas_used', v_args ->> 'gas_used',
      'cert_key', v_args ->> 'cert_key');
  elsif p_action = 'publish' then
    -- The public.marks / mark_events write is deliberately NOT implemented while
    -- issuance is pinned off; it belongs to the migration that unlocks issuance.
    r.published_at := clock_timestamp();
    v_payload := jsonb_build_object('published_at', r.published_at);
  elsif p_action = 'revoke' then
    select m.revoked into v_prev_revoked from public.marks m
      where m.grader = r.grader and m.cert = r.cert for update;
    v_found := found;
    if v_found then
      update public.marks set revoked = true, revoked_reason = v_reason, updated_at = now()
        where grader = r.grader and cert = r.cert;
    end if;
    r.revoked_reason := v_reason; r.decided_by := v_uid;
    v_payload := jsonb_build_object('reason', v_reason, 'public_mark_found', v_found,
      'previous_revoked', v_prev_revoked,
      'republish', 'add to src/revoked.json so scripts/republish_marks.mjs skips it');
  elsif p_action = 'reopen' then
    v_payload := jsonb_build_object('reason', v_reason, 'reopened_from', r.id);
  end if;

  -- 10. Write state + event atomically; unique conflicts become clean 409s.
  begin
    if p_action = 'reopen' then
      insert into mark_review.reviews (origin, reopened_from, grader, cert, last_actor)
        values ('reopen', r.id, r.grader, r.cert, v_uid) returning id into v_new;
      v_result := jsonb_build_object('ok', true, 'review_id', v_new, 'reopened_from', r.id,
        'action', p_action, 'status', 'queued', 'version', 1);
      insert into mark_review.events (review_id, action, from_status, to_status, actor,
        actor_kind, actor_role, idempotency_key, request_sha256, payload, result, version_after)
      values (v_new, p_action, null, 'queued', v_uid, 'staff', v_role, p_idempotency_key,
        v_req, v_payload, v_result, 1);
    else
      r.status := v_to; r.version := r.version + 1;
      r.updated_at := clock_timestamp(); r.last_actor := v_uid;
      update mark_review.reviews set
        status = r.status, version = r.version, assigned_to = r.assigned_to,
        approved_by = r.approved_by, decided_by = r.decided_by, last_actor = r.last_actor,
        decision_reason = r.decision_reason, evidence_sha256 = r.evidence_sha256,
        prepared_sha256 = r.prepared_sha256, calldata_sha256 = r.calldata_sha256,
        chain_id = r.chain_id, registry = r.registry, tx = r.tx,
        block_number = r.block_number, block_hash = r.block_hash,
        published_at = r.published_at, revoked_reason = r.revoked_reason,
        updated_at = r.updated_at
      where id = r.id;
      v_result := jsonb_build_object('ok', true, 'review_id', r.id, 'action', p_action,
        'status', r.status, 'version', r.version);
      insert into mark_review.events (review_id, action, from_status, to_status, actor,
        actor_kind, actor_role, idempotency_key, request_sha256, payload, result, version_after)
      values (r.id, p_action, v_from, v_to, v_uid, 'staff', v_role, p_idempotency_key,
        v_req, v_payload, v_result, r.version);
    end if;
  exception when unique_violation then
    get stacked diagnostics v_con = constraint_name;
    raise exception using errcode = 'PT409', message = case v_con
      when 'reviews_one_open' then 'OPEN_REVIEW_EXISTS'
      when 'reviews_chain_tx_unique' then 'TX_ALREADY_RECORDED'
      when 'events_idempotency_key_unique' then 'IDEMPOTENCY_CONFLICT'
      else 'CONFLICT' end;
  end;
  return v_result;
end $$;

-- ---------------------------------------------------------------- queue read RPC
-- No email or contact data is ever returned.
create function public.review_queue(p_status text default null, p_limit integer default 50)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, pg_temp as $$
declare v_out jsonb;
begin
  perform mark_review.require_staff();
  if p_limit is null or p_limit not between 1 and 200 then
    raise exception using errcode = '22023', message = 'INVALID_ARGUMENT';
  end if;
  select coalesce(jsonb_agg(to_jsonb(q) order by q.created_at, q.id), '[]'::jsonb) into v_out
  from (select rv.id, rv.origin, rv.request_id, rv.reopened_from, rv.grader, rv.cert,
               rv.status, rv.version, rv.assigned_to, rv.approved_by, rv.decided_by,
               rv.decision_reason, rv.tx, rv.registry, rv.published_at, rv.created_at, rv.updated_at
        from mark_review.reviews rv
        where p_status is null or rv.status = p_status
        order by rv.created_at, rv.id limit p_limit) q;
  return jsonb_build_object('reviews', v_out,
    -- Requests with no review of their own: either the card already has an open
    -- or published review (expected) or the enqueue trigger failed (investigate,
    -- then run mark_review.enqueue_backlog() as owner).
    'requests_for_open_card', (select count(*) from mark_intake_private.requests rq
       where not exists (select 1 from mark_review.reviews rv where rv.request_id = rq.id)
         and exists (select 1 from mark_review.reviews rv where rv.grader = rq.grader
           and rv.cert = rq.cert and rv.status not in ('rejected', 'withdrawn'))),
    'requests_without_review', (select count(*) from mark_intake_private.requests rq
       where not exists (select 1 from mark_review.reviews rv where rv.request_id = rq.id)
         and not exists (select 1 from mark_review.reviews rv where rv.grader = rq.grader
           and rv.cert = rq.cert and rv.status not in ('rejected', 'withdrawn'))));
end $$;

-- ---------------------------------------------------------------- enqueue
create function mark_review.enqueue_one(p_request uuid, p_kind text) returns uuid
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare q mark_intake_private.requests%rowtype; v_id uuid;
begin
  select * into q from mark_intake_private.requests where id = p_request;
  if not found then return null; end if;
  -- ON CONFLICT DO NOTHING covers request_id and reviews_one_open (card already
  -- has an open/published review, e.g. a backfilled Mark).
  insert into mark_review.reviews (request_id, origin, grader, cert)
    values (q.id, 'intake', q.grader, q.cert)
    on conflict do nothing returning id into v_id;
  if v_id is not null then
    insert into mark_review.events (review_id, action, from_status, to_status, actor, actor_kind,
      idempotency_key, request_sha256, payload, result, version_after)
    values (v_id, 'enqueue', null, 'queued', null, p_kind,
      md5('phase7:enqueue:' || q.id::text)::uuid,
      encode(sha256(convert_to(jsonb_build_array('enqueue', q.id)::text, 'UTF8')), 'hex'),
      jsonb_build_object('request_id', q.id, 'grader', q.grader, 'cert', q.cert, 'free', q.free),
      jsonb_build_object('ok', true, 'review_id', v_id, 'action', 'enqueue', 'status', 'queued', 'version', 1),
      1);
  end if;
  return v_id;
end $$;

create function mark_review.enqueue_request() returns trigger
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
begin
  begin
    perform mark_review.enqueue_one(new.id, 'system');
  exception when others then
    -- Never fail or alter the intake claim. The gap is visible as
    -- review_queue().requests_without_review and fixed by enqueue_backlog().
    raise warning 'mark_review enqueue skipped (SQLSTATE %); request kept', sqlstate;
  end;
  return null;
end $$;

-- Owner-run reconciliation; also used once below for existing requests.
create function mark_review.enqueue_backlog() returns integer
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare q record; n integer := 0;
begin
  for q in select rq.id from mark_intake_private.requests rq
           where not exists (select 1 from mark_review.reviews rv where rv.request_id = rq.id)
           order by rq.created_at, rq.id loop
    if mark_review.enqueue_one(q.id, 'migration') is not null then n := n + 1; end if;
  end loop;
  return n;
end $$;

create trigger mark_review_enqueue after insert on mark_intake_private.requests
  for each row execute function mark_review.enqueue_request();
-- Existing requests are enqueued at the END of 20261110_phase7_backfill.sql,
-- after the 18 Marks exist, so a request for an already-issued Mark is not
-- turned into a second open review (it is reported as requests_for_open_card).

-- ---------------------------------------------------------------- chain check
-- Read-only; owner/nightly job. Detects edits by anyone short of the DB owner
-- re-hashing the whole chain; it does not prevent owner tampering.
create function mark_review.verify_chain()
returns table (review_id uuid, events integer, ok boolean, first_bad_seq integer)
language sql stable set search_path = pg_catalog, pg_temp as $$
  with e as (
    select ev.*, lag(ev.hash) over w as expected_prev, row_number() over w as rn
    from mark_review.events ev window w as (partition by ev.review_id order by ev.seq)
  ), checked as (
    select e.review_id, e.seq, e.rn, e.to_status, e.version_after,
      (e.seq = e.rn and e.prev_hash is not distinct from e.expected_prev
       and e.hash = mark_review.event_hash(e.prev_hash, e.review_id, e.seq, e.action,
         e.from_status, e.to_status, e.actor, e.actor_kind, e.actor_role, e.idempotency_key,
         e.request_sha256, e.payload, e.result, e.created_at)) as row_ok
    from e
  ), last as (
    select distinct on (c.review_id) c.review_id, c.to_status, c.version_after
    from checked c order by c.review_id, c.seq desc
  )
  select rv.id, count(c.seq)::integer,
         coalesce(bool_and(c.row_ok), false)
           and bool_or(l.to_status = rv.status and l.version_after = rv.version),
         min(c.seq) filter (where not c.row_ok)
  from mark_review.reviews rv
  left join checked c on c.review_id = rv.id
  left join last l on l.review_id = rv.id
  group by rv.id
$$;

-- ---------------------------------------------------------------- RLS + grants
alter table mark_review.staff         enable row level security;
alter table mark_review.flags         enable row level security;
alter table mark_review.config_events enable row level security;
alter table mark_review.reviews       enable row level security;
alter table mark_review.events        enable row level security;
-- Policies are defence in depth only: no table is granted to any client role.
create policy staff_read on mark_review.reviews for select to authenticated
  using (mark_review.has_role(array['reviewer', 'publisher', 'admin']));
create policy staff_read on mark_review.events for select to authenticated
  using (mark_review.has_role(array['reviewer', 'publisher', 'admin']));
create policy own_rows on mark_review.staff for select to authenticated
  using (user_id = auth.uid() and mark_review.has_role(array['reviewer', 'publisher', 'admin']));
-- No insert/update/delete policies and no policies on flags/config_events.

revoke all on all tables in schema mark_review from public, anon, authenticated, service_role, mark_intake_rpc;
revoke all on all sequences in schema mark_review from public, anon, authenticated, service_role, mark_intake_rpc;
revoke all on all functions in schema mark_review from public, anon, authenticated, service_role, mark_intake_rpc;
revoke all on function public.review_transition(uuid, text, integer, uuid, jsonb),
                       public.review_queue(text, integer)
  from public, anon, authenticated, service_role, mark_intake_rpc;
grant execute on function public.review_transition(uuid, text, integer, uuid, jsonb),
                          public.review_queue(text, integer)
  to authenticated;
-- RLS policies evaluate has_role() as the querying role. Schema USAGE stays
-- revoked, so this grant is inert unless the schema is ever exposed.
grant execute on function mark_review.has_role(text[]) to authenticated;
commit;
