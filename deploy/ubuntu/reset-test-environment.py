#!/usr/bin/env python3
"""Explicitly erase test data; preserve installation, credentials and executor journals."""
import argparse
import hashlib
import json
import re
import time
import urllib.request
import urllib.parse
import os
from pathlib import Path
import pwd
import shutil
import sqlite3
import subprocess
import tempfile

ROOT = Path('/home/niwa/niwa')


def run(*args):
    subprocess.run(list(map(str, args)), check=True)


def validate(root):
    for name in ('state', 'workspace', 'config', 'secrets', 'runtime'):
        path = root / name
        if not path.is_dir() or any(p.is_symlink() for p in (path, *path.parents)):
            raise RuntimeError('Expected real installation directories')
    db = root / 'state/control.db'
    if not db.is_file() or db.is_symlink():
        raise RuntimeError('Existing control database required')
    if not os.path.ismount(root / 'workspace'):
        raise RuntimeError('Expected bounded workspace mount; no data removed')
    workspace_entries(root / 'workspace')


def workspace_entries(workspace):
    # Refuse nested mounts, including same-filesystem bind mounts. Do not follow links.
    for line in Path('/proc/self/mountinfo').read_text().splitlines():
        target = Path(re.sub(r'\\([0-7]{3})', lambda m: chr(int(m[1], 8)), line.split()[4]))
        if target != workspace and target.is_relative_to(workspace):
            raise RuntimeError('Unexpected nested mount; no data removed')
    device = workspace.stat().st_dev
    for path, dirs, files in os.walk(workspace, followlinks=False):
        for name in dirs + files:
            item = Path(path) / name
            if item.lstat().st_dev != device or (not item.is_symlink() and os.path.ismount(item)):
                raise RuntimeError('Unexpected nested mount; no data removed')
    return [p for p in workspace.iterdir() if p.name != 'lost+found']


def fingerprint(root):
    result = {}
    for directory in ('config', 'secrets'):
        for path in sorted((root / directory).rglob('*')):
            if path.is_symlink():
                raise RuntimeError('Unexpected link in configuration')
            if path.is_file():
                result[str(path.relative_to(root))] = hashlib.sha256(path.read_bytes()).digest()
    return result


def wait_http(root):
    config = json.loads((root / 'config/niwa.json').read_text())
    http = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    request = urllib.request.Request(f"http://127.0.0.1:{config['port']}/api/session",
                                     headers={'Host': urllib.parse.urlsplit(config['origin']).netloc})
    for _ in range(30):
        try:
            with http.open(request, timeout=2) as response:
                if response.status == 200 and json.load(response) == {'authenticated': False}:
                    return
        except OSError:
            pass
        time.sleep(1)
    raise RuntimeError('Application did not become ready')


def reset(root, apply=False):
    validate(root)
    with sqlite3.connect(f'file:{root}/state/control.db?mode=ro', uri=True) as db:
        print('Task states:', db.execute('SELECT state,count(*) FROM tasks GROUP BY state').fetchall())
    print('Delete: conversations, Bots, memories, artifacts, tasks, schedules and workspace files.')
    print('Keep: authentication, settings, common rules, model choices, images, catalogs, journals and existing backups.')
    if not apply:
        print('Check only. Use --apply to erase test data, rebuild and restart.')
        return
    identity = pwd.getpwnam('niwa')
    services = root / 'deploy/ubuntu/services.sh'
    protected = fingerprint(root)
    stage = None
    run('sh', services, 'stop')
    try:
        # The helper imports this newly built Runtime; build failure precedes any deletion.
        subprocess.run(['runuser', '-u', 'niwa', '--', 'npm', 'run', 'build'], cwd=root, check=True)
        stage = Path(tempfile.mkdtemp(prefix='reset-test-', dir=root / 'runtime'))
        os.chown(stage, identity.pw_uid, identity.pw_gid)
        run('runuser', '-u', 'niwa', '--', 'node', root / 'deploy/ubuntu/reset-test-state.mjs', root / 'state', stage / 'state')
        validate(root)
        if fingerprint(root) != protected:
            raise RuntimeError('Configuration changed; no data removed')
        for path in workspace_entries(root / 'workspace'):
            if path.is_dir() and not path.is_symlink():
                shutil.rmtree(path)
            else:
                path.unlink()
        (root / 'state').rename(stage / 'old-state')
        (stage / 'state').rename(root / 'state')
        run('sh', services, 'start')
        run('runuser', '-u', 'niwa', '--', 'node', root / 'deploy/ubuntu/wait-executors.mjs')
        run('systemctl', 'is-active', 'niwa.service', 'niwa-workspace.service')
        wait_http(root)
        shutil.rmtree(stage)
        print('PASS: test data reset, fresh leader created, Niwa rebuilt and restarted')
    except Exception:
        run('sh', services, 'stop')
        print('Reset stopped. Inspect before restarting. Temporary state:', stage or 'not created')
        raise


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true', help='permanently erase test data and restart')
    args = parser.parse_args()
    if os.geteuid() != 0:
        parser.error('Run with sudo, including check-only mode.')
    reset(ROOT, args.apply)
