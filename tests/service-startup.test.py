"""Verify service ordering and real socket readiness without installing services."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class StartupTests(unittest.TestCase):
    def test_bootstrap_stops_before_package_changes_when_service_is_active(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp); commands = base / 'commands'
            script = base / 'setup.sh'
            script.write_text((ROOT / 'deploy/ubuntu/setup.sh').read_text().replace('root=/home/niwa/niwa', 'root=' + str(base)))
            stubs = {'id': 'echo 0', 'stat': 'echo niwa', 'systemctl': 'exit 0',
                     'apt-get': 'echo unexpected >> "$COMMANDS"', 'python3': 'echo unexpected >> "$COMMANDS"'}
            for name, body in stubs.items():
                path = base / name; path.write_text('#!/bin/sh\n' + body + '\n'); path.chmod(0o755)
            result = subprocess.run(['sh', str(script)], env=dict(os.environ, PATH=str(base)+':/usr/bin:/bin',
                                    COMMANDS=str(commands)), capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('already running', result.stderr)
            self.assertFalse(commands.exists())

    def test_daily_service_order(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp); commands = base / 'commands'
            for name, body in {
                'id': 'echo 0',
                'systemctl': 'echo system "$*" >> "$COMMANDS"',
                'runuser': 'echo executor "$*" >> "$COMMANDS"',
            }.items():
                path = base / name; path.write_text('#!/bin/sh\n' + body + '\n'); path.chmod(0o755)
            env = dict(os.environ, PATH=str(base) + ':/usr/bin:/bin', COMMANDS=str(commands))
            subprocess.run(['sh', str(ROOT / 'deploy/ubuntu/services.sh'), 'restart'], env=env, check=True)
            lines = commands.read_text().splitlines()
            self.assertIn('stop niwa.service', lines[0])
            self.assertIn('stop niwa-workspace.service', lines[1])
            self.assertIn('stop niwa-executor.service', lines[2])
            self.assertIn('start user@0.service', lines[3])
            self.assertIn('start niwa-executor.service', lines[4])
            self.assertIn('start niwa-workspace.service', lines[5])
            self.assertIn('start niwa.service', lines[6])

    def test_readiness_waits_for_real_brokers_and_rejects_unsafe_socket(self):
        probe = subprocess.run(['unshare', '--user', '--map-auto', '--map-root-user', 'true'], capture_output=True)
        if probe.returncode: self.skipTest('Subordinate UID mapping unavailable')
        result = subprocess.run(['unshare', '--user', '--map-auto', '--map-root-user', 'python3', '-', str(ROOT)],
            input=r'''
import json, os, subprocess, sys, tempfile
from pathlib import Path
root = Path(sys.argv[1])
with tempfile.TemporaryDirectory(prefix='niwa-ready-') as temp:
    base = Path(temp); base.chmod(0o755)
    (base/'config').mkdir(); (base/'runtime/sockets').mkdir(parents=True)
    sockets=base/'runtime/sockets'; sockets.chmod(0o770); os.chown(sockets, 1, 1)
    (base/'config/niwa.json').write_text(json.dumps(dict(version=1,origin='http://127.0.0.1:3210',port=3210,
         workspaceExecutorUid=1, programExecutorUid=1)))
    source=(root/'deploy/ubuntu/wait-executors.mjs').read_text().replace("'../../dist/", "'"+str(root)+"/dist/")
    source=source.replace("const root = '/home/niwa/niwa';", 'const root = '+json.dumps(str(base))+';')
    source=source.replace('45_000', '2_000')
    script=base/'wait.mjs'; script.write_text(source)
    # UID1 starts both HTTP Unix sockets after a delay. The application process is namespace UID0.
    server="""const http=require('node:http'); process.setgid(1); process.setuid(1);
setTimeout(()=>{for(const name of ['workspace','program']) {
  const path=process.argv[1]+'/'+name+'.sock';
  http.createServer((req,res)=>res.writeHead(400).end()).listen(path,()=>require('node:fs').chmodSync(path,432));
}}, 300);"""
    child=subprocess.Popen(['node','-e',server,str(sockets)])
    try:
        subprocess.run(['node',str(script)],check=True,capture_output=True)
        sockets.chmod(0o777)
        rejected=subprocess.run(['node',str(script)],capture_output=True)
        assert rejected.returncode != 0 and b'not protected' in rejected.stderr, rejected
    finally:
        child.terminate(); child.wait(timeout=5)
''', text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == '__main__':
    unittest.main()
