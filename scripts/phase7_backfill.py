#!/usr/bin/env python3
"""Generate supabase/migrations/20261110_phase7_backfill.sql from checked-in files.

Offline and deterministic: reads repository files only (no network, no DB,
no secrets). Every source file's sha256 is embedded in the SQL so the backfill
is pinned to the exact evidence it was built from.

  python3 scripts/phase7_backfill.py           # (re)write the migration
  python3 scripts/phase7_backfill.py --check   # exit 1 if the committed file is stale

Rules (approved 2026-11-10):
  * All 18 Marks in src/onchain.json are backfilled as `published`
    (or `revoked` if listed in src/revoked.json), origin='backfill', request_id NULL.
  * The review's tx/block/registry is the ISSUANCE (earliest) event; every event,
    including republishes, is kept in the backfill event payload with its own
    registry.
  * First six: receipt_verified=true, citing operations/pre-issuance-receipts-check.json.
    Events on 2026-09-23 must be on the old registry, later ones on the current
    registry; anything else aborts generation.
  * Other twelve: receipt_verified=true from their receipt journals
    (operations/additional-marks-receipts.json, operations/marks-to-18-receipts.json).
"""
from __future__ import annotations

import hashlib
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = 'supabase/migrations/20261110_phase7_backfill.sql'
CHAIN_ID = 46630
OLD_REGISTRY = '0x30dfbca3978ce186e6107a93cedc7d2971d30950'
CURRENT_REGISTRY = '0x2a585396dd0248a060045b3f557076fb1b4cb0eb'
OLD_REGISTRY_DAY = '2026-09-23'
EXPECTED_COUNT = 18
FIRST_SIX = ['100863346', '111992917', '154790134', '153708045', '118973623', '109308847']

SOURCES = {
    'onchain': 'src/onchain.json',
    'revoked': 'src/revoked.json',
    'first6_onchain': 'operations/pre-issuance-onchain.json',
    'first6_receipts': 'operations/pre-issuance-receipts-check.json',
    'additional_receipts': 'operations/additional-marks-receipts.json',
    'to18_receipts': 'operations/marks-to-18-receipts.json',
}
TX_RE = re.compile(r'^0x[0-9a-f]{64}$')
HEX64 = re.compile(r'^[0-9a-f]{64}$')
CERT_RE = re.compile(r'^[1-9][0-9]{5,9}$')


class BackfillError(ValueError):
    pass


def need(cond: bool, msg: str) -> None:
    if not cond:
        raise BackfillError(msg)


def canon(value) -> str:
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True)


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def load(root: Path):
    raw = {k: (root / p).read_bytes() for k, p in SOURCES.items()}
    data = {k: json.loads(v.decode('utf-8')) for k, v in raw.items()}
    digests = {SOURCES[k]: sha256_hex(v) for k, v in raw.items()}
    return data, digests


def registry_for_first_six(t: str) -> str:
    return OLD_REGISTRY if t.startswith(OLD_REGISTRY_DAY) else CURRENT_REGISTRY


