# Mark intake v2 — local candidate, not deployment approval

## Evidence and root cause

The only previously checked-in migration defines public marks/events, not intake.
The previous handler called an undocumented `claim_mark(p_cert,p_reason,p_limit)`
and then looked up an ID by `psa_cert`. Grader identity was not part of that RPC.
The uncommitted collector safety work closed acceptance, CGC and payments.

History `c5f9adf` establishes the **client's global counter**: ten minus all rows
where `free=true`, with no person/email filter. It does not prove the deployed
RPC's allocation rules or current balance. The existing certificate page explicitly
does not promise ten per person. No credentials or deployed schema were read.

### Local evidence reconciliation (2026-11-07)

| Evidence inspected | Establishes | Does NOT establish |
| --- | --- | --- |
| `043e5e1:functions/api/mark-request.js` | Earlier client submitted `psa_cert`, `status='pending'`, grader/email in reason text; no verified user identifier | Actual table definitions, actual stored contacts/counts, authoritative entitlement |
| `920d67e`, `7540ce3`, and `c5f9adf` handler history | Client moved from cert lookup to `claim_mark`; `c5f9adf` sends `p_limit=10` and subtracts the unfiltered `free=true` row count | Server RPC rules, correct historical usage, a ten-per-user allowance |
| `d8ffd7b` / current handler diff | Legacy ID lookup was cert-only after RPC; payment-link behavior existed in the client | Safe grader mapping, confirmed payment or fulfilment, approved gateway grants |
| Tracked migrations and current candidate SQL | Checked-in legacy migration covers public marks/events; isolated v2 starts unapproved with `used=NULL` | Complete deployed intake schema or any verified historical consumption total |
| Current uncommitted service copy and safety tests | Public intake and payment are intentionally unavailable; eligibility is not_checked | Policy-owner approval; current copy is not independent historical evidence |

Repository history was inspected locally with scoped `git log`, `git show`, and
the surviving diff; README contains site/build guidance and no extra intake test
recipe. No AGENTS.md/CLAUDE.md was found in this repository. No contact exports,
credential files, remote history fetch, or live database were read. **Verified
historical usage remains unknown, not zero. Global is a candidate interpretation
of client behavior only; per-user ten is neither implemented nor established.**

## What is implemented

- New isolated private schema; legacy `mark_requests`, `claim_mark`, existing
  marks, contacts and entitlements are not modified or reinterpreted.
- Candidate identity is `(grader, canonical cert)`, matching cert-scoped request
  deduplication in repository history, now separated for PSA and CGC.
- One locked policy row serializes duplicate lookup, insertion and allowance
  allocation. Unique identity is an additional constraint. Return the ID inside
  that same transaction; no follow-up table lookup. Same identity retries keep
  the original contact and free decision; email is never returned.
- Candidate global ten-free semantics are implemented but **not approved**.
  `used` starts NULL, not zero; approval and legacy reconciliation start false.
  No amount of handler environment configuration opens production acceptance.
- HTTP validation, bounded streamed body, timeout, strict response validation,
  generic uncertain-result errors and no service-role fallback.
- `mark_intake_rpc` NOLOGIN/NOBYPASSRLS role, granted only these v2 RPCs by this migration; private tables have RLS
  with no client policies and no table grants. Only the owner-backed SECURITY
  DEFINER functions may access them; their search paths are fixed.
- No checkout, payments, Mark issuance, grader API calls or fulfilment promises.

## Approval and application steps still required — do not execute automatically

1. DB owner supplies a redacted schema/policy review of existing `mark_requests`,
   `claim_mark`, related triggers/constraints/grants and current entitlement usage.
   This is not an instruction to read keys. Inspect actual definitions, not client
   calls. Confirm whether the historical global counter is authoritative. If the
   backend instead grants per-person allowances, stop: that needs verified user
   identity and a different contract, not email-based invented quotas.
2. Approve cert-scoped deduplication and contact behavior: first contact remains;
   another email does not claim ownership, replace contact or create a new slot.
   Requests express interest only. Rate limiting/abuse controls and private
   contact retention/access policy also need operator review before public use.
3. Apply the candidate migration first to an approved isolated/staging PostgreSQL.
   It intentionally fails on conflicting schema/role names rather than accepting
   unknown definitions with IF NOT EXISTS. Review owner of SECURITY DEFINER
   functions; use a trusted migration owner, not a publicly assignable role.
