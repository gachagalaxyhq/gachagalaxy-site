-- Rollback for 20261110_phase7_review_queue.sql (+ 20261110_phase7_backfill.sql).
-- Restores the database to exactly the pre-Phase-7 intake state: drops the
-- enqueue trigger on mark_intake_private.requests, the two public RPCs and the
-- whole mark_review schema. Intake tables, rows, claim_mark_v2 (both
-- signatures), mark_intake_status_v2 and all intake grants are not touched.
--
-- Not reversed: if an admin used `revoke` on a published Mark, the
-- public.marks.revoked/revoked_reason update stays (it is the public truth).
--
-- AUDIT GUARD: once any staff action has been recorded, dropping the schema
-- would destroy the audit trail. The rollback then refuses unless the operator
-- explicitly opts in within the same session, after exporting the events:
--   \copy (select * from mark_review.events order by review_id, seq) to 'phase7-events.csv' csv header
--   set phase7.rollback_discard_audit = 'yes';
-- A softer, audit-preserving disable is in docs/phase7-review-queue-apply.md.
begin;
set local lock_timeout = '5s';
do $$
begin
  if to_regnamespace('mark_review') is not null
     and exists (select 1 from mark_review.events where actor_kind = 'staff')
     and coalesce(current_setting('phase7.rollback_discard_audit', true), '') <> 'yes' then
    raise exception 'phase7 rollback refused: staff audit events exist (export them, then set phase7.rollback_discard_audit = ''yes'')';
  end if;
end $$;
drop trigger if exists mark_review_enqueue on mark_intake_private.requests;
drop function if exists public.review_transition(uuid, text, integer, uuid, jsonb);
drop function if exists public.review_queue(text, integer);
-- The append-only TRUNCATE triggers do not fire on DROP; CASCADE removes the
-- schema's tables, functions, triggers and policies only.
drop schema if exists mark_review cascade;
commit;
