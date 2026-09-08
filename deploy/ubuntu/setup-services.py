#!/usr/bin/env python3
"""New local installation, or resume verified stages without replacing user data."""
import json
import os
from pathlib import Path
import pwd
import re
import stat
import subprocess
import tempfile
import time
import urllib.request

ROOT = Path('/home/niwa/niwa')
DEPLOY = ROOT / 'deploy/ubuntu'
SYSTEM = Path('/etc/systemd/system')
CHECKS = {'program-boundaries', 'workspace-enospc', 'executor-enospc', 'memory-limit', 'pid-limit', 'timeout', 'cancellation'}


def require(ok, message):
    if not ok:
        raise RuntimeError(message)


def run(*args, capture=False):
    return subprocess.run(list(map(str, args)), check=True, text=True,
                          stdout=subprocess.PIPE if capture else None).stdout


def as_user(name, *args, capture=False):
    identity = pwd.getpwnam(name)
    env = ['PATH=/usr/bin:/bin', f'HOME={identity.pw_dir}']
    if name == 'niwa-exec':
        env += [f'XDG_RUNTIME_DIR=/run/user/{identity.pw_uid}',
                f'DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/{identity.pw_uid}/bus']
    return run('runuser', '-u', name, '--', 'env', '-i', *env, *args, capture=capture)


def real_file(path):
    for parent in path.parents:
        require(stat.S_ISDIR(parent.lstat().st_mode), f'Not a real directory: {parent}')
    require(stat.S_ISREG(path.lstat().st_mode), f'Not a regular file: {path}')


def managed_file(path, content, uid=0, gid=0, mode=0o644):
    for parent in path.parents:
        if os.path.lexists(parent):
            require(stat.S_ISDIR(parent.lstat().st_mode), f'Not a real directory: {parent}')
    path.parent.mkdir(parents=True, exist_ok=True)
    if os.path.lexists(path):
        real_file(path)
        require(path.read_text() == content, f'Existing file differs; review before replacing: {path}')
        require((path.stat().st_uid, path.stat().st_gid, stat.S_IMODE(path.stat().st_mode)) == (uid, gid, mode),
                f'Unexpected owner or mode: {path}')
        return
    for parent in path.parents:
        require(stat.S_ISDIR(parent.lstat().st_mode), f'Not a real directory: {parent}')
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    with os.fdopen(fd, 'w') as file:
        os.fchown(file.fileno(), uid, gid)
        file.write(content)


def validate_receipt(receipt, reference):
    require(receipt.get('reference') == reference, 'Acceptance reference differs from image lock')
    require(isinstance(receipt.get('image'), str) and re.fullmatch(r'sha256:[a-f0-9]{64}', receipt['image']), 'Invalid acceptance image ID')
    require(CHECKS <= set(receipt.get('checks', [])) and receipt.get('verified_at'), 'Incomplete program acceptance')
    return receipt['image']


def verify_storage():
    for name, target, gib in [('workspace', ROOT / 'workspace', 8), ('executor', ROOT / 'runtime/executor', 16)]:
        image = ROOT / f'runtime/volumes/{name}.img'
        real_file(image)
        require(image.stat().st_uid == 0, f'Unexpected image owner: {image}')
        unit = run('systemd-escape', '--path', '--suffix=mount', target, capture=True).strip()
        run('systemctl', 'start', unit)
        source = run('findmnt', '-n', '-o', 'SOURCE', '--mountpoint', target, capture=True).strip()
        require(source.startswith('/dev/loop'), f'Unexpected mount source: {target}')
        backing = run('losetup', '--noheadings', '--output', 'BACK-FILE', source, capture=True).strip()
        require(backing == str(image), f'Unexpected loop backing file: {target}')
        options = run('findmnt', '-n', '-o', 'OPTIONS', '--mountpoint', target, capture=True).strip().split(',')
        require({'nosuid', 'nodev'} <= set(options), f'Missing mount restrictions: {target}')
        fs = os.statvfs(target)
        require(fs.f_blocks * fs.f_frsize <= gib * 1024**3, f'Missing capacity boundary: {target}')
    uid = pwd.getpwnam('niwa-exec').pw_uid
    dependencies = (SYSTEM / f'user@{uid}.service.d/niwa-storage.conf').read_text()
    for target in (ROOT / 'workspace', ROOT / 'runtime/executor'):
        unit = run('systemd-escape', '--path', '--suffix=mount', target, capture=True).strip()
        require(all(unit in line.split('=', 1)[1].split() for line in dependencies.splitlines()
                    if line.startswith(('Requires=', 'After=')))
                and 'Requires=' in dependencies and 'After=' in dependencies, 'Missing user-manager mount dependency')
    print('PASS: existing bounded volumes verified', flush=True)