4. Design and approve a legacy import against the actual schema. Preserve IDs in
   an explicit mapping, original contact/status/free decisions and consumption;
   resolve duplicate or ambiguous grader identities explicitly. The candidate
   table accepts only `requested`: do not relabel fulfilled/rejected legacy rows
   as requested. Their status retention/mapping needs an explicit extension or
   continued legacy storage before cutover. Import into v2 only after review.
    The offline dry-run planner below validates an explicit normalized mapping;
    it is not an automatic import or an adapter to the unknown legacy schema.
    Do not reset the allowance to ten or reallocate existing decisions.
   Coordinate a legacy write freeze/cutover so old intake cannot consume slots
   outside the v2 lock. Review and close old write/RPC grants explicitly.
5. Only after reconciliation set the approved scope, historical used total,
   reconciliation flag and auditable approval reference. Keep acceptance closed
   until this is approved. This migration does not set these values.
6. Provision a short-lived/rotatable server credential scoped to `mark_intake_rpc`
   through the approved gateway/authenticator setup. Supply server-only
   `MARK_INTAKE_RPC_TOKEN` and gateway `MARK_INTAKE_API_KEY`; never the service
   key as fallback. Neither key is embedded or logged. Verify PostgREST role
   switching and exposed function access in staging. Audit inherited PUBLIC
   grants on all existing RPCs: a new NOINHERIT role still has PUBLIC privileges,
   so the isolated tests do not prove its effective privileges in the live DB.
7. Repeat the independent-session PostgreSQL concurrency, permissions, rollback
    and retry checks in approved staging, then exercise the real gateway. The
    disposable local PostgreSQL tests now prove actual local lock contention;
    PGlite still serializes on one embedded connection. Neither proves the live
    gateway, deployed grants, deployed schema, or historical reconciliation.
8. Obtain explicit approval to change the source acceptance gate, then deploy
   intentionally. The client now follows the validated handler availability
   response; there is no second client switch to edit. The exported handler
   remains source-gated off; do not claim the service is live. Payments
   require a separate review and remain hard-disabled.

## Application integration and activation configuration — current local build

The original `/check?cert=…&grader=…#request` route now implements the real new
request journey. The contact email field is restored. GET `/api/mark-request`
controls availability and the configured allowance display. POST sends only
`cert`, `grader`, `email`; success displays the transactional request UUID and
`requested` status. Pending blocks repeat submits, duplicates retain the original
contact/allocation, and uncertain transport outcomes retain input for same-identity
retry. A nonfree request is saved without checkout or paid processing. Neither
success nor a complimentary allocation claims issuance, payment or fulfilment.

**No deployment or activation is approved by this build.** The minimal operator
handoff is an explicitly approved deployment/cutover with these existing inputs:

| Location | Exact required configuration |
| --- | --- |
| Pages project | Serve `public`; deploy `functions/api/mark-request.js` with it (static-only hosting cannot supply the handler). Existing route and design are unchanged. |
| Database | Apply `20261107_mark_intake_v2.sql` then `20261107_mark_contact_ops.sql` only after approval; reconcile actual history without resetting usage. |
| Policy row | Explicit verified `scope`, `used`, `legacy_reconciled`, `approval_reference`, and `approved`; currently scope/usage unknown and approval false. Candidate supports global ten only: if rejected, do not activate it or substitute per-user ten. |
| Server-only secrets | Provision `MARK_INTAKE_API_KEY` (gateway key) and `MARK_INTAKE_RPC_TOKEN` (scoped `mark_intake_rpc` bearer). Never use a service-role fallback or put these in HTML. |
| Gateway | Existing `SB` URL in the handler must be the approved target; expose the two public RPCs and authorize role switching for the scoped identity. Confirm effective existing PUBLIC privileges. No gateway configuration or credentials were read here. |
| Last source gate | Only after explicit approval and a real gateway rehearsal, change `INTAKE_AVAILABLE` from `false` to `true` and deploy deliberately. No environment variable can bypass this gate. Client enables itself only after valid GET availability. |
| Payments | Leave `PAYMENTS_AVAILABLE = false`; no payment configuration is needed for request intake. |

Local end-to-end validation executes the actual page intake script, actual handler
and actual migration/RPCs as `mark_intake_rpc` against a disposable PostgreSQL
cluster. Only the gateway transport is adapted to SQL; successes are not mocked.
It does not establish deployed PostgREST/authenticator or live readiness.

Verified for this integration increment (2026-11-07):

- Full JavaScript regression run: 141 tests, 140 passed, 1 existing live-chain
  skip, zero failures. Two prior static assertions forbidding any intake fetch
  or contact email were updated to require handler-gated submission and no
  checkout creation; the production handler/payment gate tests remain intact.
