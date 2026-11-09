begin;
create table if not exists mark_intake_private.gate (singleton boolean primary key default true check (singleton), token_sha256 text check (token_sha256 ~ '^[0-9a-f]{64}$'));
alter table mark_intake_private.gate enable row level security;
revoke all on mark_intake_private.gate from public, anon, authenticated, service_role, mark_intake_rpc;
insert into mark_intake_private.gate (singleton, token_sha256)
  select true, encode(sha256(convert_to('local-gate-test-only','UTF8')),'hex')
  where not exists (select 1 from mark_intake_private.gate);
create or replace function public.claim_mark_v2(p_grader text, p_cert text, p_email text, p_token text)
returns jsonb language plpgsql security definer set search_path = pg_catalog as $$
declare g text;
begin
  select token_sha256 into g from mark_intake_private.gate where singleton;
  if p_token is null or g is null or encode(sha256(convert_to(p_token,'UTF8')),'hex') <> g then
    raise exception using errcode='PT403', message='Unauthorized';
  end if;
  return public.claim_mark_v2(p_grader, p_cert, p_email);
end $$;
create or replace function public.mark_intake_status_v2(p_token text)
returns jsonb language plpgsql security definer set search_path = pg_catalog as $$
declare g text;
begin
  select token_sha256 into g from mark_intake_private.gate where singleton;
  if p_token is null or g is null or encode(sha256(convert_to(p_token,'UTF8')),'hex') <> g then
    raise exception using errcode='PT403', message='Unauthorized';
  end if;
  return public.mark_intake_status_v2();
end $$;
revoke all on function public.claim_mark_v2(text,text,text,text), public.mark_intake_status_v2(text) from public, anon, authenticated, service_role, mark_intake_rpc;
grant execute on function public.claim_mark_v2(text,text,text,text), public.mark_intake_status_v2(text) to anon;
commit;