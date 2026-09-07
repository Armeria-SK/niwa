"""Synthetic host preparation checks; no real login/user/service operations."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'deploy/ubuntu/prepare-executor-session.sh'


class SessionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='niwa-session-')
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root = self.base / 'home/niwa'
        self.bin = self.base / 'bin'
        self.bin.mkdir()
        self.log = self.base / 'mutations'
        self.env = dict(os.environ, PATH=f'{self.bin}:/usr/bin:/bin', ACTIONS=str(self.log))
        for name in ('runtime/executor/home', 'runtime/executor/state', 'workspace', 'runtime/sockets'):
            (self.root / name).mkdir(parents=True)
        for name in ('runtime/executor', 'runtime/executor/home', 'runtime/executor/state', 'workspace'):
            (self.root / name).chmod(0o700)
        (self.root / 'runtime/sockets').chmod(0o2770)
        runtime = self.base / f'run/user/{os.getuid()}'
        runtime.mkdir(parents=True)
        runtime.chmod(0o700)
        self.stub('id', f'case "$*" in "-u") echo "${{CALLER_UID:-0}}";; "-u niwa-exec") echo {os.getuid()};; *) echo {os.getgid()};; esac')
        self.stub('getent', f'echo niwa-ipc:x:{os.getgid()}:niwa,niwa-exec')
        self.stub('runuser', '''
if test "$4" = env; then exit "${PODMAN_STATUS:-0}"; fi
case "$5" in
  -w) test "${WRITABLE_APP:-0}" = 1 ;;
  -r) case "$6" in *.js) exit "${MISSING_CODE:-0}";; *) test "${READABLE_PRIVATE:-0}" = 1;; esac ;;
  -x) exit 0 ;;
  *) exit 99 ;;
esac''')
        for command in ('loginctl', 'systemctl'):
            self.stub(command, f'echo "{command} $*" >> "$ACTIONS"')
        self.script = self.base / 'prepare.sh'
        self.script.write_text(SCRIPT.read_text().replace('/home/niwa', str(self.base / 'home'))
                               .replace('/run/user/', str(self.base / 'run/user') + '/'))

    def stub(self, name, body):
        path = self.bin / name
        path.write_text('#!/bin/sh\n' + body + '\n')
        path.chmod(0o755)

    def run_script(self, expected, mutations=False):
        result = subprocess.run(['sh', str(self.script), '--apply'], env=self.env, capture_output=True, text=True)
        self.assertEqual(result.returncode == 0, expected, result.stdout + result.stderr)
        self.assertEqual(self.log.exists(), mutations)

    def test_prepared_host_starts_only_executor_user_manager(self):
        self.run_script(True, mutations=True)
        self.assertEqual(self.log.read_text().splitlines(), [
            'loginctl enable-linger niwa-exec', f'systemctl start user@{os.getuid()}.service'])

    def test_non_root_stops_before_mutation(self):
        self.env['CALLER_UID'] = '1000'
        self.run_script(False)

    def test_wrong_private_permissions_stop_before_mutation(self):
        (self.root / 'runtime/executor/home').chmod(0o755)
        self.run_script(False)

    def test_unsafe_application_access_stops_before_mutation(self):
        for key in ('WRITABLE_APP', 'READABLE_PRIVATE', 'MISSING_CODE'):
            self.env[key] = '1'
            self.run_script(False)
            del self.env[key]

    def test_podman_failure_is_not_reported_as_success(self):
        self.env['PODMAN_STATUS'] = '1'
        self.run_script(False, mutations=True)


if __name__ == '__main__':
    unittest.main()
