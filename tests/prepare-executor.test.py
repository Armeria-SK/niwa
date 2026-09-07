"""Preparation guards with synthetic files and stubbed OS mutations; no root required.

Run: python3 tests/prepare-executor.test.py
"""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / 'deploy/ubuntu/prepare-executor.sh'


class PreparationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='niwa-prepare-')
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.home = self.base / 'home'
        self.root = self.home / 'niwa'
        self.root.mkdir(parents=True)
        self.home.chmod(0o755)
        self.root.chmod(0o755)
        for name in ('.git', 'src', 'deploy'):
            (self.root / name).mkdir()
        (self.root / 'package.json').write_text('{"name":"niwa"}')
        self.source = self.root / 'src/keep.ts'
        self.source.write_text('existing source\n')
        self.bin = self.base / 'bin'
        self.bin.mkdir()
        self.log = self.base / 'actions'
        self.env = dict(os.environ, PATH=f'{self.bin}:/usr/bin:/bin', ACTIONS=str(self.log))
        self.stub('id', f'if test "${{2-}}" = niwa; then echo {os.getuid()}; else echo "${{CALLER_UID:-0}}"; fi')
        self.stub('uname', 'echo x86_64')
        self.stub('node', 'exit "${NODE_STATUS:-0}"')
        self.stub('getent', 'test "${EXISTING_IDENTITY:-}" = "$*"')
        self.stub('grep', 'exit 0')  # synthetic subordinate UID/GID allocation
        for command in ('apt-get', 'groupadd', 'useradd', 'usermod', 'install', 'setfacl'):
            self.stub(command, f'printf "%s\\n" "{command} $*" >> "$ACTIONS"')
        # Patch only a temporary copy; production paths are never configurable by env.
        self.script = self.base / 'prepare.sh'
        self.script.write_text(SCRIPT.read_text().replace('/home/niwa', str(self.home))
                               .replace('/usr/bin/node', str(self.bin / 'node')))

    def stub(self, name, body):
        target = self.bin / name
        target.write_text('#!/bin/sh\n' + body + '\n')
        target.chmod(0o755)

    def run_script(self, *args, success=False):
        result = subprocess.run(['sh', str(self.script), *args], env=self.env,
                                text=True, capture_output=True)
        self.assertEqual(result.returncode == 0, success, result.stdout + result.stderr)
        self.assertEqual(self.source.read_text(), 'existing source\n')
        if not success or args == ('--check',):
            self.assertFalse(self.log.exists(), 'OS mutations occurred during preflight')
        return result

    def test_check_preserves_checkout_without_mutations(self):
        self.env['CALLER_UID'] = '1000'
        self.run_script('--check', success=True)

    def test_apply_targets_only_new_runtime_workspace_and_traversal_acls(self):
        self.run_script('--apply', success=True)
        actions = self.log.read_text().splitlines()
        self.assertTrue(any(line.startswith('apt-get install ') for line in actions))
        directories = [line.split()[-1] for line in actions if line.startswith('install ')]
        self.assertEqual(directories, [str(self.root / p) for p in (
            'runtime', 'runtime/executor/state', 'runtime/sockets', 'workspace')])
        self.assertFalse(any('/app' in line or ' -R ' in line for line in actions))

    def test_usage_and_non_root_apply(self):
        self.run_script()
        self.run_script('--check', 'unexpected')
        self.env['CALLER_UID'] = '1000'
        self.run_script('--apply')

    def test_existing_data_or_dangling_symlink_is_rejected(self):
        for name in ('runtime', 'workspace'):
            with self.subTest(path=name):
                target = self.root / name
                target.mkdir()
                (target / 'keep').write_text('data')
                self.run_script('--apply')
                self.assertEqual((target / 'keep').read_text(), 'data')
                (target / 'keep').unlink()
                target.rmdir()
                target.symlink_to(self.base / 'absent')
                self.run_script('--apply')
                target.unlink()

    def test_unsafe_checkout_or_home_permissions(self):
        for target in (self.root, self.home):
            target.chmod(0o775)
            self.run_script('--apply')
            target.chmod(0o755)

    def test_wrong_owner(self):
        self.stub('stat', 'echo 999999')
        self.run_script('--apply')

    def test_redirected_checkout(self):
        original = self.home / 'saved'
        self.root.rename(original)
        self.root.symlink_to(original, target_is_directory=True)
        self.run_script('--apply')

    def test_missing_checkout_marker(self):
        (self.root / '.git').rmdir()
        self.run_script('--apply')

    def test_existing_execution_identities(self):
        for name in ('passwd niwa-exec', 'group niwa-ipc', 'group niwa-exec'):
            self.env['EXISTING_IDENTITY'] = name
            self.run_script('--apply')

    def test_incompatible_node(self):
        self.env['NODE_STATUS'] = '1'
        self.run_script('--apply')

    def test_missing_subordinate_ids_stop_before_directory_changes(self):
        for allocation in ('/etc/subuid', '/etc/subgid'):
            self.stub('grep', f'test "${{3-}}" != "{allocation}"')
            result = subprocess.run(['sh', str(self.script), '--apply'], env=self.env,
                                    text=True, capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(any(line.startswith(('install ', 'setfacl '))
                                 for line in self.log.read_text().splitlines()))
            self.log.unlink()


if __name__ == '__main__':
    unittest.main()
