-- LOCAL CANDIDATE. No operator role or retention duration is approved here.
-- Owner-only, explicit operations; no scheduled deletion, gateway or intake grants.
begin;
alter table mark_intake_private.requests alter column email drop not null;
create table mark_intake_private.contact_audit (
  event_id bigint generated always as identity primary key,
  request_id uuid not null references mark_intake_private.requests(id),
  action text not null check (action in ('read', 'erase')),
  reference text not null check (length(btrim(reference)) between 1 and 200),
  actor name not null,
  happened_at timestamptz not null default clock_timestamp()
);
alter table mark_intake_private.contact_audit enable row level security;
revoke all on mark_intake_private.contact_audit from public, anon, authenticated, service_role, mark_intake_rpc;
revoke all on sequence mark_intake_private.contact_audit_event_id_seq from public, anon, authenticated, service_role, mark_intake_rpc;

-- SECURITY INVOKER: only the trusted migration owner initially has access.
-- Do not expose these functions through the gateway or grant table access to intake.
create function mark_intake_private.read_contact(p_id uuid, p_reference text)
returns text language plpgsql security invoker set search_path = pg_catalog as $$
declare contact text;
begin
  if p_reference is null or length(btrim(p_reference)) not between 1 and 200 then
    raise exception 'Operator reference required';
  end if;
  select email into contact from mark_intake_private.requests where id = p_id for update;
  if not found then raise exception 'Unknown request'; end if;
  insert into mark_intake_private.contact_audit(request_id, action, reference, actor)
    values(p_id, 'read', p_reference, session_user);
  return contact;
end;
$$;

create function mark_intake_private.erase_contacts(p_ids uuid[], p_created_before timestamptz, p_reference text)
returns integer language plpgsql security invoker set search_path = pg_catalog as $$
declare item uuid; removed integer := 0; contact text;
begin
  if p_reference is null or length(btrim(p_reference)) not between 1 and 200
    or p_created_before is null or p_created_before > clock_timestamp()
    or p_ids is null or cardinality(p_ids) not between 1 and 100
    or array_position(p_ids, null) is not null
    or (select count(distinct v) from unnest(p_ids) v) <> cardinality(p_ids) then
    raise exception 'Explicit bounded erasure selection required';
  end if;
  -- Stable ordering avoids opposite-order batches deadlocking. Any missing/new
  -- row rejects the entire transaction, including all earlier erasures/audits.
  for item in select v from unnest(p_ids) v order by v loop
    select email into contact from mark_intake_private.requests
      where id = item and created_at < p_created_before for update;
    if not found then raise exception 'Erasure selection mismatch'; end if;
    if contact is not null then
      update mark_intake_private.requests set email = null where id = item;
      insert into mark_intake_private.contact_audit(request_id, action, reference, actor)
        values(item, 'erase', p_reference, session_user);
      removed := removed + 1;
    end if;
  end loop;
  return removed;
end;
$$;
revoke all on function mark_intake_private.read_contact(uuid,text),
  mark_intake_private.erase_contacts(uuid[],timestamptz,text)
  from public, anon, authenticated, service_role, mark_intake_rpc;
-- Erasure retains identity/free/status/ID and never refunds usage. Duplicate
-- claims cannot repopulate an erased contact (claim_mark_v2 never updates email).
commit;
