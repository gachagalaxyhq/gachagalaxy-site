# Phase 7: Mark review queue — design

Status: design only. Nothing here is applied, deployed or approved. Branch inspected: `release/live-9-nov` at `c7fd311`. No live database, chain, secrets or production API was touched. Line numbers refer to that commit.

## 1. Current state

### 1.1 How a request flows today

1. The page POSTs `cert`, `grader`, `email` to `/api/mark-request` (`functions/api/mark-request.js:78-98`). The handler validates and canonicalises them.
2. The source gate is open: `INTAKE_AVAILABLE = true` (`mark-request.js:3`). If any of `MARK_INTAKE_RPC_TOKEN`, `MARK_INTAKE_API_KEY` or `MARK_INTAKE_GATE` is missing, it returns 503 `INTAKE_NOT_CONFIGURED` (`:59`, `:105`).
3. It calls PostgREST `rpc/claim_mark_v2` with `p_grader, p_cert, p_email, p_token` (`:61-65`, `:104`). The four-argument wrapper checks the gate token hash, then calls the three-argument function (`supabase/migrations/20261107_mark_intake_gate.sql:8-17`).
4. `claim_mark_v2` locks the policy row, dedupes on `(grader, cert)`, inserts, and allocates the free slot in one transaction (`20261107_mark_intake_v2.sql:54-66`).
5. The handler accepts only an exact contract and `status === 'requested'` (`mark-request.js:108-110`).

### 1.2 Where it is stored

| Data | Location | Notes |
| --- | --- | --- |
| Requests | `mark_intake_private.requests` (`v2.sql:21-31`) | `status` can only be `requested` (`:27`). Unique `(grader, cert)` (`:30`). |
| Allowance | `mark_intake_private.policy` (`v2.sql:8-19`) | Global ten; closed until approved. |
| Gate token | `mark_intake_private.gate` (`gate.sql:2-7`) | Seeded with the digest of `local-gate-test-only`. |
| Contact audit | `mark_intake_private.contact_audit` (`20261107_mark_contact_ops.sql:5-12`) | Read/erase only. |
| Public Marks | `public.marks`, `public.mark_events` (`20261026_a5_public_marks.sql:3-44`) | PSA only (`:4`); `visible` defaults true (`:24`). |
| Issuance evidence | `operations/*-receipts.json`, `*-publication-ready.json` | Files only. Both say `database_written: false`. |

### 1.3 What is missing

- No review state. Intake is "interest recorded", nothing more (`operations/mark-review-plan.md:12`).
- No reviewer identity, roles or private queue endpoints.
- No link from request → review → calldata → signature → receipt → publication. The signing page uses a checkbox (`operations/mark-signing.template.html:81`) and downloads JSON with `public_index_updated:false` (`:89`). That is not a durable audit.
- No DB writer for publication. Indexers (`scripts/index_issued_six.py`, `scripts/index_marks_to_18.py`) only update local files.
- A second signing path has no gate: `.github/workflows/republish-marks.yml` runs `scripts/republish_marks.mjs`, which republishes every Mark in `src/onchain.json` monthly (`republish_marks.mjs:12-15`), with no revoked check.
- No checked-in definition of legacy `mark_requests` or `claim_mark` (`mark-review-plan.md:37-40`).

### 1.4 Cause of 502 `REQUEST_UNCONFIRMED`

`uncertain()` (`mark-request.js:12`) is returned for **every** RPC failure except 409 (`:106`), for any thrown error (`:114`), and for any contract mismatch (`:108-110`). So 502 hides at least four distinct faults. I cannot see the live database, so these are ranked by evidence:

