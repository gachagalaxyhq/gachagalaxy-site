# Phase7 — controlled Mark request review readiness

Inspection: 2026-11-08. Scope: local working tree, not deployed state. No secrets,
live database, real requests, chain access, wallet, signing, payments, deployment,
commit, or push. Existing files were inspected read-only. Only this plan and
`scripts/mark-review/` are added. No phase7 specification file was found in the
inspected source; this plan uses the user's review/status scope, not a guessed
pre-existing workflow.

## Judgment

**Intake is not a review workflow. Phase7 cannot be enabled from this source by
configuration alone.** No backend endpoint was changed or added. The new tools
need no migration because they only read local source and run synthetic tests;
there is no phase7 runtime backend change here for the parent to deploy.

The parent's existing intake backend may be compatible without an additional
migration ONLY if its exact v2 tables, function overloads, policy, grants and
server bindings already exist and have been independently approved/verified.
That is unknown here. Do not deploy candidate SQL or infer live readiness from
this report. A persistent review workflow needs an explicitly approved schema
and authorization design, plus a coordinated claim-response contract change.

## Existing, grounded contracts

| Area | Local source evidence | Actual contract / limitation |
| --- | --- | --- |
| Intake gate | `functions/api/mark-request.js:3,56-75,130` | Source `INTAKE_AVAILABLE=true`; factory default remains false. Source comment claims owner approval and exhausted allowance, but live policy/balance was not checked. Older review notes asserting source false are stale. |
| Request row | `supabase/migrations/20261107_mark_intake_v2.sql:21-31` | `id uuid`, `grader` PSA/CGC, canonical `cert`, normalized `email`, `status`, `free`, `created_at`; unique `(grader,cert)`. **Only `status='requested'` is valid.** Contact candidate drops email NOT NULL. |
| Policy | Same migration, lines 8-19 | Singleton; `approved`, `legacy_reconciled`, `scope` global, `free_limit=10`, `used`, `approval_reference`. Starts closed with unknown usage. No per-person entitlement. |
| Claim | Same migration, lines 38-71; handler lines 104-113 | Locked allocation/dedupe; duplicate retains original contact and free decision, returns UUID and `requested`. HTTP only accepts exact `requested`. No reviewer/approval/fulfilment action. |
| Public aggregate | Handler lines 116-125; SQL lines 74-84 | GET returns availability, supported graders, global allowance, inactive payment and unchecked evidence. **Not a request-status service.** No request ID/cert parameter is used. |
| Contact operations | `20261107_mark_contact_ops.sql` | Private owner-only read/erase, reference and session-user audit; erase retains status/identity/free and does not refund. Not a review queue or operator-role implementation. Audit does not cover direct owner reads. |
| Public Mark read | `20261026_a5_public_marks.sql`; `functions/verify/[grader]/[cert].js:44-57` | `marks` and `mark_events`, visible-row read policies; share route reads `marks`, not requests. Published certificate lookup is separate from private intake. Public table currently permits PSA only, unlike PSA/CGC intake. |
| Payments | `functions/api/stripe-webhook.js:3,31-34` | Source hard-disabled. Dormant code targets legacy `mark_requests` payment fields, NOT v2 UUID requests; it is not a review mechanism. Do not activate it. |

No checked-in definition for the legacy `mark_requests` table or `claim_mark`
was found among the four migrations. Dormant client calls do not establish its
actual columns, status values, triggers, grants, or contents. In particular,
`pending` mentioned in historical review notes is not a current v2 status.

## Signing and publication are separate, not review-enforced

- `scripts/build_mark_signing_handoff.py` packages a fixed six-record batch into
  `operations/mark-signing.html`; there is no `scripts/mark-signing-handoff/`
  directory. The template validates allowlisted identities/calldata, fixed
  testnet/registry/attester, role and code, per-card checkbox, simulation, gas
  estimate, explicit confirmation, and injected wallet approval. It checks
  transaction/receipt/event/block correspondence. It does not query the intake
  row or require a persisted review decision. A checked checkbox is not an
  authenticated, durable review audit. No signing code was executed here.
- `scripts/index_issued_six.py` and `scripts/index_marks_to_18.py` check local
  preparation digests and receipt journals, then update local indexes and a
  publication handoff. They are not DB importers. Their assertions do not replace
  independent chain verification. They were not executed here.
- Public `marks.visible` defaults true; public reads are filtered by that flag.
  There is no request-to-review-to-event relationship in the shown SQL. Do not
  insert an unissued Mark as a way to expose progress: it could become public.
  No generic authenticated publication writer was located in the inspected
  backend/scripts; a preparation comment referring to one is not proof it exists.
- **Independent signing path:** `.github/workflows/republish-marks.yml` schedules
  `scripts/republish_marks.mjs`, which loads an encrypted wallet from environment
  bindings and calls `publish` for existing identities. It has no review-queue
  gate. Its enabled/live configuration is unknown. Do not run it. A manual UI
  review gate would not govern this path; owner review must account for it.

## Privacy boundary

Keep the queue, contact data, existence of private requests, decisions, reviewer
identities, and reasons internal. Do not add `GET ?id=…`, cert-status lookup,
public table grants, or a service-role-backed queue endpoint. A UUID is not an
authorization decision: current duplicate claim handling can return the same
UUID for a cert submitted with a different email. Intake email is unverified.
The `existing`/UUID response is already an existence signal to a submitting
caller; the tests record this limitation rather than claim full intake privacy.

