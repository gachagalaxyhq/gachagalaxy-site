"""One-call PSA API activation check. Prints status only, never the token.

Uses the shared daily ledger, so it counts toward the PSA plan limit.
Exit codes: 0 active, 2 not yet approved (401/403), 3 other failure,
4 daily cap reached, 5 credential missing.
"""
import argparse
import json
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from slab_consistency import DailyLedger, cert_number  # noqa: E402

KNOWN_CERT = '109308847'  # Rayquaza VMAX #218, PSA 10 (demo card)


def check(token_file, ledger, cert=KNOWN_CERT, opener=urllib.request.urlopen):
    now = datetime.now(timezone.utc).isoformat(timespec='seconds')
    out = {'checked_at': now, 'cert': cert}
    if not cert_number(cert):
        return 3, dict(out, status='invalid_cert')
    token_file = Path(token_file)
    if not token_file.is_file():
        return 5, dict(out, status='credential_missing')
    if not ledger.take():
        return 4, dict(out, status='daily_cap_reached', used_today=ledger.used())
    req = urllib.request.Request(
        'https://api.psacard.com/publicapi/cert/GetByCertNumber/' + cert,
        headers={'Authorization': 'bearer ' + token_file.read_text().strip(),
                 'User-Agent': 'gg-psa-check/1.0'})
    try:
        with opener(req, timeout=30) as r:
            body = json.load(r)
    except urllib.error.HTTPError as exc:
        code = 2 if exc.code in (401, 403) else 3
        return code, dict(out, status='not_approved' if code == 2 else 'http_error',
                          http=exc.code, used_today=ledger.used())
    except (OSError, ValueError):
        return 3, dict(out, status='request_failed', used_today=ledger.used())
    rec = (body or {}).get('PSACert') or {}
    ok = str(rec.get('CertNumber', '')).lstrip('0') == cert.lstrip('0')
    return (0 if ok else 3), dict(out, status='active' if ok else 'unexpected_response', http=200,
                                  grade=rec.get('CardGrade'), subject=rec.get('Subject'),
                                  used_today=ledger.used())


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--token-file', default=str(Path.home() / '.secrets/psa_token'))
    ap.add_argument('--ledger', default=str(Path.home() / '.gg-psa/usage.json'))
    ap.add_argument('--cert', default=KNOWN_CERT)
    a = ap.parse_args()
    code, result = check(a.token_file, DailyLedger(a.ledger), a.cert)
    print(json.dumps(result))
    sys.exit(code)


if __name__ == '__main__':
    main()