| Rank | Likely cause | Evidence | PostgREST status → handler |
| --- | --- | --- | --- |
| 1 | Role mismatch on the wrapper. EXECUTE on the 4-arg functions is granted to `anon` only (`gate.sql:29`). The bearer is meant to switch to `mark_intake_rpc`, which has only the 3-arg grant (`v2.sql:89`). | `mark-review-plan.md:104-110` flags this. | 42501 → 401/403 → 502 |
| 2 | Gate token mismatch. The table is seeded with a test digest (`gate.sql:5-7`). A production `MARK_INTAKE_GATE` value will not match unless the row was replaced. | `PT403` raise (`gate.sql:13-14`). | 403 → 502 |
| 3 | Wrapper missing or schema cache stale. Migration filenames sort gate before v2 (`mark-review-plan.md:113-114`); gate would fail without v2. | No checked-in apply order. | PGRST202 404 → 502 |
| 4 | Transport: >5 s deadline, body >4 KB, bad UTF-8 (`:16-42`, `:57`). | Tests cover these (`tests/mark-operations.test.mjs:31-39`). | throw → 502 |

Not causes: a closed policy gives `PT409` → 503 (`v2.sql:56`, `mark-request.js:106`). An exhausted allowance still succeeds with `free:false`.

**Important for Phase 7:** if review status were added to `requests.status`, a duplicate claim on a reviewed cert would return a non-`requested` status and hit `:110` → 502. This design avoids that.

## 2. Data model

Decision: keep intake immutable. Put review in a separate private schema, one review row per request, linked by `request_id`. The intake response contract stays unchanged.

```sql
create schema mark_review;
revoke all on schema mark_review from public, anon, authenticated;

create table mark_review.staff (
  user_id    uuid primary key references auth.users(id),
  role       text not null check (role in ('reviewer','publisher','admin')),
  active     boolean not null default true,
  granted_by uuid not null references auth.users(id),
  granted_at timestamptz not null default clock_timestamp()
);

-- All flags start false. Only the migration owner may change them.
create table mark_review.flags (
  singleton          boolean primary key default true check (singleton),
  issuance_enabled   boolean not null default false,
  payments_enabled   boolean not null default false check (not payments_enabled),
  live_grader_lookup boolean not null default false check (not live_grader_lookup)
);
insert into mark_review.flags default values;

create table mark_review.reviews (
  id              uuid primary key default gen_random_uuid(),
  request_id      uuid unique references mark_intake_private.requests(id),
  origin          text not null check (origin in ('intake','backfill')),
  grader          text not null check (grader in ('PSA','CGC')),
  cert            text not null check (cert ~ '^[1-9][0-9]{5,9}$'),
  status          text not null default 'queued' check (status in
                  ('queued','in_review','approved','rejected','withdrawn',
                   'prepared','submitted','confirmed','published','revoked')),
  version         integer not null default 1,
  assigned_to     uuid references auth.users(id),
  decided_by      uuid references auth.users(id),
  decision_reason text check (length(decision_reason) <= 500),
  prepared_sha256 text check (prepared_sha256 ~ '^[0-9a-f]{64}$'),
  evidence_sha256 text check (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  calldata_sha256 text check (calldata_sha256 ~ '^[0-9a-f]{64}$'),
  chain_id        integer check (chain_id = 46630),
  registry        text,
  tx              text check (tx ~ '^0x[0-9a-fA-F]{64}$'),
  block_number    bigint,
  block_hash      text,
  published_at    timestamptz,
  revoked_reason  text,
  created_at      timestamptz not null default clock_timestamp(),
  updated_at      timestamptz not null default clock_timestamp(),
  check (origin = 'backfill' or request_id is not null),
  check (status not in ('submitted','confirmed','published') or tx is not null),
  unique (chain_id, tx)
);
-- One live review per card. Rejected/withdrawn rows do not block a new one.
create unique index reviews_one_live on mark_review.reviews (grader, cert)
  where status not in ('rejected','withdrawn');

create table mark_review.events (
  id              bigint generated always as identity primary key,
  review_id       uuid not null references mark_review.reviews(id),
  seq             integer not null,
  action          text not null,
  from_status     text,
  to_status       text not null,
  actor           uuid,            -- null only for system/backfill
  actor_kind      text not null check (actor_kind in ('staff','system','migration')),
  actor_role      text,
  idempotency_key uuid not null unique,
  request_sha256  text not null,   -- hash of canonical action input
  payload         jsonb not null default '{}',
  prev_hash       text,
  hash            text not null,
  created_at      timestamptz not null default clock_timestamp(),
  unique (review_id, seq)
);
```

