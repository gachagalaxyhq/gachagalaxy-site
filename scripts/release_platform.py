"""Release from the repository root so Wrangler includes Pages Functions.

Usage: python3 scripts/release_platform.py --candidate /absolute/candidate
Use --verify-only to check production without deploying or calling upstream data.
"""
import argparse
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]


def smoke(base, upstream=False):
    checks = [('/api/check?q=ab', 400, 'error'),
              ('/api/mark-request', 200, 'intakeStatus')]
    if upstream:
        checks.append(('/api/check?q=charizard', 200, 'cards'))
    for path, expected, field in checks:
        result = subprocess.run(['curl', '--silent', '--show-error', '--max-time', '30',
                                 '--user-agent', 'gg-release-smoke/1.0',
                                 '--header', 'Accept: application/json',
                                 '--write-out', '\n%{http_code}\n%{content_type}',
                                 base.rstrip('/') + path], check=True, capture_output=True, text=True)
        body, status, content_type = result.stdout.rsplit('\n', 2)
        if int(status) != expected:
            raise RuntimeError(f'{path}: HTTP {status}, expected {expected}')
        if 'application/json' not in content_type:
            raise RuntimeError(f'{path}: expected JSON, not a static fallback')
        payload = json.loads(body)
        if field not in payload:
            raise RuntimeError(f'{path}: missing expected field {field}')
        if field == 'cards' and (not isinstance(payload['cards'], list) or not payload['cards']):
            raise RuntimeError(f'{path}: expected nonempty cards array')
        if path == '/api/mark-request' and (payload.get('paymentStatus') != 'inactive'
                                           or payload.get('payUrl') is not None):
            raise RuntimeError('Unexpected payment activation; release review required')
        suffix = f", {len(payload['cards'])} cards" if field == 'cards' else ''
        print(f'PASS {path}: HTTP {expected}, {content_type}{suffix}')
    print('Smoke passed. No submission or transaction performed.' +
          ('' if upstream else ' No upstream lookup performed.'))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--candidate', type=Path)
    parser.add_argument('--verify-only', action='store_true')
    parser.add_argument('--upstream', action='store_true', help='Also validate a real upstream search')
    parser.add_argument('--base', default='https://gachagalaxy.io')
    args = parser.parse_args()
    if not args.verify_only:
        if not args.candidate:
            parser.error('--candidate is required unless --verify-only')
        candidate = args.candidate.resolve()
        for required in ('index.html', 'platform.html', 'check.html', 'cleancheck.html'):
            if not (candidate / required).is_file():
                parser.error(f'candidate missing {required}')
        for required in ('api/check.js', 'api/mark-request.js', 'verify/[grader]/[cert].js'):
            if not (ROOT / 'functions' / required).is_file():
                parser.error(f'Functions source missing {required}')
        # cwd is part of the release contract, NOT the candidate directory.
        subprocess.run(['npx', 'wrangler', 'pages', 'deploy', str(candidate),
                        '--project-name', 'gachagalaxy-site', '--branch', 'main',
                        '--commit-dirty=true'], cwd=ROOT, check=True)
    smoke(args.base, upstream=args.upstream)


if __name__ == '__main__':
    main()