- Disposable PostgreSQL 16.15: 13 passed, zero failures/skips. Three application
  tests execute the real intake page script, handler and scoped SQL functions:
  pending/double-submit, new/duplicate/nonfree, grader separation, input errors,
  SQL failure rollback/retry, lost-response retry, default source gate and
  revocation between GET and POST. Existing concurrency/contact tests also pass.
- `git diff --check` passed. No routes, CSS/design, unrelated application files,
  production policy values, source approval gate or payment gate were changed.
- No deployment, live DB writes, secret reads, paid calls, commits or pushes.

## Local isolated regression command

Install `@electric-sql/pglite@0.5.15` in a scratch directory outside this repository
(no PostgreSQL server installation needed), then run:

```sh
MARK_TEST_PGLITE=/absolute/scratch/node_modules/@electric-sql/pglite/dist/index.js node --test tests/mark-intake-v2.test.mjs
NODE_PATH=/absolute/scratch/node_modules MARK_TEST_PGLITE=/absolute/scratch/node_modules/@electric-sql/pglite/dist/index.js node --test tests/*.test.mjs
MARK_TEST_POSTGRES_BIN=/usr/lib/postgresql/16/bin node --test tests/mark-intake-postgres.mjs
```

The v2 test requires an explicit engine path and uses synthetic contacts only.
It creates a fresh in-memory database, applies the actual candidate SQL there,
and never calls the network. It does not apply any schema to a live database.

The full suite also needs `jspdf` from a scratch dependency tree. The PostgreSQL
suite is deliberately separate from the `*.test.mjs` glob and opt-in. It accepts
only a server binary directory, **no DB URL**. It creates its own temporary
cluster, binds only a private Unix socket (TCP disabled), passes a minimal
environment without PG connection settings, uses synthetic contacts, and stops
and removes its cluster at the end. It never targets an existing PostgreSQL
server. Requires a non-root OS user and installed PostgreSQL server binaries.

## Executed local results — 2026-11-07

Changes this pass: expanded `tests/mark-intake-v2.test.mjs`, added
`tests/mark-intake-postgres.mjs`, and updated this review. No handler, migration,
public page, payment, borrowing, or unrelated existing changes were modified.

| Check | Exact result |
| --- | --- |
| Initial full JS run without scratch NODE_PATH | 118 passed, 2 failed test-file loads (`MODULE_NOT_FOUND: jspdf`), 1 skipped; all original seven intake SQL tests passed |
| Full JS rerun using surviving scratch dependencies | **133 tests: 132 passed, 0 failed, 1 skipped** (the live-chain read test) |
| Expanded real PostgreSQL 16.15 suite | **9 tests: 9 passed, 0 failed, 0 skipped** |
| Whitespace validation | `git diff --check` passed |

The full JS run used:

```sh
NODE_PATH=/tmp/opencode/mark-review-isolated/node_modules MARK_TEST_PGLITE=/tmp/opencode/mark-intake-test-deps/node_modules/@electric-sql/pglite/dist/index.js node --test tests/*.test.mjs
MARK_TEST_POSTGRES_BIN=/usr/lib/postgresql/16/bin node --test tests/mark-intake-postgres.mjs
```

JS total includes ten intake tests (seven database-backed plus three new HTTP
safety tests). New checks use throwing credential proxies/transport spies to
verify the public GET/POST and payment gate never read credentials or call the
network; reject malformed RPC contracts and missing scoped credentials; reject
false content-length, oversized streams, invalid UTF-8 and broken body streams.

Independent PostgreSQL checks observed distinct backends waiting with
`pg_stat_activity.wait_event_type='Lock'` before releasing the holder:

- 20 independent sessions, synthetic `used=9`: exactly one free, nineteen
  nonfree, twenty distinct IDs; final used=10.
- 12 duplicate sessions, synthetic `used=8`: one new request/ID/allocation;
  retries preserve the first committed contact; CGC same digits is separate.
- Explicit transaction rollback frees the allocation for a blocked retry;
  counter-update exception rolls back both insertion and consumption.
- Approval revoked by the lock holder causes the waiting claim to fail closed.
- Unknown/partial approval and absent singleton reject claims; isolated role
  permissions, RLS, fixed SECURITY DEFINER search paths, invalid direct RPC
  fields, and fail-on-conflict migration behavior pass.
- A harmless synthetic PUBLIC function **is callable by the NOINHERIT scoped
  role until PUBLIC EXECUTE is revoked**. This directly demonstrates the
  outstanding existing-RPC grant audit; it is not a privilege finding about the
  unseen live database.

