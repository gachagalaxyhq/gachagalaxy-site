"""Offline, fail-closed public projection of the authorised saved CC catalogue.

Never imports the scanner (which has network/write capabilities). Only named
public listing fields and enum-valued scan evidence cross this boundary. Raw
records, owners, receipts, QR payloads, audit data and grading verdicts do not.
Run: python scripts/export_cc_catalogue.py --db PATH --summary PATH
"""
import argparse
import collections
import datetime as dt
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import tempfile
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
SHARD_SIZE = 500
SEARCH_SIZE = 5000
# Established public listing asset origins, not arbitrary URLs from raw/images.
IMAGE_HOSTS = frozenset({
    'arweave.net', 'nft.collectorcrypt.com', 'dilxwvfkfup17.cloudfront.net',
    'd1xpxki1g4htqu.cloudfront.net', 'd1htnxwo4o0jhw.cloudfront.net',
    'ccg-imaging-cgc-tradingcards-production.s3.amazonaws.com',
})
SCAN_STATUSES = frozenset({'decoded', 'unreadable', 'failed', 'no_back_photo',
                           'decoder_crash', 'decoder_error', 'decoder_timeout'})
QR_STATUSES = frozenset({'match', 'review_needed', 'not_checked'})
COMPARISONS = frozenset({'match', 'mismatch'})
PUBLIC_FIELDS = ('id', 'name', 'set', 'number', 'grader', 'grade', 'cert',
                 'ask', 'currency', 'listed_at', 'captured_at', 'image', 'scan')
SCAN_FIELDS = ('processed', 'status', 'qr_status', 'cert_comparison', 'checked_at')
SEARCH_FIELDS = ('id', 'name', 'set', 'number', 'grader', 'grade', 'cert',
                 'shard', 'offset', 'processed')


def text(value, limit=500):
    if value is None or value == '':
        return None
    if not isinstance(value, (str, int, float)) or isinstance(value, bool):
        return None
    result = str(value)
    # A public text field is never a transport for links, email or control bytes.
    if len(result) > limit or re.search(r'https?://|www\.|[^\s@]+@[^\s@]+\.[^\s@]+|[\x00-\x08\x0b\x0c\x0e-\x1f]', result, re.I):
        return None
    return result


def timestamp(value):
    if not isinstance(value, str):
        return None
    try:
        parsed = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
        if parsed.tzinfo is None:
            return None
        return parsed.astimezone(dt.timezone.utc).isoformat()
    except ValueError:
        return None


def image_url(value):
    if not isinstance(value, str) or len(value) > 2048:
        return None
    try:
        u = urlsplit(value)
        host = u.hostname or ''
        approved = host in IMAGE_HOSTS or bool(re.fullmatch(r'[a-z0-9]{43,64}\.arweave\.net', host))
        if (u.scheme != 'https' or not approved or u.username or u.password or
                u.port not in (None, 443) or u.query or u.fragment or not u.path or
                re.search(r'[\s<>"\\]', value)):
            return None
        return value  # Original listing front asset only; never decoded QR URLs.
    except ValueError:
        return None


def project(row):
    raw = json.loads(row['raw'])
    listing = raw.get('listing')
    listing = listing if isinstance(listing, dict) else {}
    price = listing.get('price')
    if isinstance(price, bool) or not isinstance(price, (int, float)) or not math.isfinite(price) or price < 0:
        price = None
    currency = listing.get('currency')
    currency = currency if isinstance(currency, str) and re.fullmatch('[A-Z0-9]{2,10}', currency) else None
    return dict(id=row['id'], name=text(raw.get('itemName')), set=text(raw.get('set')),
                number=text(raw.get('serial'), 100), grader=text(row['company'], 60),
                grade=text(raw.get('grade'), 100), cert=text(row['cert'], 100),
                ask=price, currency=currency, listed_at=timestamp(raw.get('listedAt')),
                captured_at=timestamp(row['captured_at']), image=image_url(row['front_url']),
                scan=dict(processed=row['result_id'] is not None,
                          status=row['scan_status'] if row['scan_status'] in SCAN_STATUSES else 'not_processed' if row['result_id'] is None else 'not_checked',
                          qr_status=row['qr_status'] if row['qr_status'] in QR_STATUSES else 'not_checked',
                          cert_comparison=row['comparison'] if row['comparison'] in COMPARISONS else None,
                          checked_at=timestamp(row['checked_at'])))