The existing aggregate GET is the smallest already-grounded public status
mechanism. It deliberately exposes no per-request status and can remain that
way. Public Mark pages must remain about already-public publication records,
not private request progress. If requester-specific progress is required later,
the owner must approve an authenticated ownership or separate access-capability
design, recovery/revocation, abuse controls and disclosure policy. No new token,
security policy, endpoint, or schema choice is approved or implemented here.

## Precise missing schema / configuration / decisions

1. **Evidence first:** owner-supplied redacted deployed DDL, constraints, policies,
   RPC signatures/owners/effective grants, exposed schemas and legacy mapping;
   historical usage/reconciliation and approvals. Repository SQL is candidate
   evidence, not proof of application. No live DB connection is requested here.
2. **Review persistence:** approve whether review is separate from immutable
   intake status or extends it; exact allowed states/transitions, actor identity,
   authorization, reason/reference handling, timestamps, durable audit, concurrent
   decision/version checks, retries/idempotency and retention. These fields/RPCs
   are absent. No speculative workflow enum was added.
3. **Coordinated duplicate contract:** extending request status requires changing
   both SQL constraint and handler's exact-status validation; otherwise a committed
   non-requested duplicate becomes HTTP 502 `REQUEST_UNCONFIRMED`. A separate
   review store avoids that specific change but still requires approved schema
   and linking rules; this plan does not choose between them.
4. **Internal access:** approve operator identity/role, private list/detail/update
   operations and audit boundaries. Existing contact functions alone do not
   supply them. Never use enumerable IDs or certificates as public authorization.
5. **Current intake bindings:** handler requires server-only `MARK_INTAKE_API_KEY`,
   `MARK_INTAKE_RPC_TOKEN`, **and `MARK_INTAKE_GATE`**. No values were read. The
   tokenized four-argument claim / one-argument status overloads are defined only
   in `20261107_mark_intake_gate.sql`; their EXECUTE grant is to `anon`, while the
   base overloads are granted to `mark_intake_rpc`. A bearer actually switching to
   `mark_intake_rpc` is not granted the wrapper by this SQL. Resolve the actual
   intended identity/grants with the owner; do not broaden grants automatically.
   The gate candidate initializes a known local-test fixture digest, not an
   acceptable production credential. Trusted provisioning/rotation and gateway
   verification remain required. Filename sorting would also place gate/contact
   candidates before their v2 dependency; do not blindly apply the directory.
6. **Execution enforcement:** approved review-to-specific-preparation digest and
   identity link; authorized signing handoff; stale/rejected decision handling;
   independently verified receipt and finality policy; explicit publication
   writer authorization/idempotency and request-to-event linkage. None is wired
   to intake. Account for monthly republishing separately. No payment activation
   or transaction permission follows from review approval.

## Safe local implementation and verification

Added `scripts/mark-review/readiness.mjs`: reads only eight fixed source paths,
prints booleans and fixed blocker codes, never reads environment bindings or
request records. Narrow textual drift checks are **not** a parser or security
audit. `sourceContractMatches=true` means the inspected local limitations still
match the guard, not that phase7 is safe. `phase7Ready` and deployment authorization
always remain false. No input manifest, DB URL, apply mode, SQL or network exists.

```sh
node --test scripts/mark-review/readiness.test.mjs
node scripts/mark-review/readiness.mjs --check
```

Exit codes for the readiness CLI: **2** = expected phase7 blockers, **1** = source
drift/missing source/invalid invocation. There is intentionally no ready/launch
exit code. Test runner uses its normal zero/nonzero convention.

Tests exercise actual handler code with only synthetic in-memory requests and
injected RPC responses, fail unexpected default network access, test exact
public GET/POST response allowlists, ignore enumerable GET queries, strip extra
contact/review fields, reject non-requested statuses, document duplicate UUID
behavior, test missing bindings, payment gate and source drift. They do not prove
deployed schema, actual dedupe/contact persistence, SQL grants, or chain state.

Existing test maintenance is separate: `tests/mark-operations.test.mjs` builds a
synthetic environment without `MARK_INTAKE_GATE`, so its RPC-error test expects
502 where current handler will return 503 before transport. Existing static
tests also still assert `INTAKE_AVAILABLE=false`. They were not edited to hide
this drift. The broad suite was not used as evidence of phase7 readiness.

Executed verification in this pass:

- New offline suite: **9 passed, 0 failed, 0 skipped**.
- Readiness CLI: **exit 2**, source contract matched; phase7/deployment stayed
  false. This is the expected blocked result, not a successful readiness verdict.
- `node --check` passed for both new JavaScript files; `git diff --check` passed.
- Targeted existing test: `node --test --test-name-pattern='RPC headers'
  tests/mark-operations.test.mjs` reproduced **1 failure**, `503 !== 502`, at
  line 36, consistent with its missing gate binding. No existing test was edited.
- Repository-wide diff/untracked-list fingerprints changed while this task ran;
  additional frontend/build/workflow/test changes were observed. This task made
  no edits to those paths and did not revert them. The whole working tree cannot
  be attested unchanged in a shared workspace; only this task's three added files
  are its implementation scope.

## Parent handoff

1. Run the two offline commands above. Expected CLI result is blocked readiness,
   not an invitation to apply migrations.
2. Obtain redacted schema/grant evidence and explicit review/access/publication
   decisions before asking for a persistent queue implementation. Preserve
   `requested` intake semantics, private contacts and inactive payments meanwhile.

No runtime backend change from this increment is deployable because none was
made. Shipping only these local checks/docs needs no database migration and
does not enable a review queue. Existing intake deployment compatibility remains
conditional and unverified, not a blanket migration-free approval.
