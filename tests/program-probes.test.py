"""Validate generated acceptance probes against kernel-backed synthetic limits."""
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

MODULE = (Path(__file__).resolve().parents[1] / 'deploy/ubuntu/program-probes.mjs').as_uri()


def probes(directory):
    code = f'import {{securityProbe,diskProbe,pidProbe}} from {json.dumps(MODULE)}; console.log(JSON.stringify({{security:securityProbe,disk:diskProbe(process.argv[1]),pid:pidProbe}}))'
    result = subprocess.run(['node', '--input-type=module', '-e', code, str(directory)], check=True, text=True, capture_output=True)
    values = json.loads(result.stdout)
    for name, value in values.items():
        compile(value, name, 'exec')
    return values


class ProbeTests(unittest.TestCase):
    def test_security_probe_accepts_real_whitespace_and_rejects_disabled_protections(self):
        code = probes('/tmp')['security']
        for status, allowed in [('NoNewPrivs:\t1\nSeccomp:\t2\n', True),
                                ('NoNewPrivs: 1\nSeccomp: 2\n', True),
                                ('NoNewPrivs:\t0\nSeccomp:\t2\n', False),
                                ('NoNewPrivs:\t1\nSeccomp:\t0\n', False)]:
            setup = f'from types import SimpleNamespace\npathlib=SimpleNamespace(Path=lambda _:SimpleNamespace(read_text=lambda:{status!r}))\n'
            result = subprocess.run(['python3', '-c', setup + code], capture_output=True)
            self.assertEqual(result.returncode == 0, allowed, status)

    def test_disk_probe_observes_real_enospc_and_removes_temporary_file(self):
        with tempfile.TemporaryDirectory(prefix='niwa-disk-probe-') as directory:
            code = probes(directory)['disk']
            script = f'''
import os, subprocess
subprocess.run(['mount','-t','tmpfs','-o','size=1m','tmpfs',{directory!r}],check=True)
exec({code!r})
assert os.listdir({directory!r}) == []
'''
            result = subprocess.run(['unshare', '--user', '--map-root-user', '--mount', 'python3', '-c', script],
                                    text=True, capture_output=True, timeout=15)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_pid_probe_handles_process_limit_and_reaps_all_children(self):
        code = probes('/tmp')['pid']
        script = f'''
import os, resource, signal, time
resource.setrlimit(resource.RLIMIT_NPROC,(12,12))
os.setgid(1); os.setuid(1)
exec({code!r})
try: os.waitpid(-1,os.WNOHANG)
except ChildProcessError: pass
else: raise AssertionError('Child processes remain')
'''
        result = subprocess.run(['unshare', '--user', '--map-auto', '--map-root-user', 'python3', '-c', script],
                                text=True, capture_output=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == '__main__':
    unittest.main()
