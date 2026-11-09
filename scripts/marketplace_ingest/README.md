# Marketplace ingestion — bounded local foundation, not live feeds

Research date: 2026-11-08. Python standard library only. No frontend, build,
catalogue, CC dataset, credentials, remote writes, deployment or git operations
are part of this implementation. CC remains the existing saved dataset.

## What is implemented

Four **offline schema adapters**: eBay Browse, DYLI Read listings, Phygitals
marketplace listings, and OpenSea listing orders. All seven requested venues
appear in the evidence/status registry. Courtyard, Beezie and Renaiss have no
invented schema or endpoint; attempting to ingest them fails explicitly.

`python3 -B -m scripts.marketplace_ingest status` prints every venue's official
domain, access/key requirements, licensing caveats, evidence URLs and outcome.

Request planning is offline and bounded to one page / at most 20 requested rows:

```sh
python3 -B -m scripts.marketplace_ingest plan ebay --query 'Pokemon' --limit 1
python3 -B -m scripts.marketplace_ingest plan dyli --limit 1
python3 -B -m scripts.marketplace_ingest plan phygitals --limit 1
python3 -B -m scripts.marketplace_ingest plan opensea --collection tiny-dinos-eth --limit 1
```

These commands print URLs, not tokens, and never execute keyed requests. The CLI
does not read environment variables, token stores, dotenv files or credentials.
Supply only an authorized **response-body** capture, never headers or an HTTP
archive. No credentials were sought or accessed during this work.

```sh
python3 -B -m scripts.marketplace_ingest normalize dyli \
  --input authorized-response.json --rows-pointer /items \
  --source-url https://www.dyli.io/api/public/v1/listings \
  --observed-at 2026-11-08T00:00:00Z
```

`/items` above is an **example user-selected capture location, not a claim that
DYLI's listings envelope uses that key**. For a bare row array use
`--rows-pointer ''`. eBay defaults to `/itemSummaries`, OpenSea to `/listings`.
Unknown envelopes fail, rather than producing a misleading empty success.
Source URLs must use the documented API host and omit queries, fragments and
credentials. The raw body retains response fields; only use credential-free
public listing captures. Known credential-bearing field names are rejected as
defense in depth, not a guarantee that arbitrary input contains no secret.

There is a one-request Phygitals transport:

```sh
python3 -B -m scripts.marketplace_ingest fetch-public phygitals \
  --permission-confirmed --limit 1
```

**Do not use this until permission/licensing is resolved.** This explicit flag is
an operator acknowledgement, not a grant of rights. The documented host returned
HTTP 404 in validation. No guessed alternatives were attempted. No retries,
pagination, redirects, auth, challenge solving, HTML scraping or remote mutations
exist. Non-JSON, HTTP errors, oversized bodies and schema drift fail closed.
Returned raw transport payload is not automatically normalized: the response
envelope must first be inspected instead of guessed.

## Schema and certainty

Every record includes `venue`, `source_id`, `cert`, `grader`, `grade`, `name`,
`set`, `number`, `language`, decimal-string `ask`, `currency`, `observed_at`,
nullable `source_timestamp`, nullable `listing_url` / `image_url`, warnings, and
raw provenance with source URL, row JSON pointer and canonical JSON SHA-256.
The hash covers the decoded payload serialized canonically, **not wire bytes**.
Provenance is caller-reported, not independently authenticated origin.

- Missing fields remain JSON null; no regex/title/OCR/cert inference or matching.
  Numeric certificate inputs become strings, but lost leading zeros cannot be
  recovered; send string certs. A listing ID is never substituted with a cert.
- `verification` is always `source_reported_unverified`, even when cert exists.
- eBay: fixed-price buying option required to treat `price` as ask; auction bids
  are not asks. Explicit localized aspects can supply grading/card traits;
  search summaries may omit them. The crawler exposed only a partial Browse
  reference, so full current response/detail schemas still require an authorized
  capture and contract recheck before production use.
- DYLI: only documented listing row fields mapped. Fair Drop entry rows excluded.
  Cert retained; grader/grade/set/number/language remain null pending a separate
  documented cert/metadata enrichment adapter. No parsing of titles.
- Phygitals: explicit metadata traits only. Price in six-decimal USDC base units
  becomes USDC, not a guessed USD conversion. FMV/bids never become ask. Timestamp
  remains null because exact timestamp keys were not recovered. The `/card/:slug`
  link is constructed only from a supplied slug using the documented route.
- OpenSea: order hash identifies the listing; `price.current` scaled only with
  explicit decimals. No token metadata join or invented listing URL; cert/card
  fields and images remain null. Order price scope is retained as reported;
  bundle/per-item pricing still requires a separate explicit handling policy.
- No timestamps are fabricated as venue updates: `observed_at` is supplied by the
  capture operator; `source_timestamp` is preserved only for mapped source fields.
- At most 200 rows / 2 MB input; all-or-error normalization, duplicate IDs rejected.
  No silent truncation, cross-venue deduplication, FX conversion or live claims.

## Per-venue evidence and outcome

### eBay — offline adapter, key required

- Official domain and Browse request: https://developer.ebay.com/
- Search and detail behavior: https://developer.ebay.com/api-docs/buy/static/api-browse.html
- Application-token requirement: https://developer.ebay.com/api-docs/buy/browse/resources/item_summary/methods/search
- License: https://developer.ebay.com/join/api-license-agreement