Link chain recorded on `reviews` and in event payloads: `request_id` → `prepared_sha256` (preparation file digest, as in `receipts.json` `prepared_sha256`) → `calldata_sha256` (sha256 of `unsigned_transaction.data`) → `tx`, `block_number`, `block_hash` → `public.mark_events (chain_id, tx)` (unique at `a5_public_marks.sql:41`).

No email is copied into `mark_review`. Reviewers see contact only via the audited `read_contact` (`contact_ops.sql:19-32`), if approved.

## 3. State machine

| From | To | Action | Who | Flag needed |
| --- | --- | --- | --- | --- |
| — | queued | enqueue (trigger on intake insert) | system | — |
| queued | in_review | claim | reviewer, admin | — |
| in_review | queued | release | assignee, admin | — |
| in_review | approved | approve | assignee (reviewer) | — |
| in_review | rejected | reject (reason required) | assignee, admin | — |
| queued, in_review, approved | withdrawn | withdraw (reason required) | admin | — |
| approved | prepared | freeze calldata + digests | publisher | `issuance_enabled` |
| prepared | submitted | record tx hash | publisher | `issuance_enabled` |
| submitted | prepared | receipt reverted/dropped | publisher | `issuance_enabled` |
| submitted | confirmed | verified receipt | publisher | `issuance_enabled` |
| confirmed | published | write `public.marks`/`mark_events` | publisher | `issuance_enabled` |
| published | revoked | revoke (reason required) | admin | — |

- **Terminal:** `rejected`, `withdrawn`, `revoked`. `published` is stable but may move to `revoked`.
- **Phase 7 live scope:** only `queued → in_review → approved/rejected/withdrawn`. Every transition after `approved` fails while `issuance_enabled = false`. Approval does not issue anything.
- **Revocation:** sets `public.marks.revoked = true` and `revoked_reason` (`a5_public_marks.sql:22-23`) in the same transaction as the event. The Mark stays visible with a revoked label. The contract ABI in the signing page has no revoke call (`mark-signing.template.html:18`), so onchain revocation means "do not republish". `republish_marks.mjs` must skip revoked Marks before any revocation is used (see Q3).
- **Separation:** an approver may not perform `prepared`/`submitted` on the same review (four-eyes; see Q2).

## 4. Roles and authorisation

| Role | Can do | Cannot do |
| --- | --- | --- |
| reviewer | list queue, claim, release, approve, reject | prepare, publish, revoke, grant roles |
| publisher | prepare, submit, confirm, publish (all flag-gated) | approve; act on a review they approved |
| admin | assign, withdraw, revoke, grant/remove staff | change flags; read contacts without audit |
| migration owner | apply DDL, set flags, run backfill | — (not a login used by the app) |

Server-side enforcement:

- Identity is `auth.uid()` from a Supabase Auth session JWT. Role comes from `mark_review.staff`, never from `user_metadata` or request bodies.
- Tables: RLS enabled. No table grants to `anon` or `authenticated`. Deny by default.
- Read access for staff (defence in depth, in case the schema is ever exposed):