Tool setup notes: server binaries were initially absent. PostgreSQL 15 package
installation failed (`Unable to locate package postgresql-15`); package discovery
identified 16, which was installed. Package setup created an unused default local
cluster and service startup was denied by sandbox policy. Tests used only their
separate disposable socket-only cluster, successfully stopped/removed afterward.
No repository dependency files were changed.

## Readiness judgment and exact external blockers

**Local rehearsal passed. NOT ready for public intake, deployment approval, or
an assertion that live staging works.** The unknowns remain deliberately closed:

1. **Policy approval:** authoritative scope (global vs verified-user entitlement),
   dedupe/contact rules, and approval reference are absent. Email is not verified
   user identity. No new allowance policy was invented.
2. **Historical reconciliation:** actual legacy schema/RPC/triggers/grants,
   historical used total and existing free/nonfree decisions are unavailable.
   Need owner-provided redacted evidence plus approved ID/grader/status mapping,
   import plan and legacy write freeze. Never seed used=0 from these fixtures.
3. **Credentials/gateway:** no scoped identity issuance, authenticator membership,
   token rotation, PostgREST exposure/role-switch test, existing PUBLIC grant
   audit, or approved staging endpoint check has been performed. No secrets read.
4. **Public-operation approval:** rate limiting/abuse control, contact retention
   and access policy, plus separate intentional source/client-gate activation
   are still required. These tests do not implement fulfilment/Mark issuance.
5. **Payments:** separately unapproved and hard-disabled. Timestamp/replay,
   expected amount/currency and event-idempotency review remain outside this
   intake-only pass. No checkout or payment writes were enabled.

No deployment, commit, push, live DB change, fund movement, paid upstream call,
credential/secret read or borrowing edit was performed. Existing public intake
and payment gates remain false. Test fixture approval is not operator approval.

## Additional local implementation — bounded operations and cutover planning

- HTTP handling now has an absolute five-second request-body deadline and a
  separate five-second RPC deadline covering both headers and response body.
  Both JSON streams have 4096-byte/256-read bounds. Cancellation is best-effort
  and never awaited; stalled transport/cancellation cannot extend the deadline.
  This is resource bounding, **not** an approved rate limiter or anti-bot policy.
- `20261107_mark_contact_ops.sql` is an unapplied candidate after intake v2.
  It adds owner-only SECURITY INVOKER contact read/erase operations and a private
  audit trail without contact values. No operator role, scheduled retention
  period, new RPC exposure or grants are supplied. A trusted owner must commit
  a read transaction for its audit to persist; this does not audit direct owner
  table reads or protect against a malicious DB owner. References must be
  nonpersonal operator ticket IDs, not email/contact text.
- Erasure requires 1–100 explicit unique IDs, an explicit past creation cutoff,
  and an operator reference. Selection mismatch rolls back the entire operation.
  It nulls contact only, retaining ID/grader/cert/status/free/used. Duplicate
  claims never refill erased contacts or refund allowance. Access grants and
  retention/deletion decisions still require owner approval.
- `node scripts/mark-cutover.mjs --dry-run <redacted-manifest.json>` performs
  **offline validation only**. No apply mode, SQL execution, DB URL, credentials,
  network or activation exists. Exit 1 = invalid; 2 = valid but missing readiness
  evidence; 0 = complete owner assertions, **not** verified staging or launch
  authorization. Output omits IDs/certs/mapping; input is size-bounded and cannot
  be a symlink. Only a normalized redacted manifest is accepted; never feed it
  raw contact exports or secret configuration.

Manifest contract (all keys required; unknown fields rejected):

```text
contract: "mark-legacy-reconciliation-v1"
snapshot: {reference: ticket ID, sha256: export digest, complete: true, rowCount: integer}
historicalUsed: explicit verified integer (NULL/absent is NEVER zero)
usageReference: evidence ticket ID
records: [{legacyId, targetId, grader, cert, status, free, disposition, reference}]
approvals: {schemaReview, policy, identityContactRules, legacyWriteFreeze,
  legacyGrantClosure, contactOperations, abuseControls, gatewayPrivileges,
  stagingRehearsal} // each null or nonpersonal evidence ticket ID
```