Developer registration is free; token, eligibility and API license apply. The
license permits only authorized uses facilitating eBay services, intermediate
copies and compliant display; not a blanket data republication right. No keyed
request made and no production entitlement claimed.

### Courtyard — permission and sanctioned contract required

- Domain confirmation: https://docs.courtyard.io/courtyard
- Terms: https://docs.courtyard.io/courtyard/logistics-and-legal/user-agreements/terms-of-service

Terms sections 11 and 14 restrict commercial reuse and unauthorized automated
extraction. No sanctioned public listing contract verified. Home fetch returned
a minimal shell; that does not prove API unavailability. No adapter fabricated.

### Phygitals — documented adapter; transport unresolved

- Official public docs: https://www.phygitals.com/docs/public-api
- Host and keyless read permission: https://phygitals.mintlify.app/public-api/index
- Listing schema: https://phygitals.mintlify.app/public-api/marketplace/listings
- Facets: https://phygitals.mintlify.app/public-api/marketplace/filters
- Current terms: https://docs.phygitals.com/user-agreements/terms-of-service

Developer docs say `https://api.phygitals.com` and keyless
`GET /api/marketplace/marketplace-listings`; listing docs explicitly discuss
price-comparison tooling. General terms sections 9/10 restrict automation and
content reuse without prior consent, so commercial/recurring use needs written
clarification. Initial public-doc source access hit a Vercel 429; rendered retry
timed out, but the separate indexed developer portal was readable. One crawler
API attempt failed; one direct GET with `page=0&itemsPerPage=1&listedStatus=listed`
returned HTTP 404. No alternate endpoint loop. No successful real listing sample.

### Beezie — permission and sanctioned contract required

- Official site: https://beezie.com/
- Docs: https://docs.beezie.com/
- Marketplace: https://docs.beezie.com/our-offerings/marketplace
- Terms: https://docs.beezie.com/information/terms-of-use

Terms prohibit automatic monitoring/copying and limit content reuse. Their text
names beezie.io despite current beezie.com site; confirm scope with the venue.
No documented listing API/free tier/key policy verified. No scraper implemented.

### Renaiss — correct domain; permission required

- Official terms identifying the service: https://www.renaiss.xyz/terms

This verifies renaiss.xyz, not the earlier renaiss.art candidate. Terms section
4.6 expressly prohibit scraping/crawling/automated extraction without permission
and competing-service use; section 4.2 grants personal use. No endpoint probing or
invented adapter. API access/price/key policy remains unverified.

### DYLI — free Read API, account key required

- Official site: https://www.dyli.io/
- Complete v1.2 contract: https://www.dyli.io/docs/llms/read-api.md
- Listings: https://www.dyli.io/docs/api/listings
- Authentication: https://www.dyli.io/docs/api/authentication
- Free Read access: https://www.dyli.io/docs/getting-started/request-access

Correct domain dyli.io, not dyli.app. GET listings and cert/metadata enrichment
routes are documented. Read requires account, linked email and key; Commerce is
separate paid access and is not used. Default Read limit documented as 30/min,
subject to override. No key was accessed; no API validation. Official docs support
catalog integrations, but unrestricted image/data republication was not licensed
in the sources checked. Clarify retention and attribution before publishing.
Docs contain some inconsistent legacy Commerce scope guidance: this code targets
Read only and does not treat a Read key as Commerce authorization.

### OpenSea — offline order adapter, free-tier key documented

- Auth and attribution: https://docs.opensea.io/reference/api-overview
- Keys: https://docs.opensea.io/reference/api-keys
- Read endpoint: https://docs.opensea.io/reference/list_listings_collection_all
- Exact order-price example: https://docs.opensea.io/docs/opensea-fees
- Official CLI corroboration: https://github.com/ProjectOpenSea/opensea-cli

All REST reads require a key. Free-tier issuance is documented but uses POST;
none was created because remote writes are prohibited. Official overview requests
OpenSea linkbacks/logo attribution. No full API/data/image redistribution license
established here. No keyed request, collection mapping or metadata enrichment.

## Tests and remaining work

```sh
python3 -B -m unittest discover -s tests -p 'test_marketplace_ingest.py' -v
```

Synthetic fixtures test null-cert behavior, source ID separation, price scales,
auction/FMV handling, provenance, malformed envelopes, duplicates, input bounds,
permission gates, HTML/error/redirect refusal and single-request/no-retry behavior.
They do **not** establish live compatibility. Next integration work requires:

1. Resolve Phygitals documented-host 404 and conflicting automation/license terms
   with the venue; obtain one sanctioned current response.
2. Obtain authorized credential-free captures for eBay, DYLI and OpenSea through
   an owner-controlled client. No credentials need to be supplied to this tool.
3. Implement schema-backed metadata/cert enrichment and OpenSea per-item/bundle
   semantics; confirm display/retention/image rights and venue mappings.
4. Ask Courtyard/Beezie/Renaiss for sanctioned read contracts/permission. A public
   page or blockchain presence alone is not evidence of a licensed listing feed.
5. Only after validation, separately approve catalogue/frontend integration. This
   task does not connect any adapter to the saved CC catalogue or production UI.