```sql
alter table mark_review.reviews enable row level security;
alter table mark_review.events  enable row level security;
alter table mark_review.staff   enable row level security;
create function mark_review.has_role(r text[]) returns boolean
  language sql stable security definer set search_path = pg_catalog as $$
  select exists (select 1 from mark_review.staff
                 where user_id = auth.uid() and active and role = any(r)) $$;
create policy staff_read on mark_review.reviews for select to authenticated
  using (mark_review.has_role(array['reviewer','publisher','admin']));
create policy staff_read on mark_review.events for select to authenticated
  using (mark_review.has_role(array['reviewer','publisher','admin']));
-- No insert/update/delete policies: writes only via the RPC below.
```

- Writes go through one `SECURITY DEFINER` function, `public.review_transition(p_review uuid, p_action text, p_expected_version int, p_idempotency_key uuid, p_args jsonb)`, with `search_path = pg_catalog`, granted to `authenticated` only. It checks role, assignee, four-eyes and flags inside the database.
- Ignored if sent: actor, role, timestamps, `from_status`, grader, cert, tx fields on non-publisher actions. Grader and cert come from the request row.
- Staff UI is a separate authenticated route. No `GET ?id=` or cert lookup on the public site (`mark-review-plan.md:69-75`).
- The service-role key is never used by the queue. No new secrets are needed for reviewers; they sign in.

## 5. Concurrency and idempotency

**Duplicate intake on the same grader+cert.** Already handled: one policy lock plus `unique (grader, cert)` (`v2.sql:30`, `:54`). The enqueue trigger runs in the same transaction, so a request and its review row commit together or not at all. `reviews_one_live` stops two live reviews for one card.

**Idempotency keys.** Every staff action carries a client UUID. The function:

1. Looks up `events.idempotency_key`. If found and `request_sha256` matches, it returns the stored result. Same input, same answer, every retry.
2. If found with a different hash, it returns `409 IDEMPOTENCY_CONFLICT`.

**Locking.** Inside `review_transition`:

```sql
select * into r from mark_review.reviews where id = p_review for update;
if r.version <> p_expected_version then
  -- return current state, not an error page
  return jsonb_build_object('ok', false, 'code', 'STALE_VERSION',
                            'status', r.status, 'version', r.version);
end if;
-- check transition table, role, flags; then:
update mark_review.reviews set status = v_to, version = version + 1,
       updated_at = clock_timestamp() where id = p_review;
insert into mark_review.events (... seq = (select coalesce(max(seq),0)+1 ...), ...);
```

`FOR UPDATE` serialises writers on one review. The `version` check catches stale screens. Two reviewers clicking "claim" at once: one wins; the other gets `STALE_VERSION` with the winner's state.

**Deterministic intake responses instead of 502.** Proposed handler change (later release, not now):

| Upstream result | New response |
| --- | --- |
| 200 valid | 200 `accepted` (unchanged) |
| 409 / PT409 | 503 `INTAKE_NOT_CONFIGURED` (unchanged) |
| 401, 403, 404 | 503 `INTAKE_MISCONFIGURED`, `retryable:false`. Nothing was saved: the call failed before the insert. |
| 400 / 22023 | 400 `INVALID_FIELDS` |
| timeout, 5xx, bad body | One automatic retry within the deadline. `claim_mark_v2` is idempotent for the same grader+cert, so a retry returns `existing:true`. Only if that also fails: 502 `REQUEST_UNCONFIRMED`, `retryable:true`. |

Also log a server-side correlation ID with the upstream status class only. No headers, tokens or emails in logs.

## 6. Audit trail

Append-only enforcement:

```sql
create function mark_review.deny_change() returns trigger
  language plpgsql as $$ begin
  raise exception using errcode = '42501', message = 'events are append-only'; end $$;
create trigger events_no_update before update or delete on mark_review.events
  for each row execute function mark_review.deny_change();
create trigger events_no_truncate before truncate on mark_review.events
  for each statement execute function mark_review.deny_change();
revoke update, delete, truncate on mark_review.events from public, authenticated;
```