def write_json(path, value):
    payload = json.dumps(value, separators=(',', ':'), ensure_ascii=False, allow_nan=False).encode()
    path.write_bytes(payload)
    return dict(file=path.name, count=len(value), bytes=len(payload), sha256=hashlib.sha256(payload).hexdigest())


def export(db_path, summary_path, output):
    # immutable=1 prevents lock/journal creation and deliberately reads ONLY the
    # saved main file. Other work may have a WAL: never checkpoint or consume it.
    # Pin the main-file capture to the supplied summary below, not to live work.
    before = (db_path.stat().st_size, db_path.stat().st_mtime_ns)
    summary = json.loads(summary_path.read_text())
    cutoff = summary['image_scan_checkpoint']
    db = sqlite3.connect(db_path.resolve().as_uri() + '?mode=ro&immutable=1', uri=True)
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA query_only=ON')
    total = db.execute('SELECT COUNT(*) FROM listings').fetchone()[0]
    processed = db.execute('SELECT COUNT(*) FROM results r JOIN listings l ON l.id=r.listing_id WHERE r.checked_at<=?', (cutoff,)).fetchone()[0]
    if total != summary['listing_records'] or processed != summary['processed_listing_records']:
        raise ValueError('Saved summary and SQL counts disagree; public manifest not replaced')
    captured = list(db.execute('SELECT MIN(captured_at),MAX(captured_at) FROM listings').fetchone())
    checked = list(db.execute('SELECT MIN(checked_at),MAX(checked_at) FROM results WHERE checked_at<=?', (cutoff,)).fetchone())
    # Summary creation follows the last result; it is not a result timestamp.
    if (captured != summary['source_capture_range'] or not checked[1] or
            timestamp(checked[1]) > timestamp(summary['image_scan_checkpoint'])):
        raise ValueError('Saved main-file capture does not match summary timestamps')
    output.mkdir(parents=True, exist_ok=True)
    # Bounded working set: 500 full rows + 5,000 compact search rows.
    with tempfile.TemporaryDirectory(prefix='.build-', dir=output) as temporary:
        stage = Path(temporary)
        shards, search_shards, batch, search = [], [], [], []
        counts = collections.Counter()
        graders = collections.Counter()
        missing = collections.Counter()
        cursor = db.execute('''SELECT l.id,l.company,l.cert,l.front_url,l.captured_at,l.raw,
            r.listing_id AS result_id,r.status AS scan_status,r.qr_status,r.comparison,r.checked_at
            FROM listings l LEFT JOIN results r ON r.listing_id=l.id AND r.checked_at<=?
            ORDER BY l.first_page,l.rowid''', (cutoff,))
        n = 0
        first_shard = []
        for row in cursor:
            public = project(row)
            shard, offset = divmod(n, SHARD_SIZE)
            batch.append(public)
            if n < SHARD_SIZE:
                first_shard.append(public)
            search.append([public[k] for k in SEARCH_FIELDS[:7]] + [shard, offset, public['scan']['processed']])
            for key in PUBLIC_FIELDS:
                if public[key] is None:
                    missing[key] += 1
            counts['priced'] += public['ask'] is not None
            counts['images'] += public['image'] is not None
            counts['processed'] += public['scan']['processed']
            graders[public['grader'] or 'Not supplied'] += 1
            n += 1
            if len(batch) == SHARD_SIZE:
                shards.append(write_json(stage / f'listings-{len(shards):04d}.json', batch))
                batch = []
            if len(search) == SEARCH_SIZE:
                search_shards.append(write_json(stage / f'search-{len(search_shards):04d}.json', search))
                search = []
        if batch:
            shards.append(write_json(stage / f'listings-{len(shards):04d}.json', batch))
        if search:
            search_shards.append(write_json(stage / f'search-{len(search_shards):04d}.json', search))
        # A diverse opening page, not a value ranking. Permute only the first
        # shard so browse remains one-shard/low-bandwidth and no row is lost.
        opening, seen_sets = [], set()
        for offset, row in enumerate(first_shard):
            if row['name'] and row['set'] and row['set'] not in seen_sets and row['image']:
                opening.append(offset)
                seen_sets.add(row['set'])
                if len(opening) == 40:
                    break
        chosen = set(opening)
        browse_first_shard_order = opening + [i for i in range(len(first_shard)) if i not in chosen]
        assert n == total and counts['processed'] == processed
        if before != (db_path.stat().st_size, db_path.stat().st_mtime_ns):
            raise ValueError('Main-file capture changed during export; manifest not replaced')
        version = 'snapshot-' + hashlib.sha256(json.dumps([shards, search_shards], sort_keys=True).encode()).hexdigest()[:20]
        version_dir = output / version
        if not version_dir.exists():
            os.rename(stage, version_dir)
        else:
            # A deterministic repeat may reuse only byte-identical existing data.
            for entry in shards + search_shards:
                if hashlib.file_digest((version_dir / entry['file']).open('rb'), 'sha256').hexdigest() != entry['sha256']:
                    raise ValueError('Existing version failed integrity check')
        manifest = dict(schema_version=1, version=version, source='Collector Crypt saved authorised catalogue',
            exported_at=dt.datetime.now(dt.timezone.utc).isoformat(),
            capture_range=[timestamp(x) for x in captured],
            scan_range=[timestamp(x) for x in checked], scan_checkpoint=timestamp(cutoff),
            summary_generated_at=timestamp(summary.get('generated_at')),
            catalogue_complete=summary.get('catalogue_complete') is True,
            total_records=total, processed_records=processed, pending_records=total-processed,
            priced_records=counts['priced'], image_records=counts['images'],
            graders=dict(sorted(graders.items())), missing_fields=dict(missing),
            public_fields=list(PUBLIC_FIELDS), scan_fields=list(SCAN_FIELDS), search_fields=list(SEARCH_FIELDS),
            shard_size=SHARD_SIZE, page_size=40, shards=shards, search_shards=search_shards,
            browse_first_shard_order=browse_first_shard_order,
            opening_page_sets=len(seen_sets),
            browse_order_note='Opening page: one saved listing per distinct supplied set, with an allowlisted original image, selected from the first 500 source records; remaining records follow without duplication. Not a price ranking.',
            base_url=f'/data/catalogue/{version}/',
            limitations=['Saved listing records, not unique cards or unique certs.',
                'Source traversal is not an atomic marketplace snapshot; current availability is not_checked.',
                'Saved back-image scan evidence is partial and is not physical authentication.',
                'No raw QR URLs, owners, contacts, audit errors or issuance data exported.',
                'Missing or withheld values remain null. A source ask is not a completed sale or valuation.',
                'Only allowlisted original public listing front-image assets are included.'])
        pending = output / '.manifest.next'
        pending.write_text(json.dumps(manifest, separators=(',', ':'), ensure_ascii=False))
        os.replace(pending, output / 'manifest.json')  # Publish manifest last.
    db.close()
    print(json.dumps({k: manifest[k] for k in ('version', 'total_records', 'processed_records', 'pending_records', 'priced_records', 'image_records')}))
    return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--db', type=Path, required=True)
    parser.add_argument('--summary', type=Path, required=True)
    parser.add_argument('--output', type=Path, default=ROOT / 'public/data/catalogue')
    args = parser.parse_args()
    export(args.db, args.summary, args.output)
