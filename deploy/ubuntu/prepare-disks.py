#!/usr/bin/env python3
"""Initial bounded storage setup. Keeps original trees underneath the new mounts."""
import argparse
import os
from pathlib import Path
import pwd
import shutil
import stat
import subprocess

ROOT = Path('/home/niwa/niwa')
UNITS = Path('/etc/systemd/system')
SIZES = {'workspace': 8, 'executor': 16}  # GiB, including filesystem metadata


def run(*args):
    return subprocess.run([str(arg) for arg in args], check=True, text=True, capture_output=True).stdout.strip()


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def write_unit(path, content):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
    with os.fdopen(descriptor, 'w') as file:
        file.write(content)


def directory(path):
    for item in (path, *path.parents):
        require(stat.S_ISDIR(item.lstat().st_mode), f'Not a real directory: {item}')


def require_unmounted(path):
    # util-linux: 0 = mounted, 32 = not mounted, 1 = invocation/permission/system error.
    status = subprocess.run(['mountpoint', '-q', str(path)], capture_output=True).returncode
    require(status == 32, f'Already mounted or inaccessible (mountpoint exit {status}): {path}')


def mount_unit(image, target):
    return f'''[Unit]
Description=Niwa bounded storage for {target.name}
RequiresMountsFor={image.parent}

[Mount]
What={image}
Where={target}
Type=ext4
Options=loop,nosuid,nodev,nodiscard
TimeoutSec=90

[Install]
WantedBy=multi-user.target
'''


def reserve_check(available, sizes):
    required = sum(sizes.values()) * 1024**3 + 2 * 1024**3
    require(available >= required, 'Insufficient free disk space for reserved volumes and 2 GiB margin')


