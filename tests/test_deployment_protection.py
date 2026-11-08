"""Offline phase-1 release safety tests; all mutations stay in disposable trees."""
import hashlib
import json
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import deployment_guard as guard
import safe_build


def hashes(directory):
    return {str(p.relative_to(directory)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in directory.rglob('*') if p.is_file()}


class DeploymentProtectionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='gg-protection-tests-')
        cls.root = Path(cls.temp.name) / 'source'
        cls.root.mkdir()
        for name in ('src', 'data', 'public'):
            shutil.copytree(ROOT / name, cls.root / name)
        (cls.root / 'scripts').mkdir()
        for name in ('render.py', 'build_decoded_catalogue.py', 'gg-paths.worker.js'):
            shutil.copyfile(ROOT / 'scripts' / name, cls.root / 'scripts' / name)
        (cls.root / 'preview').mkdir()
        shutil.copyfile(ROOT / 'preview/prepare_collector.py', cls.root / 'preview/prepare_collector.py')
        cls.before = hashes(cls.root)
        cls.output = Path(cls.temp.name) / 'candidate'
        # Child Python processes inherit a network-denying sitecustomize.
        blocker = Path(cls.temp.name) / 'sitecustomize.py'
        blocker.write_text("import socket\ndef deny(*a, **k): raise RuntimeError('network forbidden in build tests')\nsocket.socket = deny\nsocket.create_connection = deny\n")
        import os
        with patch.dict(os.environ, {'PYTHONPATH': cls.temp.name}), patch.object(socket, 'socket', side_effect=AssertionError('network forbidden')):
            safe_build.build(cls.root, cls.output)

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def test_current_release_and_actual_safe_build_pass_guard(self):
        self.assertEqual(guard.validate(ROOT), [])
        self.assertEqual(guard.validate(self.root, self.output, self.root / 'public'), [])

    def test_safe_build_preserves_every_source_byte_and_hand_edited_pages(self):
        self.assertEqual(hashes(self.root), self.before)
        for name in guard.PROTECTED:
            self.assertEqual((self.output / name).read_bytes(), (self.root / 'public' / name).read_bytes())

    def test_build_uses_corrected_templates_instead_of_stale_rendered_home(self):
        path = self.root / 'public/index.html'
        before = path.read_bytes()
        try:
            path.write_text('stale repository UI')
            output = Path(self.temp.name) / 'rebuilt'
            safe_build.build(self.root, output)
            self.assertEqual(guard.homepage_errors((output / 'index.html').read_text(), 'rebuilt'), [])
            self.assertEqual(path.read_text(), 'stale repository UI')
        finally:
            path.write_bytes(before)

    def test_each_stat_visible_value_navigation_target_and_animation_regression_blocks(self):
        home = (ROOT / 'public/index.html').read_text()
        mutations = []
        for n in guard.STATS:
            mutations += [(f'data-count="{n}"', 'data-count="0"'), (f'>{n:,}</div>', '>0</div>')]
        mutations += [('href="#partners"', 'href="#old"'), ('id="partners"', 'id="old"'),
                      ('Price Check</a>', 'Old check</a>'), ('requestAnimationFrame(f)', 'noop(f)'),
                      ('IntersectionObserver', 'RemovedObserver')]
        mutations += [(f'@keyframes {name}', f'@removed {name}') for name in guard.ANIMATIONS]
        for old, new in mutations:
            with self.subTest(old=old):
                self.assertIn(old, home)
                self.assertTrue(guard.homepage_errors(home.replace(old, new), 'mutated'))

    def mutate(self, name, transform):
        path = self.output / name
        before = path.read_bytes()
        try:
            path.write_text(transform(before.decode()))
            return guard.validate(self.root, self.output, self.root / 'public')
        finally:
            path.write_bytes(before)

    def test_mark_source_platform_and_feed_regressions_block(self):
        source = self.root / 'src/certs.json'
        before = source.read_bytes()
        try:
            source.write_text(json.dumps(json.loads(before)[:-1]))
            self.assertTrue(any('18 unique' in e for e in guard.validate(self.root, self.output)))
        finally:
            source.write_bytes(before)
        def drop_mark(text):
            prefix, rest = text.split('const D=', 1)
            payload, end = json.JSONDecoder().raw_decode(rest)
            payload['certs'].pop()
            return prefix + 'const D=' + json.dumps(payload) + rest[end:]
        self.assertTrue(any('platform: expected' in e for e in self.mutate('platform.html', drop_mark)))
        self.assertTrue(any('public Mark feed' in e for e in self.mutate('data/own-claims.json', lambda t: json.dumps(json.loads(t)[:-1]))))
        self.assertTrue(any('public Mark feed' in e for e in self.mutate('data/own-claims.json', lambda t: json.dumps([json.loads(t)[0]] * 18))))

    def test_removed_route_required_pages_placeholders_and_protected_pages_block(self):
        for name in guard.REQUIRED:
            with self.subTest(page=name):
                self.assertTrue(self.mutate(name, lambda text: ''))
        for name in ('index.html', 'platform.html', '_redirects'):
            self.assertTrue(any('removed borrowing-pilot' in e for e in self.mutate(name, lambda text: text + '\n/borrowing-pilot')))
        self.assertTrue(any('template marker' in e for e in self.mutate('platform.html', lambda text: text + '__CC_DATA__')))
        for name in guard.PROTECTED:
            self.assertTrue(any('hand-edited page changed' in e for e in self.mutate(name, lambda text: text + '\nchanged')))

    def test_failed_guard_leaves_no_candidate(self):
        path = self.root / 'src/index.tpl.html'
        before = path.read_bytes()
        output = Path(self.temp.name) / 'blocked'
        try:
            path.write_text(path.read_text().replace('data-count="31081"', 'data-count="1"'))
            with self.assertRaisesRegex(ValueError, 'Release blocked'):
                safe_build.build(self.root, output)
            self.assertFalse(output.exists())
        finally:
            path.write_bytes(before)

    def test_existing_output_and_in_tree_output_are_never_overwritten(self):
        for path in (self.output, self.root / 'public', self.root / 'new-output'):
            with self.subTest(path=path), self.assertRaises(ValueError):
                safe_build.build(self.root, path)

    def test_shipped_counter_animation_executes_to_approved_values(self):
        # Execute the actual shipped counter block, not a rewritten equivalent.
        runner = r"""
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const html=fs.readFileSync(process.argv[1],'utf8');
const start=html.indexOf("(function(){const els=[...document.querySelectorAll('[data-count]')]");
assert.ok(start>=0);const code=html.slice(start,html.indexOf('})();',start)+5);
for(const observed of [true,false]){
 const frames=[],els=[31081,1071938,8,18].map(n=>({dataset:{count:String(n)},textContent:'',classList:{add(){},remove(){}}}));
 const ctx={document:{querySelectorAll:()=>els},window:observed?{IntersectionObserver:true}:{},performance:{now:()=>0},
 requestAnimationFrame:f=>frames.push(f),IntersectionObserver:class{constructor(fn){this.fn=fn}observe(target){this.fn([{isIntersecting:true,target}])}unobserve(){}}};
 vm.runInNewContext(code,ctx);assert.equal(frames.length,4);
 while(frames.length)frames.shift()(1600);
 assert.deepEqual(els.map(e=>e.textContent),['31,081','1,071,938','8','18']);
}
"""
        subprocess.run(['node', '-e', runner, str(self.output / 'index.html')], check=True)

    def test_schedule_is_artifact_only_and_cannot_trigger_repository_deployment(self):
        workflow = (ROOT / '.github/workflows/refresh.yml').read_text()
        self.assertIn('contents: read', workflow)
        self.assertIn('actions/upload-artifact@v4', workflow)
        for forbidden in ('git push', 'git commit', 'git add', 'scripts/render.py',
                          'prepare_collector.py', 'safe_build.py --', 'wrangler', 'contents: write'):
            self.assertNotIn(forbidden, workflow)
        artifact = workflow.split('          path: |', 1)[1].split('          if-no-files-found:', 1)[0]
        self.assertEqual(artifact.split(), ['data/cc.json', 'data/history.json', 'src/onchain.json'])
        self.assertNotIn('public/', artifact)


if __name__ == '__main__':
    unittest.main()
