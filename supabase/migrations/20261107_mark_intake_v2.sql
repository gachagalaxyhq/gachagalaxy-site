-- REVIEW CANDIDATE ONLY. Never infer/alter the unknown legacy mark_requests
-- schema. This isolated contract starts CLOSED and consumes no new allowance.
begin;
create schema mark_intake_private;
revoke all on schema mark_intake_private from public;
create role mark_intake_rpc nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;

create table mark_intake_private.policy (
  singleton boolean primary key default true check (singleton),
  approved boolean not null default false,
  legacy_reconciled boolean not null default false,
  scope text check (scope = 'global'), -- candidate reflects historical counter only
  free_limit integer not null default 10 check (free_limit = 10),
  used integer check (used >= 0), -- includes historical consumption; NEVER reset at launch
  approval_reference text,
  check (not approved or (legacy_reconciled and scope is not null and used is not null
    and length(btrim(approval_reference)) > 0 and approval_reference is not null))
);
insert into mark_intake_private.policy (singleton) values (true);

create table mark_intake_private.requests (
  id uuid primary key default gen_random_uuid(),
  grader text not null check (grader in ('PSA', 'CGC')),
  cert text not null check (cert ~ '^[1-9][0-9]{5,9}$'),
  email text not null check (length(email) <= 254 and email = lower(btrim(email))
    and email !~ '[[:cntrl:][:space:]]' and email ~ '^[^@]+@[^@]+\.[^@]{2,}$'),
  status text not null default 'requested' check (status = 'requested'),
  free boolean not null,
  created_at timestamptz not null default now(),
  unique (grader, cert)
);
alter table mark_intake_private.policy enable row level security;
alter table mark_intake_private.requests enable row level security;
-- No public/authenticated policies: neither contacts nor requests are public.
revoke all on all tables in schema mark_intake_private from public, anon, authenticated, service_role, mark_intake_rpc;
revoke all on schema mark_intake_private from anon, authenticated, service_role, mark_intake_rpc;

create function public.claim_mark_v2(p_grader text, p_cert text, p_email text)
returns jsonb language plpgsql security definer set search_path = pg_catalog as $$
declare
  p mark_intake_private.policy%rowtype;
  r mark_intake_private.requests%rowtype;
  was_existing boolean;
begin
  -- Validate again at the database boundary; direct RPC cannot bypass validation.
  if p_grader is null or p_grader not in ('PSA', 'CGC') or p_cert is null
    or p_cert !~ '^[1-9][0-9]{5,9}$' or p_email is null or length(p_email) > 254
    or p_email <> lower(btrim(p_email)) or p_email ~ '[[:cntrl:][:space:]]'
    or p_email !~ '^[^@]+@[^@]+\.[^@]{2,}$' then
    raise exception using errcode = '22023', message = 'Invalid intake fields';
  end if;
  -- One lock orders duplicate detection AND allowance allocation. An insert
  -- failure rolls back the counter in the same transaction. No client limit.
  select * into p from mark_intake_private.policy where singleton for update;
  if not found or not p.approved or not p.legacy_reconciled or p.scope is distinct from 'global' or p.used is null then
    raise exception using errcode = 'PT409', message = 'Intake approval required';
  end if;
  select * into r from mark_intake_private.requests where grader = p_grader and cert = p_cert;
  was_existing := found;
  if not was_existing then
    insert into mark_intake_private.requests(grader, cert, email, free)
      values (p_grader, p_cert, p_email, p.used < p.free_limit) returning * into r;
    if r.free then
      update mark_intake_private.policy set used = used + 1 where singleton returning * into p;
    end if;
  end if;
  -- Never overwrite a prior contact, reallocate entitlement or disclose email.
  return jsonb_build_object('contract', 'mark-intake-v2', 'id', r.id, 'grader', r.grader,
    'cert', r.cert, 'status', r.status, 'free', r.free, 'existing', was_existing,
    'remaining', greatest(p.free_limit - p.used, 0), 'freeLimit', p.free_limit, 'policy_scope', p.scope);
end;
$$;

create function public.mark_intake_status_v2()
returns jsonb language plpgsql security definer set search_path = pg_catalog as $$
declare p mark_intake_private.policy%rowtype;
begin
  select * into p from mark_intake_private.policy where singleton;
  if not found or not p.approved or not p.legacy_reconciled or p.scope is distinct from 'global' or p.used is null then
    raise exception using errcode = 'PT409', message = 'Intake approval required';
  end if;
  return jsonb_build_object('contract', 'mark-intake-v2', 'remaining', greatest(p.free_limit - p.used, 0),
    'freeLimit', p.free_limit, 'policy_scope', p.scope);
end;
$$;

revoke all on function public.claim_mark_v2(text,text,text), public.mark_intake_status_v2() from public, anon, authenticated, service_role;
grant usage on schema public to mark_intake_rpc;
grant execute on function public.claim_mark_v2(text,text,text), public.mark_intake_status_v2() to mark_intake_rpc;
-- Credential issuance / authenticator membership are deliberately NOT supplied.
-- A trusted DB owner must approve and provision the scoped server identity.
commit;