def build_records(data, digests):
    onchain = data['onchain']
    events = onchain['events']
    need(isinstance(events, dict) and len(events) == EXPECTED_COUNT,
         f'expected {EXPECTED_COUNT} Marks in src/onchain.json, found {len(events)}')
    need(onchain['registry'].lower() == CURRENT_REGISTRY, 'src/onchain.json registry changed')

    revoked = {}
    need(isinstance(data['revoked'].get('revoked'), list), 'src/revoked.json: revoked must be a list')
    for r in data['revoked']['revoked']:
        need(isinstance(r, dict) and r.get('grader', '').strip().upper() == 'PSA'
             and CERT_RE.match(str(r.get('cert', '')).strip() or '-') and r.get('reason'),
             'src/revoked.json entries need grader PSA, cert and reason')
        revoked[str(r['cert']).strip()] = {'reason': str(r['reason'])[:500], 'at': r.get('at')}
    need(set(revoked) <= set(events), 'src/revoked.json lists a cert that is not a Mark')

    first6_onchain = data['first6_onchain']['events']
    first6_rc = data['first6_receipts']['marks']
    need(sorted(first6_rc) == sorted(FIRST_SIX) and sorted(first6_onchain) == sorted(FIRST_SIX),
         'first-six receipt check must cover exactly the first six Marks')

    journals = {}
    for key in ('additional_receipts', 'to18_receipts'):
        j = data[key]
        need(j['chain_id'] == CHAIN_ID and j['registry'].lower() == CURRENT_REGISTRY,
             f'{SOURCES[key]}: chain/registry mismatch')
        need(HEX64.match(j['prepared_sha256']), f'{SOURCES[key]}: prepared_sha256')
        for t in j['transactions']:
            g, c = t['identity'].split(':')
            need(g == 'PSA' and c not in journals, f'duplicate/foreign identity {t["identity"]}')
            journals[c] = (key, j, t)

    records = []
    for cert in sorted(events):
        need(CERT_RE.match(cert) is not None, f'bad cert {cert}')
        evs = events[cert]
        need(isinstance(evs, list) and evs, f'{cert}: no events')
        for e in evs:
            need(TX_RE.match(e['tx']) is not None, f'{cert}: bad tx {e["tx"]}')
        ordered = sorted(evs, key=lambda e: e['t'])
        need(len({e['tx'] for e in evs}) == len(evs), f'{cert}: duplicate tx')
        out_events = []
        if cert in FIRST_SIX:
            need(first6_onchain[cert] == evs, f'{cert}: pre-issuance-onchain.json differs from src/onchain.json')
            rc = {r['tx']: r for r in first6_rc[cert]}
            need(set(rc) == {e['tx'] for e in evs}, f'{cert}: receipt check does not cover every tx')
            for e in ordered:
                r = rc[e['tx']]
                reg = registry_for_first_six(e['t'])
                need(r['found'] is True and r['status'] == '0x1' and r['logs'] == 1
                     and r['t'] == e['t'] and r['to'].lower() == reg
                     and isinstance(r['block'], int) and r['block'] > 0,
                     f'{cert}: receipt check failed for {e["tx"]}')
                out_events.append({'t': e['t'], 'tx': e['tx'], 'registry': reg, 'block': r['block'],
                                   'receipt_status': r['status'], 'low': e['low'], 'point': e['point'],
                                   'high': e['high']})
            issuance = out_events[0]
            evidence = {'receipt_verified': True,
                        'receipt_source': SOURCES['first6_receipts'],
                        'receipt_source_sha256': digests[SOURCES['first6_receipts']],
                        'receipt_checked_at': data['first6_receipts']['checked_at'],
                        'tx_source': SOURCES['first6_onchain'],
                        'tx_source_sha256': digests[SOURCES['first6_onchain']],
                        'block_hash': 'not_recorded', 'evidence_sha256': 'not_recorded',
                        'prepared_sha256': 'not_recorded'}
            block_hash = prepared = evidence_sha = None
        else:
            need(cert in journals, f'{cert}: no receipt journal')
            key, j, t = journals[cert]
            need(len(evs) == 1, f'{cert}: expected a single issuance event')
            e = evs[0]
            rcp = t['receipt']
            need(t['tx'] == e['tx'] and rcp['hash'] == e['tx'] and t['status'] == 'confirmed'
                 and rcp['status'] == 1 and rcp['to'].lower() == CURRENT_REGISTRY
                 and e['registry'].lower() == CURRENT_REGISTRY and e['chainId'] == CHAIN_ID
                 and t['block'] == e['block'] == rcp['blockNumber']
                 and t['block_hash'] == e['block_hash'] == rcp['blockHash']
                 and TX_RE.match(t['block_hash']) and HEX64.match(t['evidence_sha256'])
                 and t['event']['cert'] == cert and t['published_at'] == e['t'],
                 f'{cert}: receipt journal does not match src/onchain.json')
            out_events.append({'t': e['t'], 'tx': e['tx'], 'registry': CURRENT_REGISTRY,
                               'block': t['block'], 'block_hash': t['block_hash'],
                               'receipt_status': '0x1', 'gas_used': t['gas_used'],
                               'cert_key': t['event']['cert_key'], 'nonce': t['nonce'],
                               'low': e['low'], 'point': e['point'], 'high': e['high']})
            issuance = out_events[0]
            block_hash, prepared, evidence_sha = t['block_hash'], j['prepared_sha256'], t['evidence_sha256']
            evidence = {'receipt_verified': True, 'receipt_source': SOURCES[key],
                        'receipt_source_sha256': digests[SOURCES[key]],
                        'receipt_checked_at': j['verified_at'],
                        'prepared_sha256': prepared, 'evidence_sha256': evidence_sha}
        status = 'revoked' if cert in revoked else 'published'
        records.append({
            'grader': 'PSA', 'cert': cert, 'status': status,
            'tx': issuance['tx'], 'registry': issuance['registry'], 'block_number': issuance['block'],
            'block_hash': block_hash, 'published_at': issuance['t'],
            'prepared_sha256': prepared, 'evidence_sha256': evidence_sha,
            'revoked_reason': revoked.get(cert, {}).get('reason'),
            'payload': {'source': SOURCES['onchain'], 'source_sha256': digests[SOURCES['onchain']],
                        'chain_id': CHAIN_ID, 'issuance_tx': issuance['tx'],
                        'current_registry': CURRENT_REGISTRY,
                        'latest_publish_t': out_events[-1]['t'],
                        'events': out_events, 'revoked': revoked.get(cert),
                        'revoked_source_sha256': digests[SOURCES['revoked']],
                        'grader_lookup': 'not_checked', **evidence},
        })
    need(len(records) == EXPECTED_COUNT and len({r['cert'] for r in records}) == EXPECTED_COUNT,
         'expected 18 distinct identities')
    need(len({r['tx'] for r in records}) == EXPECTED_COUNT, 'issuance tx hashes must be distinct')
    return records


