"""CLI outputs JSON to stdout only; never updates the saved CC catalogue."""

import argparse
import json
from pathlib import Path
import sys

from .adapters import IngestError, MAX_BYTES, normalize
from .registry import VENUES
from .transport import fetch_public, plan_request


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("status", help="Research evidence and honest per-venue status")
    plan = commands.add_parser("plan", help="Print one documented request; makes no network calls")
    plan.add_argument("venue", choices=VENUES)
    plan.add_argument("--limit", type=int, default=1)
    plan.add_argument("--query")
    plan.add_argument("--collection")
    ingest = commands.add_parser("normalize", help="Normalize a credential-free authorized capture")
    ingest.add_argument("venue", choices=VENUES)
    ingest.add_argument("--input", required=True, help="Explicit JSON capture, not credentials/headers")
    ingest.add_argument("--source-url", required=True, help="API URL WITHOUT query/fragment/credentials")
    ingest.add_argument("--observed-at", required=True)
    ingest.add_argument("--rows-pointer", help="Exact RFC 6901 array location; never auto-detect envelopes")
    fetch = commands.add_parser("fetch-public", help="One Phygitals GET, no keys/retries/fallbacks; unresolved transport")
    fetch.add_argument("venue", choices=["phygitals"])
    fetch.add_argument("--limit", type=int, default=1)
    fetch.add_argument("--permission-confirmed", action="store_true")
    args = parser.parse_args(argv)
    try:
        if args.command == "status":
            result = {"researched_at": "2026-11-08", "is_live_feed": False, "venues": VENUES}
        elif args.command == "plan":
            result = plan_request(args.venue, limit=args.limit, query=args.query, collection=args.collection)
        elif args.command == "normalize":
            path = Path(args.input)
            if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_BYTES:
                raise IngestError("Input must be an explicit regular JSON file of at most 2 MB, not a symlink")
            with path.open("rb") as stream:
                data = stream.read(MAX_BYTES + 1)
            if len(data) > MAX_BYTES:
                raise IngestError("Input exceeds 2 MB bound")
            payload = json.loads(data)
            result = normalize(args.venue, payload, source_url=args.source_url,
                               observed_at=args.observed_at, rows_pointer=args.rows_pointer)
        else:
            payload, request_plan = fetch_public(args.venue, permission_confirmed=args.permission_confirmed,
                                                 limit=args.limit)
            # Do not guess the undocumented envelope. Return one raw capture for inspection.
            result = {"mode": "single_public_read_not_live_feed", "request": request_plan, "payload": payload}
        print(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False))
        return 0
    except (IngestError, OSError, ValueError, RecursionError) as exc:
        # No raw response, request headers, credentials, or payload data in errors.
        message = str(exc) if isinstance(exc, IngestError) else type(exc).__name__
        print(json.dumps({"error": message, "is_live_feed": False}), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
