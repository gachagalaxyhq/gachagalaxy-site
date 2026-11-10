# Phase 7 review queue — apply, seed, rollback

Status: local build, tested on a disposable PostgreSQL 16 cluster only. Nothing
has been applied to staging or production. Design: `phase7-review-queue-design.md`.

## Approved decisions (2026-11-10) and where they are enforced

| # | Decision | Enforcement |
| --- | --- | --- |
| 1 | Approver ≠ publisher | `flags.require_separate_publisher` (default true), checked in `review_transition` and again in the `reviews_guard` trigger |
| 2 | Revoked Marks not republished; representable | `reviews.status = 'revoked'` (admin `revoke`, reason required, sets `public.marks.revoked`); republish skip stays in `scripts/republish_marks.mjs` + `src/revoked.json`; backfill maps `src/revoked.json` entries to `revoked` |
| 3 | First admin/reviewer = Matthew, MFA required | `supabase/seeds/phase7_seed_first_admin.sql` (uid passed as a parameter); `auth.jwt()->>'aal' = 'aal2'` in `require_staff()` (RPC) and `has_role()` (RLS) |
| 4 | Backfill all 18 as published, receipts verified | `scripts/phase7_backfill.py` → `20261110_phase7_backfill.sql`; first six cite `operations/pre-issuance-receipts-check.json`, registry recorded per event |

Flags `issuance_enabled`, `payments_enabled` and `live_grader_lookup` are pinned
false by CHECK constraints. Turning any of them on needs a new, reviewed migration.

## Files

| File | Purpose |
| --- | --- |
| `supabase/migrations/20261110_phase7_review_queue.sql` | Schema `mark_review`, RPCs `public.review_transition`, `public.review_queue`, enqueue trigger |
| `supabase/migrations/20261110_phase7_backfill.sql` | GENERATED. 18 Marks + enqueue of existing requests |
| `supabase/migrations/20261110_phase7_review_queue_rollback.sql` | Full reversal (refuses if staff audit exists unless opted in) |
| `supabase/seeds/phase7_seed_first_admin.sql` | Matthew's staff rows |
| `scripts/phase7_backfill.py`, `tests/test_phase7_backfill.py` | Generator + unit test |
| `tests/phase7/run.sh` | Real-Postgres test runner |

## Seed (one statement; run as the migration owner)

```sql
insert into mark_review.staff (user_id, role, granted_by) values (:'matthew_uid'::uuid, 'admin', :'matthew_uid'::uuid), (:'matthew_uid'::uuid, 'reviewer', :'matthew_uid'::uuid) on conflict (user_id, role) do update set active = true;
```

`matthew_uid` = his Supabase Auth user id (Dashboard → Authentication → Users → UID).
The `auth.users` foreign key rejects a wrong id. He is not a publisher (decision 1).
He can't act until he signs in with MFA (aal2). Seeding before he enrols is safe.

## Local test

```sh
bash tests/phase7/run.sh
```

## Production apply (owner only, after staging rehearsal)

Each file has its own `begin; … commit;`. Do not wrap it in `psql -1`, and do
not use `supabase db push` (filename order is not apply order). `$OWNER_DB_URL`
is the migration-owner (`postgres`) connection, supplied out of band, never committed.

0. Read-only preflight. Confirm the intake objects match the repo and that Phase 7 is absent:
   ```sql
   select to_regnamespace('mark_review');                       -- expect NULL
   select p.oid::regprocedure, p.prosecdef, p.proconfig, p.proacl from pg_proc p
    where p.proname in ('claim_mark','claim_mark_gate','claim_mark_v2','mark_intake_status_v2');
   select tgname from pg_trigger where tgrelid = 'mark_intake_private.requests'::regclass and not tgisinternal;  -- expect none
   select count(*) from mark_intake_private.requests;
   ```
   Save the output. It is the "before" picture for the rollback check.
1. `git rev-parse HEAD` is the reviewed commit. `python3 scripts/phase7_backfill.py --check` prints `backfill up to date`.
2. `psql "$OWNER_DB_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/20261110_phase7_review_queue.sql`
3. `psql "$OWNER_DB_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/20261110_phase7_backfill.sql`
4. `psql "$OWNER_DB_URL" -v ON_ERROR_STOP=1 -v matthew_uid=<uuid> -f supabase/seeds/phase7_seed_first_admin.sql`
5. `psql "$OWNER_DB_URL" -c "notify pgrst, 'reload schema'"`. This exposes the two `public.review_*` RPCs.
6. Verify (read-only):
   ```sql
   select status, count(*) from mark_review.reviews group by 1;   -- 18 published (+ queued intake rows)
   select count(*) from mark_review.verify_chain() where not ok;   -- 0
   select * from mark_review.flags;                                -- all false, require_separate_publisher true
   select user_id, role, active from mark_review.staff;            -- Matthew: admin, reviewer
   ```
   Re-run the step-0 function query. It must match exactly. A duplicate intake claim must still return `requested`.

## Rollback

* **Soft (keeps the audit; first choice once there is staff activity):**
  ```sql
  begin;
  revoke execute on function public.review_transition(uuid,text,integer,uuid,jsonb), public.review_queue(text,integer) from authenticated;
  drop trigger if exists mark_review_enqueue on mark_intake_private.requests;
  commit;
  notify pgrst, 'reload schema';
  ```
  Intake is then exactly as it was before Phase 7. Re-enable it with the grant plus `create trigger …` from the migration, then run `select mark_review.enqueue_backlog();`.
* **Full:** `psql "$OWNER_DB_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/20261110_phase7_review_queue_rollback.sql`, then `notify pgrst, 'reload schema'`.
  If any staff action exists, the rollback refuses. Export the audit first:
  `\copy (select * from mark_review.events order by review_id, seq) to 'phase7-events.csv' csv header`.
  Then run it in one session with `set phase7.rollback_discard_audit = 'yes';` before `\i` of the file.
  One thing is not reversed: a `revoke` already written to `public.marks`.
* Re-apply after rollback = steps 2–5 (the local test runs this full cycle).

Do not mix DB rollback with a Cloudflare rollback (`operations/release-runbook.md`).
