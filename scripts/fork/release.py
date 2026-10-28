#!/usr/bin/env python3
"""Plan/export an immutable private-fork release. Never changes running services."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys

SERVICES = ('app', 'worker', 'scheduler')
DOCKERFILES = dict(zip(SERVICES, ('Dockerfile', 'Dockerfile.worker', 'Dockerfile.scheduler')))


def git(repo, *args):
    return subprocess.check_output(['git', '-C', str(repo), *args], stderr=subprocess.PIPE).decode().strip()


def normalized_remote(url):
    return re.sub(r'\.git$', '', url.replace('git@github.com:', 'https://github.com/')).rstrip('/')


def check_source(repo, expected_fork, revision, exporting=False):
    expected = normalized_remote(expected_fork)
    if not re.fullmatch(r'https://github.com/[A-Za-z0-9_.-]+/DeskcommCRM', expected):
        raise ValueError('Specify the exact private fork GitHub URL.')
    if expected.lower() == 'https://github.com/melgarafael/deskcommcrm':
        raise ValueError('The official repository is a read-only source, never a release destination.')
    if normalized_remote(git(repo, 'remote', 'get-url', 'origin')) != expected:
        raise ValueError('origin does not match the requested fork.')
    if git(repo, 'status', '--porcelain', '--untracked-files=all'):
        raise ValueError('Commit or preserve all working changes before planning a release.')
    sha = git(repo, 'rev-parse', '--verify', revision + '^{commit}')
    tracked = git(repo, 'ls-tree', '-r', '--name-only', sha).splitlines()
    if any(Path(name).name.startswith('.env') and not Path(name).name.endswith('.example') for name in tracked):
        raise ValueError('Tracked environment files are forbidden in a release archive.')
    if exporting:
        subprocess.run(['git', '-C', str(repo), 'merge-base', '--is-ancestor', sha, 'origin/main'], check=True, stderr=subprocess.PIPE)
    return sha


def changed_paths(repo, base, target):
    raw = subprocess.check_output(['git', '-C', str(repo), 'diff', '--name-status', '--no-renames', '-z', base, target]).decode().split('\0')
    return [{'status': raw[i], 'path': raw[i + 1]} for i in range(0, len(raw) - 1, 2)]


def make_plan(repo, fork, sha, bases):
    differences = {service: changed_paths(repo, base, sha) for service, base in bases.items()}
    paths = {item['path'] for changes in differences.values() for item in changes}
    # A coordinated release is intentional. Shared libraries are imported by both
    # runtimes; picking only the web image caused the original deployment drift.
    needs_schema_review = any(p == 'supabase/baseline.sql' or p.startswith('supabase/migrations/') for p in paths)
    short = sha[:12]
    return {
        'schema_version': 1,
        'source_repository': normalized_remote(fork),
        'source_revision': sha,
        'source_tree': git(repo, 'rev-parse', sha + '^{tree}'),
        'bases': bases,
        'services': {s: {'image': 'deskcommcrm-' + s + ':fork-' + short, 'dockerfile': DOCKERFILES[s]} for s in SERVICES},
        'changes': differences,
        'database_review_required': needs_schema_review,
        'activation_requirements': ['local acceptance', 'passing checks for this revision', 'database backup and schema compatibility', 'current Compose project/files verified', 'all three images built and identified', 'rollback images and configuration preserved', 'public HTTP and service health verified'],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', type=Path, default=Path.cwd())
    parser.add_argument('--fork', required=True)
    parser.add_argument('--revision', default='HEAD')
    for service in SERVICES:
        parser.add_argument('--' + service + '-base', required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--export', action='store_true', help='Export committed source; revision must already exist in origin/main.')
    args = parser.parse_args()
    try:
        sha = check_source(args.repo, args.fork, args.revision, args.export)
        bases = {s: git(args.repo, 'rev-parse', '--verify', getattr(args, s + '_base') + '^{commit}') for s in SERVICES}
        plan = make_plan(args.repo, args.fork, sha, bases)
        args.output.mkdir(parents=True, exist_ok=False)
        if args.export:
            source = args.output / 'source.tar.gz'
            subprocess.run(['git', '-C', str(args.repo), 'archive', '--format=tar.gz', '--output=' + str(source.resolve()), sha], check=True)
            plan['source_archive_sha256'] = hashlib.sha256(source.read_bytes()).hexdigest()
        (args.output / 'manifest.json').write_text(json.dumps(plan, indent=2) + '\n')
        print(json.dumps({'revision': sha, 'services': list(SERVICES), 'database_review_required': plan['database_review_required'], 'output': str(args.output)}, indent=2))
    except (ValueError, subprocess.CalledProcessError, FileExistsError) as error:
        print('Release refused: ' + str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