def q(v) -> str:
    if v is None:
        return 'null'
    if isinstance(v, bool):
        return 'true' if v else 'false'
    if isinstance(v, int):
        return str(v)
    return "'" + str(v).replace("'", "''") + "'"


def render(records, digests) -> str:
    manifest = canon(records)
    manifest_sha = sha256_hex(manifest.encode())
    src_lines = '\n'.join(f'--   {digests[p]}  {p}' for p in sorted(digests))
    rows = []
    for r in records:
        rows.append('  (' + ', '.join([
            q(r['grader']), q(r['cert']), q(r['status']), q(r['tx']), q(r['registry']),
            q(r['block_number']), q(r['block_hash']), q(r['published_at']) + '::timestamptz',
            q(r['prepared_sha256']), q(r['evidence_sha256']), q(r['revoked_reason']),
            q(sha256_hex(canon(r).encode())), q(canon(r['payload'])) + '::jsonb']) + ')')
    values = ',\n'.join(rows)
    return f"""-- GENERATED by scripts/phase7_backfill.py -- do not edit by hand.
-- Regenerate: python3 scripts/phase7_backfill.py ; verify: --check
-- Apply AFTER 20261110_phase7_review_queue.sql, as the migration owner.
-- Backfills the {len(records)} issued Gacha Marks as reviews (origin='backfill',
-- request_id NULL) with one hash-chained 'backfill' event each, then enqueues
-- any existing intake requests. Re-running is a no-op; any drift aborts.
-- Issuance stays disabled; nothing is written to public.marks / mark_events.
-- manifest sha256: {manifest_sha}
-- source files (sha256):
{src_lines}
begin;
set local lock_timeout = '5s';
lock table mark_review.reviews in share row exclusive mode;
create temporary table phase7_backfill_src (
  grader text, cert text, status text, tx text, registry text, block_number bigint,
  block_hash text, published_at timestamptz, prepared_sha256 text, evidence_sha256 text,
  revoked_reason text, record_sha256 text, payload jsonb) on commit drop;
insert into phase7_backfill_src values
{values};

do $$
declare n integer; drift integer; src_row record; v_id uuid;
begin
  if (select count(*) from phase7_backfill_src) <> {EXPECTED_COUNT}
     or (select count(distinct (grader, cert)) from phase7_backfill_src) <> {EXPECTED_COUNT}
     or (select count(distinct tx) from phase7_backfill_src) <> {EXPECTED_COUNT} then
    raise exception 'phase7 backfill: manifest must hold {EXPECTED_COUNT} distinct Marks';
  end if;
  if exists (select 1 from mark_review.flags where issuance_enabled) then
    raise exception 'phase7 backfill: issuance must be disabled';
  end if;
  -- Existing backfill rows must match exactly (rerun = no-op, drift = abort).
  select count(*) into drift from mark_review.reviews rv
    join phase7_backfill_src s on s.grader = rv.grader and s.cert = rv.cert
    where rv.origin = 'backfill' and (rv.tx, rv.registry, rv.block_number, rv.block_hash,
          rv.prepared_sha256, rv.evidence_sha256)
      is distinct from (s.tx, s.registry, s.block_number, s.block_hash,
          s.prepared_sha256, s.evidence_sha256);
  if drift > 0 then
    raise exception 'phase7 backfill: % existing backfill rows differ from manifest', drift;
  end if;
  if exists (select 1 from mark_review.reviews rv where rv.origin = 'backfill'
             and not exists (select 1 from phase7_backfill_src s
                             where s.grader = rv.grader and s.cert = rv.cert)) then
    raise exception 'phase7 backfill: unexpected backfill rows present';
  end if;

  for src_row in select * from phase7_backfill_src src
           where not exists (select 1 from mark_review.reviews rv where rv.origin = 'backfill'
                             and rv.grader = src.grader and rv.cert = src.cert)
           order by src.cert loop
    insert into mark_review.reviews (origin, grader, cert, status, tx, chain_id, registry,
      block_number, block_hash, published_at, prepared_sha256, evidence_sha256,
      revoked_reason, decision_reason)
    values ('backfill', src_row.grader, src_row.cert, src_row.status, src_row.tx, {CHAIN_ID}, src_row.registry, src_row.block_number,
      src_row.block_hash, src_row.published_at, src_row.prepared_sha256, src_row.evidence_sha256, src_row.revoked_reason,
      'Backfilled from issuance records (pre-queue Mark)')
    returning id into v_id;
    insert into mark_review.events (review_id, action, from_status, to_status, actor, actor_kind,
      idempotency_key, request_sha256, payload, result, version_after)
    values (v_id, 'backfill', null, src_row.status, null, 'migration',
      md5('phase7:backfill:' || src_row.grader || ':' || src_row.cert)::uuid, src_row.record_sha256, src_row.payload,
      jsonb_build_object('ok', true, 'review_id', v_id, 'action', 'backfill',
                         'status', src_row.status, 'version', 1), 1);
  end loop;

  select count(*) into n from mark_review.reviews rv join phase7_backfill_src s
    using (grader, cert, tx) where rv.origin = 'backfill';
  if n <> {EXPECTED_COUNT} then
    raise exception 'phase7 backfill: expected {EXPECTED_COUNT} backfill reviews, found %', n;
  end if;
  select count(*) into n from mark_review.events e join mark_review.reviews rv on rv.id = e.review_id
    where rv.origin = 'backfill' and e.action = 'backfill';
  if n <> {EXPECTED_COUNT} then
    raise exception 'phase7 backfill: expected {EXPECTED_COUNT} backfill events, found %', n;
  end if;
end $$;

-- Existing intake requests become queued reviews, unless the card is already
-- an issued Mark (then it is counted in review_queue().requests_for_open_card).
select mark_review.enqueue_backlog();
commit;
"""


def generate(root: Path = ROOT) -> str:
    data, digests = load(root)
    return render(build_records(data, digests), digests)


def main(argv) -> int:
    sql = generate()
    target = ROOT / OUT
    if argv[1:] == ['--check']:
        ok = target.exists() and target.read_text() == sql
        print('backfill up to date' if ok else f'{OUT} is stale; regenerate')
        return 0 if ok else 1
    if argv[1:]:
        print(__doc__)
        return 2
    target.write_text(sql)
    print(f'wrote {OUT}')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