`grader`/`cert` must already be explicitly resolved/canonical; `free` is the
original boolean, never recomputed. `historicalUsed` must cover all preserved
free rows but is not inferred from their count. `import-requested` requires
status `requested` and a unique explicit target UUID. `retain-legacy` preserves
the original status and requires targetId null. Duplicate IDs or cert identities
fail closed instead of selecting a contact/decision. Retained identities always
block cutover: current v2 has no approved tombstone/exclusion mapping, so merely
leaving fulfilled/rejected records in legacy storage could permit new allocation.
Snapshot digest and approval references are owner assertions, not independently
authenticated by this offline tool. No production mapping or history was read.

Checks run for this increment:

- Intake v2 plus initial operations tests: **17 passed**, no skips/failures.
- Final operations tests including CLI subprocess behavior: **8 passed**.
- New contact test only on disposable socket-only PostgreSQL 16.15: **1 passed**.
  Its initial run found a fixture TRUNCATE/FK conflict; reset was moved before
  the migration and the rerun passed. The existing nine PostgreSQL tests and
  unrelated full JS suite were not rerun unchanged.
- `git diff --check` passed.

Existing Mark display is separate from new intake and was not changed. A paid-only
intake would still need approved contact/dedupe/abuse/payment contracts; it does
not authorize bypassing unresolved history, and payments remain disabled.
Next safe local work: a synthetic, owner-reviewed import application rehearsal
bound to the dry-run digest and exact target preconditions; no real import can
be designed against a guessed legacy schema. This increment intentionally stops
at a validated mapping plan, not a claim that migration/import/cutover is ready.

## Synthetic transactional import rehearsal — next local increment

`scripts/mark-import-rehearsal.mjs --synthetic --postgres-bin /usr/lib/postgresql/16/bin`
creates and removes its own socket-only PostgreSQL cluster. It accepts no input
manifest path, DB URL, credential or apply mode. The transaction compiler accepts
only the built-in synthetic fixtures after the existing planner validates them.
It does not adapt the unknown legacy schema or import real contacts/history.

- JS and PostgreSQL both verify the validated manifest SHA-256. An exclusive
  table lock precedes exact jsonb comparison of policy, all request rows, contact
  audit rows and rehearsal receipts. Locks cover absent rows as well as existing
  rows; an old precondition fails even on replay. This is a data-state
  precondition on the known disposable schema, not live schema attestation.
- Initial application requires an empty target and closed, unreconciled policy
  with unknown usage. The synthetic historical total is copied explicitly (14,
  not inferred from one free row or clamped to ten). IDs/status/free decisions
  and manifest mapping are retained atomically with the private receipt.
- Fixture contacts are reserved `.invalid` addresses; creation time is explicitly
  synthetic. Neither represents a real legacy contact or historical timestamp.
  No allowance allocation, reconciliation approval, gate or payment activation
  occurs. Receipt storage exists only inside the disposable harness, not in a
  deployable migration. Replay checks the committed rows against the receipt,
  and fails on drift rather than repairing or reallocating decisions.
- Retained legacy statuses still fail closed with the existing approved-exclusion
  blocker. No exclusion policy, production tombstone table or RPC change was
  invented. Fake approval references in fixtures are not owner authorization.

New tests: `MARK_TEST_POSTGRES_BIN=/usr/lib/postgresql/16/bin node --test tests/mark-import-postgres.mjs`.
They exercise late receipt-trigger failure after request/counter writes (atomic
rollback), exact replay, digest mismatch at both boundaries, stale snapshots,
nonempty/known-usage targets, independent free/contact/usage drift, missing policy,
open-policy refusal, receipt permissions, concurrent same-precondition attempts,
exclusion refusal and the real CLI. These are local synthetic checks only, not
staging, gateway, deployment, owner-policy or live-history verification.

Executed this increment: **9 tests passed, 0 failed, 0 skipped** on disposable
local PostgreSQL; `git diff --check` passed. The first run exposed a PL/pgSQL
alias/variable collision; it was corrected and the final expanded suite passed.
The unrelated existing suites were not rerun as a substitute for this work.

**Single smallest next owner decision:** approve or reject a candidate retained-
identity rule: keep the original legacy row/status/free decision authoritative,
block any new intake/allocation for that exact `(grader, canonical cert)` identity,
and do not synthesize a requested row or refund usage. Recommended safe option is
blocking, not relabeling or dropping the identity. A nonpersonal decision record
needs exactly `decisionReference`, `identityKey` (grader + canonical cert),
`retainedDisposition` (retain original legacy row/status/free),
`newIntakeAction` (block without allocation), and `usageAction` (no refund).
This asks for an owner decision on the rule, not real certificate/contact values
or authorization to apply an import. Until approved, exclusion manifests remain
rejected. Actual redacted schema/history evidence is still needed before any
real importer can be designed; this one decision does not establish readiness.
