-- LOCAL TEST ONLY. Stand-ins for live legacy objects with no checked-in
-- definition (claim_mark, claim_mark_gate, public.mark_requests). Bodies are
-- fake; only their existence, signatures and grants mimic the live facts, so
-- the suite can prove Phase 7 does not touch them. Run as postgres.
begin;
create table public.mark_requests (id bigint generated always as identity primary key,
  psa_cert text, status text, reason text, free boolean, created_at timestamptz default now());
alter table public.mark_requests enable row level security;
create function public.claim_mark(p_cert text, p_reason text, p_limit integer)
returns jsonb language sql security definer set search_path = pg_catalog as $$
  select jsonb_build_object('stub', 'claim_mark') $$;
create function public.claim_mark_gate(p_grader text, p_cert text, p_email text, p_token text)
returns jsonb language sql security definer set search_path = pg_catalog as $$
  select jsonb_build_object('stub', 'claim_mark_gate') $$;
revoke all on function public.claim_mark(text, text, integer), public.claim_mark_gate(text, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.claim_mark(text, text, integer) to service_role;
grant execute on function public.claim_mark_gate(text, text, text, text) to anon;
commit;