def prepare():
    require(os.geteuid() == 0, 'Run with sudo; administrator authentication is required')
    identity = pwd.getpwnam('niwa-exec')
    uid, gid = identity.pw_uid, identity.pw_gid
    require(uid > 0, 'Dedicated non-root identity required')
    home = ROOT / 'runtime/executor/home'
    require(identity.pw_dir == str(home), 'Unexpected executor HOME')
    targets = {'workspace': ROOT / 'workspace', 'executor': ROOT / 'runtime/executor'}
    volumes = ROOT / 'runtime/volumes'
    units = UNITS
    dropin = units / f'user@{uid}.service.d'
    config = dropin / 'niwa-storage.conf'
    names = {key: run('systemd-escape', '--path', '--suffix=mount', target) for key, target in targets.items()}
    for command in ('rsync', 'fallocate', 'mkfs.ext4', 'mount', 'umount', 'mountpoint', 'findmnt', 'systemctl', 'pgrep', 'runuser', 'du', 'sync'):
        require(shutil.which(command), f'Missing command: {command}')
    directory(ROOT / 'runtime')
    directory(units)
    require(not os.path.lexists(volumes), 'Storage preparation already started; inspect runtime/volumes before retrying')
    require(not os.path.lexists(config), 'Existing user-manager storage configuration requires review')
    if dropin.exists() or dropin.is_symlink():
        directory(dropin)
    mounts = run('findmnt', '-rn', '-o', 'TARGET').splitlines()
    for key, target in targets.items():
        directory(target)
        info = target.stat()
        require((info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)) == (uid, gid, 0o700), f'Unexpected ownership/mode: {target}')
        require_unmounted(target)
        require(not any(path.startswith(str(target) + '/') for path in mounts), f'Nested mount requires review: {target}')
        require(not os.path.lexists(units / names[key]), f'Existing mount unit: {names[key]}')
        used = int(run('du', '-sx', '-B1', target).split()[0])
        require(used < SIZES[key] * 1024**3 * 0.9, f'Existing data exceeds safe capacity: {target}')
    reserve_check(shutil.disk_usage(ROOT).free, SIZES)
    for service in ('niwa.service', 'niwa-workspace.service'):
        state = subprocess.run(['systemctl', 'is-active', service], capture_output=True, text=True).stdout.strip()
        require(state in ('inactive', 'failed', 'unknown'), f'Stop {service} before storage preparation')
    # Refuse all saved containers, including stopped ones. Do not interrupt user work.
    containers = run('runuser', '-u', 'niwa-exec', '--', 'env', '-i', 'PATH=/usr/bin:/bin',
                     f'HOME={home}', f'XDG_RUNTIME_DIR=/run/user/{uid}',
                     f'DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/{uid}/bus',
                     '/usr/bin/podman', 'ps', '-aq')
    require(not containers, 'Existing containers require review before storage migration')
    require(not os.path.lexists(ROOT / 'runtime/sockets/service-lock.db'), 'Existing application lock requires review; never delete it to proceed')
    print('Checks passed. Reserving 8 GiB workspace + 16 GiB executor volumes.', flush=True)
    volumes.mkdir(mode=0o700)
    for key in targets:
        image = volumes / f'{key}.img'
        with image.open('xb'):
            pass
        image.chmod(0o600)
        run('fallocate', '-l', str(SIZES[key] * 1024**3), image)
        run('mkfs.ext4', '-q', '-m', '0', '-E', 'nodiscard', image)
        # Formatting may create sparse ranges even with discard disabled; reserve them again.
        run('fallocate', '-l', str(SIZES[key] * 1024**3), image)
        require(image.stat().st_blocks * 512 >= SIZES[key] * 1024**3, f'Volume reservation was not retained: {image}')
    run('systemctl', 'stop', f'user@{uid}.service')
    remaining = subprocess.run(['pgrep', '-u', str(uid)], capture_output=True)
    require(remaining.returncode == 1, 'Executor processes remain; left stopped for review')
    # Copy and verify before hiding either original directory. On failure, originals remain.
    for key, target in targets.items():
        stage = volumes / f'{key}-stage'
        stage.mkdir(mode=0o700)
        run('mount', '-o', 'loop,nosuid,nodev,nodiscard', volumes / f'{key}.img', stage)
        try:
            run('rsync', '-aHAXS', f'{target}/', f'{stage}/')
            require(not run('rsync', '-aHAXnci', f'{target}/', f'{stage}/'), f'Copy verification failed: {target}')
            os.chown(stage, uid, gid)
            stage.chmod(0o700)
            run('sync', '-f', stage)
        finally:
            run('umount', stage)
    for key, target in targets.items():
        # Missing mounts must fail closed, never silently use an unbounded directory.
        os.chown(target, 0, 0)
        target.chmod(0)
        write_unit(units / names[key], mount_unit(volumes / f'{key}.img', target))
    dropin.mkdir(mode=0o755, exist_ok=True)
    write_unit(config, '[Unit]\nRequires=' + ' '.join(names.values()) + '\nAfter=' + ' '.join(names.values()) + '\n')
    run('systemctl', 'daemon-reload')
    run('systemctl', 'enable', '--now', *names.values())
    for key, target in targets.items():
        require(run('findmnt', '-rn', '-M', target, '-o', 'FSTYPE') == 'ext4', f'Expected mounted ext4: {target}')
        require(shutil.disk_usage(target).total <= SIZES[key] * 1024**3, f'Disk bound not applied: {target}')
    run('systemctl', 'start', f'user@{uid}.service')
    print('PASS: bounded ext4 mounts and user-manager dependencies; original data retained underneath mounts')
    print('Container isolation and ENOSPC acceptance remain required. No Niwa service or container started.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true', required=True)
    parser.parse_args()
    try:
        prepare()
    except (RuntimeError, OSError, subprocess.CalledProcessError) as error:
        detail = getattr(error, 'stderr', '') or str(error)
        raise SystemExit(f'Storage preparation stopped: {detail}\nDo not delete existing files to bypass a check. Inspect state before retrying.')
