-- Phase 7 first staff: Matthew as admin + reviewer (decision 3).
-- Run as the migration owner AFTER 20261110_phase7_review_queue.sql, passing
-- his Supabase Auth user id (Dashboard -> Authentication -> Users -> UID):
--   psql "$OWNER_URL" -v ON_ERROR_STOP=1 -v matthew_uid=<uuid> -f supabase/seeds/phase7_seed_first_admin.sql
-- One statement. The auth.users foreign key makes it fail if the id is wrong.
-- Idempotent (re-activates the roles). He is deliberately NOT a publisher:
-- the approver must differ from the publisher. Staff actions stay denied until
-- he signs in with MFA (aal2); seeding before MFA enrolment is safe.
insert into mark_review.staff (user_id, role, granted_by) values (:'matthew_uid'::uuid, 'admin', :'matthew_uid'::uuid), (:'matthew_uid'::uuid, 'reviewer', :'matthew_uid'::uuid) on conflict (user_id, role) do update set active = true;
