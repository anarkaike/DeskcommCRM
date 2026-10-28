import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('release', Path(__file__).with_name('release.py'))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
FORK = 'https://github.com/example/DeskcommCRM.git'


class ReleaseSafetyTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.repo = Path(self.directory.name)
        self.addCleanup(self.directory.cleanup)
        self.run_git('init', '-q', '--initial-branch=main')
        self.run_git('config', 'user.email', 'test@example.invalid')
        self.run_git('config', 'user.name', 'Release test')
        self.run_git('remote', 'add', 'origin', FORK)
        (self.repo / 'file.txt').write_text('initial')
        self.commit()
        self.base = release.git(self.repo, 'rev-parse', 'HEAD')
        self.run_git('update-ref', 'refs/remotes/origin/main', self.base)

    def run_git(self, *args):
        return subprocess.run(['git', '-C', str(self.repo), *args], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)

    def commit(self):
        self.run_git('add', '.')
        self.run_git('commit', '-qm', 'test')

    def test_official_destination_is_refused(self):
        with self.assertRaisesRegex(ValueError, 'official repository'):
            release.check_source(self.repo, 'https://github.com/melgarafael/DeskcommCRM', 'HEAD')

    def test_different_origin_is_refused(self):
        with self.assertRaisesRegex(ValueError, 'origin does not match'):
            release.check_source(self.repo, 'https://github.com/other/DeskcommCRM', 'HEAD')

    def test_untracked_work_is_never_exported(self):
        (self.repo / 'uncommitted.txt').write_text('work')
        with self.assertRaisesRegex(ValueError, 'working changes'):
            release.check_source(self.repo, FORK, 'HEAD', True)

    def test_unpublished_revision_is_refused(self):
        (self.repo / 'file.txt').write_text('new')
        self.commit()
        with self.assertRaises(subprocess.CalledProcessError):
            release.check_source(self.repo, FORK, 'HEAD', True)

    def test_tracked_secret_file_is_refused(self):
        (self.repo / '.env').write_text('FAKE_VALUE=test')
        self.commit()
        with self.assertRaisesRegex(ValueError, 'environment files'):
            release.check_source(self.repo, FORK, 'HEAD')

    def test_plan_tracks_deletions_schema_and_all_runtimes(self):
        (self.repo / 'file.txt').unlink()
        (self.repo / 'supabase').mkdir()
        (self.repo / 'supabase' / 'baseline.sql').write_text('-- test')
        self.commit()
        sha = release.git(self.repo, 'rev-parse', 'HEAD')
        plan = release.make_plan(self.repo, FORK, sha, {s: self.base for s in release.SERVICES})
        self.assertTrue(plan['database_review_required'])
        self.assertEqual(set(plan['services']), {'app', 'worker', 'scheduler'})
        self.assertIn({'status': 'D', 'path': 'file.txt'}, plan['changes']['app'])
        self.assertTrue(all(sha[:12] in s['image'] for s in plan['services'].values()))


if __name__ == '__main__':
    unittest.main()