def install():
    require(os.geteuid() == 0, 'Run setup.sh with sudo')
    os.chdir(ROOT)
    owner = pwd.getpwnam('niwa')
    marker = ROOT / 'runtime/services-installed.json'
    if (ROOT / 'state/control.db').exists():
        require(marker.exists(), 'Existing application data requires review; this is a new-install setup')
    require(not (ROOT / 'runtime/sockets/service-lock.db').is_symlink(), 'Unsafe service lock')
    print('== Build as niwa ==', flush=True)
    as_user('niwa', 'npm', 'ci')
    as_user('niwa', 'npm', 'run', 'build')
    try:
        executor = pwd.getpwnam('niwa-exec')
    except KeyError:
        run('sh', DEPLOY / 'prepare-executor.sh', '--apply')
        executor = pwd.getpwnam('niwa-exec')
    require(executor.pw_dir == str(ROOT / 'runtime/executor/home') and executor.pw_uid > 0, 'Unexpected executor identity')
    # Mount already-prepared storage before checking private executor paths after a reboot.
    if (ROOT / 'runtime/volumes').exists():
        verify_storage()
    run('sh', DEPLOY / 'prepare-executor-session.sh', '--apply')
    if not (ROOT / 'runtime/volumes').exists():
        run('python3', DEPLOY / 'prepare-disks.py', '--apply')
        verify_storage()
    run('python3', DEPLOY / 'prepare-container-access.py', '--apply')
    as_user('niwa', 'sh', DEPLOY / 'check-prerequisites.sh')
    receipt_path = ROOT / 'runtime/executor/state/program-acceptance.json'
    if not os.path.lexists(receipt_path):
        run('sh', DEPLOY / 'prepare-program.sh', '--apply')
    real_file(receipt_path)
    require(receipt_path.stat().st_uid == executor.pw_uid and not receipt_path.stat().st_mode & 0o077, 'Unsafe acceptance receipt')
    reference = json.loads((DEPLOY / 'program-image.json').read_text())['reference']
    image = validate_receipt(json.loads(receipt_path.read_text()), reference)
    inspected = json.loads(as_user('niwa-exec', 'podman', 'image', 'inspect', image, capture=True))[0]
    local_id = inspected['Id'].removeprefix('sha256:')
    require(local_id == image.removeprefix('sha256:') and inspected['Digest'] == reference.split('@')[1]
            and inspected['Os'] == 'linux' and inspected['Architecture'] == 'amd64', 'Accepted local image differs')
    print('PASS: saved container acceptance and local image match', flush=True)
    config_path = ROOT / 'config/niwa.json'
    if not os.path.lexists(config_path):
        as_user('niwa', '/usr/bin/node', ROOT / 'dist/entrypoints/server.js', '--root', ROOT,
                '--init', '--origin', 'http://127.0.0.1:3210')
    real_file(config_path)
    require(config_path.stat().st_uid == owner.pw_uid and not config_path.stat().st_mode & 0o077, 'Unsafe application configuration')
    config = json.loads(config_path.read_text())
    require(config.get('origin') == 'http://127.0.0.1:3210' and config.get('port') == 3210,
            'This setup targets the local default origin and port')
    require(not any(config.get(key) for key in ('browserExecutorUid', 'packagesEnabled', 'xAccountId')), 'Additional features need separate acceptance')
    for key in ('workspaceExecutorUid', 'programExecutorUid'):
        require(config.get(key) in (None, executor.pw_uid), f'Unexpected {key}')
    original = config_path.read_text()
    config.update(workspaceExecutorUid=executor.pw_uid, programExecutorUid=executor.pw_uid)
    updated = json.dumps(config, indent=2) + '\n'
    # Validate with the application's actual schema before replacing its configuration.
    with tempfile.TemporaryDirectory(prefix='niwa-config-') as temp:
        candidate = Path(temp) / 'config'; candidate.mkdir()
        (candidate / 'niwa.json').write_text(updated)
        run('/usr/bin/node', '--input-type=module', '-e',
            'import {readInstallation} from "./dist/config/installation.js"; readInstallation(process.argv[1])', temp)
    if updated != original:
        backup = config_path.with_name('niwa.before-services.json')
        if not backup.exists():
            managed_file(backup, original, owner.pw_uid, owner.pw_gid, 0o600)
        fd, staged = tempfile.mkstemp(prefix='.niwa-', dir=config_path.parent)
        try:
            with os.fdopen(fd, 'w') as file:
                os.fchown(file.fileno(), owner.pw_uid, owner.pw_gid); file.write(updated)
            os.replace(staged, config_path)
        finally:
            if os.path.exists(staged): os.unlink(staged)
    managed_file(ROOT / 'config/executor.env', f'NIWA_PROGRAM_IMAGE={image}\n', 0, executor.pw_gid, 0o640)
    run('setfacl', '-m', f'u:{executor.pw_uid}:--x', ROOT / 'config')
    user_unit = Path(executor.pw_dir) / '.config/systemd/user/niwa-executor.service'
    # Create parents as their dedicated owner; never recursively chown executor data.
    as_user('niwa-exec', 'mkdir', '-p', user_unit.parent)
    managed_file(user_unit, (DEPLOY / 'systemd/niwa-executor.service').read_text(), executor.pw_uid, executor.pw_gid)
    for name in ('niwa.service', 'niwa-workspace.service'):
        managed_file(SYSTEM / name, (DEPLOY / 'systemd' / name).read_text())
    managed_file(SYSTEM / 'niwa.service.d/executor.conf',
                 f'[Unit]\nRequires=user@{executor.pw_uid}.service\nAfter=user@{executor.pw_uid}.service\n')
    run('systemd-analyze', 'verify', SYSTEM / 'niwa.service', SYSTEM / 'niwa-workspace.service')
    as_user('niwa-exec', 'systemd-analyze', '--user', 'verify', user_unit)
    run('systemctl', 'daemon-reload')
    as_user('niwa-exec', 'systemctl', '--user', 'daemon-reload')
    as_user('niwa-exec', 'systemctl', '--user', 'enable', 'niwa-executor.service')
    run('systemctl', 'enable', 'niwa-workspace.service', 'niwa.service')
    managed_file(marker, json.dumps({'executor_uid': executor.pw_uid, 'image': image}) + '\n', mode=0o600)
    run('sh', DEPLOY / 'services.sh', 'start')
    http = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    for _ in range(30):
        try:
            with http.open('http://127.0.0.1:3210/', timeout=2) as response:
                require(response.status == 200, 'Unexpected application response')
            break
        except OSError:
            time.sleep(1)
    else:
        raise RuntimeError('Application did not become ready; inspect journalctl -u niwa.service')
    with http.open('http://127.0.0.1:3210/api/session', timeout=2) as response:
        require(json.load(response) == {'authenticated': False}, 'Unexpected unauthenticated session response')
    run('systemctl', 'is-active', 'niwa.service', 'niwa-workspace.service')
    as_user('niwa-exec', 'systemctl', '--user', 'is-active', 'niwa-executor.service')
    print('PASS: Niwa services installed, enabled and responding at http://127.0.0.1:3210/', flush=True)
    print('Login key: run cat /home/niwa/niwa/secrets/admin-key in your own niwa terminal. No key was printed here.')


if __name__ == '__main__':
    try:
        install()
    except (RuntimeError, OSError, ValueError, subprocess.CalledProcessError) as error:
        raise SystemExit(f'Setup stopped: {error}')