Hash chain (per review): `hash = sha256(prev_hash || seq || action || to_status || actor || request_sha256 || payload::text || created_at)`. `seq` is assigned under the review row lock, so the chain has no gaps. A nightly read-only check recomputes chains. This detects tampering by anyone short of the DB owner. It does not prevent it.

What each step records in `payload`:

| Step | Recorded |
| --- | --- |
| enqueue | request_id, grader, cert, free flag. No email. |
| claim / release | assignee |
| approve / reject / withdraw | reason, evidence checklist (as `not_checked` values from `publication-ready.json` `checks`), `evidence_sha256` |
| prepared | `prepared_sha256`, `calldata_sha256`, chain_id 46630, registry, attester |
| submitted | tx hash, nonce, from address |
| confirmed | block number, block hash, receipt status, `gas_used`, event `cert_key` |
| published | `public.marks` row digest, `mark_events.id` |
| revoked | reason, previous `revoked` value |
| backfilled | source file path and its sha256 |

Reviewer row changes (`staff`) get their own append-only `staff_events` table with the same trigger.

## 7. Guardrails preserved

- **Payments stay off.** `PAYMENTS_AVAILABLE = false` and the env check (`functions/api/stripe-webhook.js:3`, `:34`) stay. `flags.payments_enabled` has a `check (not payments_enabled)`. No review action touches Stripe or legacy `mark_requests` payment fields.
- **Issuance stays off.** `flags.issuance_enabled = false`. Every post-approval transition checks it. No signing page or keystore is wired to the queue. `republish-marks.yml` is out of scope and must not be run as part of Phase 7.
- **No live grader verification.** `flags.live_grader_lookup` is pinned false. Reviewer UI shows "PSA cert ref" and "Grader lookup: not checked", matching `src/platform.tpl.html:484` and tests (`tests/collector-product-positioning.test.mjs:8`). "Approved" means "evidence reviewed", not "verified by PSA". PSA API activation remains pending. CGC Marks stay impossible in `public.marks` (`a5_public_marks.sql:4`).
- **Public Mark pages unchanged.** Nothing is written to `public.marks` before `published`; `visible` defaults true, so an early insert would leak (`mark-review-plan.md:56-59`).
- **No credentials in Git.** No new secrets for the queue. The gate test digest (`gate.sql:6`) must be replaced out of band, never by a committed value. The publishable key in `functions/verify/[grader]/[cert].js:4` is a publishable key; no service key may be added.

## 8. Migration plan

Prerequisite: the DB owner confirms the deployed intake objects and grants (redacted), and the apply order of v2 then gate. Nothing below runs until approved. Each step goes first to a disposable Postgres (existing harness pattern, `tests/mark-intake-postgres.mjs`), then staging, then production.

| # | Step | Reversal |
| --- | --- | --- |
| 1 | Create `mark_review` schema, `staff`, `flags` (all false). | `drop schema mark_review cascade` (empty). |
| 2 | Create `reviews`, `events`, `staff_events`, append-only triggers, RLS. | Drop tables (no data yet). |
| 3 | Create `review_transition`, `review_list`; grant to `authenticated`. Reload PostgREST schema cache. | Revoke EXECUTE; drop functions. |
| 4 | Add `AFTER INSERT` trigger on `mark_intake_private.requests` to enqueue. Backfill `queued` rows for existing requests (one event each, `actor_kind='migration'`). | Drop trigger. Review rows stay, harmless. Before go-live: drop schema. |
| 5 | Backfill the 18 Marks from a digest-pinned manifest (below). | Before go-live: drop and redo. After: append a `backfill_superseded` event; never delete. |
| 6 | Grant first staff roles. | Set `active = false` (logged). |
| 7 | Handler 502 mapping (section 5) via `operations/release-runbook.md`. | Cloudflare rollback to `0c2ba2bd` (`release-runbook.md:31-34`). |
| 8 | Patch `republish_marks.mjs` to skip revoked Marks before any revoke is used. | Revert commit; revocation stays unused. |

