# Controlled platform releases

## Current baseline

- Last good production deployment: **0c2ba2bd**
- Full deployment ID: `0c2ba2bd-de84-4fae-930c-eefac10738b6`
- URL: https://0c2ba2bd.gachagalaxy-site.pages.dev
- Scanner data timestamp: 9 November 2026, 14:11 UTC.
- Clean Check index timestamp: 6 November 2026. This is a separate saved dataset;
  a scanner update must never relabel the index as fresh.
- Git-triggered production and preview deployments are disabled. Keep them disabled
  until source synchronization and release review have been explicitly approved.

## Prepare and release

1. Review source/data diffs and preserve all 18 Marks, existing auth and approved UI.
2. Refresh only authorized data. Inspect coverage, timestamps and provenance; never
   overwrite an evidence date merely because another dataset was refreshed.
3. Run focused tests and `python3 scripts/safe_build.py --output /absolute/new-candidate`.
4. Review candidate UI at desktop and mobile sizes. Check homepage stats and dates.
5. Only with deployment approval, run from the repository:
   `python3 scripts/release_platform.py --candidate /absolute/new-candidate --upstream`.
   The release script uses the repo root as cwd so Functions are included.
6. Verify custom-domain JSON contracts, a nonempty `cards` array, inactive payments,
   saved Mark verification, all 18 Marks, homepage counters and dataset dates.
7. Record the resulting full deployment ID. Do not mark a release good solely
   because static pages return HTTP 200.

## Rollback

If a release breaks production, use Cloudflare Dashboard → Workers & Pages →
`gachagalaxy-site` → Deployments. Select the last good deployment **0c2ba2bd**
(`0c2ba2bd-de84-4fae-930c-eefac10738b6`) and use **Rollback to this deployment**.
Confirm the target carefully; do not rebuild stale `main` as a rollback substitute.

After rollback run `python3 scripts/release_platform.py --verify-only --upstream`,
then check `/verify/psa/109308847`, homepage counters and scanner/evidence dates.
Keep payments/issuance off. No Phase 7 status or database changes belong in rollback.

## Branch-only handover, 9 November

`release/live-9-nov` preserves the deployed assets and their source dependencies.
Its Clean Check index-date display is a **next-release change**, not deployed.
Do not merge or deploy this branch without separate approval. Marketplace code is
offline-adapter work, not new production feeds. No credentials belong in Git.
