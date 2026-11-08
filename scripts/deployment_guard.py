"""Offline release contract. Reads only public site files; never deploys."""
import argparse
import hashlib
import json
from html.parser import HTMLParser
from pathlib import Path
import re

STATS = [31081, 1071938, 8, 18]
NAV = [('#how', 'How it works'), ('#certificates', 'Certificates'),
       ('#scanner', 'Scanner'), ('#partners', 'For partners'), ('#token', '$GG')]
SECTIONS = [('#how', 'How it works'), ('#scanner', 'Scanner'), ('#showcase', 'Video'),
            ('#token', '$GG'), ('/check', 'Price Check'), ('/platform?saved=1', 'Open platform')]
ANIMATIONS = ('scanlineDrift', 'pulse', 'gfloat', 'gglow', 'numGlowBreath',
              'statusDotPulse', 'resOk', 'resFl', 'packet', 'floatBanner')
REQUIRED = ('index.html', 'platform.html', 'check.html', 'cleancheck.html',
            'certificate.html', 'how-gacha-mark-works/index.html', 'terms/index.html',
            'privacy/index.html', 'risk-disclosure/index.html', '404.html')
PROTECTED = ('check.html', 'cleancheck.html')


class Homepage(HTMLParser):
    def __init__(self, text):
        super().__init__()
        self.stats, self.ids, self.links = [], set(), []
        self.counter = None
        self.feed(text)

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if 'id' in attrs:
            self.ids.add(attrs['id'])
        if 'data-count' in attrs:
            self.stats.append([attrs['data-count'], ''])
            self.counter = self.stats[-1]
        if tag == 'a':
            self.links.append(attrs.get('href', ''))

    def handle_data(self, data):
        if self.counter is not None:
            self.counter[1] += data

    def handle_endtag(self, tag):
        self.counter = None


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def homepage_errors(text, label):
    errors = []
    page = Homepage(text)
    if page.stats != [[str(n), f'{n:,}'] for n in STATS]:
        errors.append(f'{label}: approved four stats/visible values changed')
    for pattern, expected in [(r'<ul class="nav__links">(.*?)</ul>', NAV),
                              (r'<nav class="source-mirror"[^>]*>(.*?)</nav>', SECTIONS)]:
        match = re.search(pattern, text, re.S)
        links = re.findall(r'<a\b[^>]*href="([^"]+)"[^>]*>(.*?)</a>', match[1], re.S) if match else []
        if links != expected:
            errors.append(f'{label}: current navigation changed')
    for target in {href[1:] for href, _ in NAV + SECTIONS if href.startswith('#')}:
        if target not in page.ids:
            errors.append(f'{label}: missing navigation target #{target}')
    if '/platform?saved=1' not in page.links:
        errors.append(f'{label}: missing platform link')
    for name in ANIMATIONS:
        if not re.search(r'@keyframes\s+' + name + r'\s*\{', text) or not re.search(r'animation\s*:[^;}]*\b' + name + r'\b', text):
            errors.append(f'{label}: missing animation {name}')
    for hook in ("document.querySelectorAll('[data-count]')", 'requestAnimationFrame(f)',
                 'IntersectionObserver', "el.classList.add('is-ticking')"):
        if hook not in text:
            errors.append(f'{label}: missing counter animation hook {hook}')
    return errors


def validate(root, public=None, baseline=None):
    root = Path(root)
    public = Path(public) if public else root / 'public'
    errors = []
    for name in REQUIRED:
        path = public / name
        if not path.is_file() or not path.stat().st_size:
            errors.append(f'missing/empty required page: {name}')
    for path in (root / 'src/index.tpl.html', public / 'index.html'):
        if path.is_file():
            errors.extend(homepage_errors(path.read_text(), str(path.relative_to(root)) if path.is_relative_to(root) else path.name))
    try:
        source = json.loads((root / 'src/certs.json').read_text())
        platform = (public / 'platform.html').read_text()
        payload, _ = json.JSONDecoder().raw_decode(platform.split('const D=', 1)[1])
        claims = json.loads((public / 'data/own-claims.json').read_text())
        keys = lambda rows: [(row.get('grader', 'PSA'), row['cert']) for row in rows]
        if len(source) != 18 or len(set(keys(source))) != 18:
            errors.append('source must contain 18 unique Mark records')
        for label, rows in [('platform', payload['certs']), ('public Mark feed', claims)]:
            if len(rows) != 18 or sorted(keys(rows)) != sorted(keys(source)):
                errors.append(f'{label}: expected all 18 source Mark records')
    except (OSError, ValueError, KeyError, IndexError, TypeError) as exc:
        errors.append(f'Mark evidence unreadable: {exc}')
    # Inspect all shipped markup and routing configuration, not only the home link.
    paths = list(public.rglob('*.html')) + [public / '_redirects', public / 'sitemap.xml',
                                         root / 'src/platform.tpl.html', root / 'scripts/gg-paths.worker.js']
    paths += list(public.glob('borrowing-pilot*'))
    for path in paths:
        if 'borrowing-pilot' in path.name or (path.is_file() and re.search(r'borrowing-pilot|borrowingPilot\s*\(', path.read_text())):
            errors.append(f'removed borrowing-pilot route remains: {path.name}')
    for path in [public / 'index.html', public / 'platform.html']:
        if path.is_file() and re.search(r'__[A-Z][A-Z_]+__', path.read_text()):
            errors.append(f'unresolved template marker: {path.name}')
    if baseline:
        for name in PROTECTED:
            original, candidate = Path(baseline) / name, public / name
            if not original.is_file() or not candidate.is_file() or digest(original) != digest(candidate):
                errors.append(f'hand-edited page changed: {name}')
    return errors


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--public', type=Path)
    parser.add_argument('--baseline', type=Path)
    args = parser.parse_args()
    errors = validate(args.root, args.public, args.baseline)
    if errors:
        parser.exit(1, '\n'.join(errors) + '\nRelease blocked.\n')
    print('Release contract passed: stats, 18 Marks, navigation, animation hooks, removed route and required pages.')


if __name__ == '__main__':
    main()