**Backfill of the 18 Marks.** An offline script, modelled on `scripts/mark-cutover.mjs --dry-run`, builds a manifest. It reads files only and records each source file's sha256.

| Batch | Identities | Source | Fields available |
| --- | --- | --- | --- |
| First six | 100863346, 111992917, 154790134, 153708045, 118973623, 109308847 | `operations/pre-issuance-onchain.json` (tx per event, incl. republishes), `operations/pre-18-certs.json` | tx, timestamp. No receipt journal, block or evidence digest. |
| Additional six | 158538600, 151114672, 162925956, 120515467, 171402573, 163541653 | `operations/additional-marks-receipts.json`, `additional-marks-publication-ready.json` | full receipt, `prepared_sha256`, `evidence_sha256`, block hash |
| To-18 six | 136213011, 140506564, 152219900, 167034492, 153059587, 110153218 | `operations/marks-to-18-receipts.json`, `marks-to-18-publication-ready.json` | as above |

Rules: `origin='backfill'`, `request_id = null`. Use the first (issuance) tx per Mark; later republish txs go into the event payload. Status is `published` if a matching `public.marks` row exists, else `confirmed`. The first six get `payload.receipt_verified = false` until a read-only chain check is approved. Assert exactly 18 rows, 18 distinct identities, and tx hashes equal to `src/onchain.json`. The backfill runs as the migration owner; `issuance_enabled` stays false throughout.

**Rollback overall:** revoke EXECUTE on the review RPCs and drop the enqueue trigger. Intake keeps working exactly as today, because its tables and response contract were never altered. Do not mix DB changes into a Cloudflare rollback (`release-runbook.md:38`).

## 9. Test plan

| Area | Test |
| --- | --- |
| Transitions | Every allowed edge succeeds; every other edge fails. Terminal states reject all actions. |
| Flags | With `issuance_enabled=false`, `prepared` onwards fail for every role. Payments/grader flags cannot be set true. |
| Roles/RLS | `anon`, non-staff `authenticated`, inactive staff: no reads, no writes. Reviewer cannot publish; publisher cannot approve; approver cannot prepare own review. Client-supplied actor/status ignored. |
| Concurrency | 20 sessions claim one review: exactly one wins, 19 get `STALE_VERSION` (reuse the lock-wait check in `MARK_INTAKE_V2_REVIEW.md:193-201`). |
| Idempotency | Same key + same input returns identical body. Same key + different input → `IDEMPOTENCY_CONFLICT`. |
| Intake unchanged | Duplicate claim on a reviewed cert still returns `requested` and 200, never 502. Enqueue failure rolls back the request. |
| Audit | UPDATE/DELETE/TRUNCATE on events fail. Chain recompute passes; one edited row (as owner) is detected. |
| Backfill | 18 rows; tx and digests match receipt files; rerun is a no-op. |
| Handler | 401/403/404 → 503 `INTAKE_MISCONFIGURED`; timeout + successful retry → 200 `existing:true`; double failure → 502. |
| Guardrails | Existing tests for `PSA cert ref`, `PAYMENTS_AVAILABLE = false`, and `scripts/mark-review/readiness.mjs` still pass. Fix known drift in `tests/mark-operations.test.mjs:31-39` (expects 502 without `MARK_INTAKE_GATE`) honestly. |

## Open questions for Matthew

1. Can the database owner send a redacted list of what is actually installed (intake tables, functions and who may call them)? That confirms whether the 502s come from the permission or token mismatch described above.
2. Must the person who approves a Mark be different from the person who publishes it?
3. When a Mark is revoked, should it simply stop being republished each month, so it expires after 30 days, and be labelled revoked on the site?
4. Who should be the first reviewers and admins, and should they need two-factor sign-in?
5. The first six Marks have no saved receipt file, only transaction hashes. Is it acceptable to record them as "published, receipt not re-checked" until a read-only chain check is approved?
