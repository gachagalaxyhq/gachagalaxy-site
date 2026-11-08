"""Build a guarded local release candidate; never modify public/ or deploy.

Usage: python scripts/safe_build.py --output /path/to/NEW/candidate
Only publish that candidate after separate release review. The output must not
exist. Scheduled refreshes must not call this UI build or push to a deploy branch.
"""
import argparse
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

from deployment_guard import PROTECTED, digest, validate

ROOT = Path(__file__).resolve().parents[1]


def build(root, output):
    root, output = Path(root).resolve(), Path(output).resolve()
    if output.exists() or output == root or root in output.parents:
        raise ValueError('output must be a new directory outside the source tree')
    if not output.parent.is_dir():
        raise ValueError('output parent must already exist')
    # No .git, functions, operations, environment, Wrangler configuration or secrets.
    before = {name: digest(root / 'public' / name) for name in PROTECTED}
    with tempfile.TemporaryDirectory(prefix='gg-safe-build-', dir=output.parent) as directory:
        stage = Path(directory)
        for name in ('src', 'data', 'public'):
            shutil.copytree(root / name, stage / name)
        (stage / 'scripts').mkdir()
        for name in ('render.py', 'build_decoded_catalogue.py'):
            shutil.copyfile(root / 'scripts' / name, stage / 'scripts' / name)
        (stage / 'preview').mkdir()
        shutil.copyfile(root / 'preview/prepare_collector.py', stage / 'preview/prepare_collector.py')
        for script in ('scripts/render.py', 'preview/prepare_collector.py'):
            subprocess.run([sys.executable, str(stage / script)], cwd=stage, check=True)
        errors = validate(stage, baseline=root / 'public')
        if before != {name: digest(root / 'public' / name) for name in PROTECTED}:
            errors.append('source hand-edited pages changed during build')
        if errors:
            raise ValueError('Release blocked:\n' + '\n'.join(errors))
        # Rename only after validation, leaving no partial candidate on failure.
        (stage / 'public').rename(output)
    print(f'Guarded candidate ready: {output}. No deployment performed.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    try:
        build(ROOT, args.output)
    except (ValueError, OSError, subprocess.CalledProcessError) as exc:
        parser.exit(1, str(exc) + '\n')


if __name__ == '__main__':
    main()
