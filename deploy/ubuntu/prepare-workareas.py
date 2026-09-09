#!/usr/bin/env python3
"""Opt-in workarea preparation. Dry-run by default; never moves legacy files or restarts services."""
import argparse
import json
import os
from pathlib import Path
import pwd
import re
import stat
import subprocess

ROOT = Path('/home/niwa/niwa')


def prepare(apply=False):
    volume = ROOT / 'runtime/executor'
    target = volume / 'workareas'
    executor = pwd.getpwnam('niwa-exec')
    for path in [volume, *volume.parents]:
        if not stat.S_ISDIR(path.lstat().st_mode):
            raise RuntimeError(f'Not a real directory: {path}')
    mounts = json.loads(subprocess.check_output(['findmnt', '--json', '--mountpoint', str(volume), '--output', 'TARGET,SOURCE,FSTYPE,OPTIONS']))['filesystems']
    if not mounts or any(m['target'] != str(volume) or not m['source'].startswith('/dev/loop') or m['fstype'] != 'ext4' or not {'nosuid', 'nodev'} <= set(m['options'].split(',')) for m in mounts):
        raise RuntimeError('Existing bounded executor volume required')
    fs = os.statvfs(volume)
    if fs.f_blocks * fs.f_frsize > 16 * 1024**3:
        raise RuntimeError('Executor capacity exceeds 16 GiB')
    if os.path.lexists(target):
        info = target.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != executor.pw_uid or info.st_dev != volume.stat().st_dev or info.st_mode & 0o022:
            raise RuntimeError('Unexpected existing workarea ownership, type or mount')
    env_file = ROOT / 'config/executor.env'
    config_file = ROOT / 'config/niwa.json'
    for path in [env_file, config_file]:
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise RuntimeError('Unsafe configuration file')
    env = env_file.read_text()
    lines = env.splitlines()
    options = [i for i, line in enumerate(lines) if line.startswith('NIWA_EXECUTOR_OPTIONS=')]
    if len(options) > 1:
        raise RuntimeError('Duplicate executor options')
    argument = f'--workareas {target}'
    if options:
        index = options[0]
        value = lines[index].split('=', 1)[1]
        if value[:1] in ('"', "'") and value[-1:] == value[:1]:
            value = value[1:-1]
        if any(character in value for character in ['"', "'", "\\", '$', '`']):
            raise RuntimeError('Review nonstandard executor options manually')
        if '--workareas' in value and argument not in value:
            raise RuntimeError('Different workarea root configured')
        if argument not in value:
            lines[index] = f'NIWA_EXECUTOR_OPTIONS="{value} {argument}"'
    else:
        lines.append(f'NIWA_EXECUTOR_OPTIONS="{argument}"')
    config = json.loads(config_file.read_text())
    if config.get('programExecutorUid') != executor.pw_uid:
        raise RuntimeError('Program executor identity mismatch')
    config['workareasEnabled'] = True
    print(f'{"APPLY" if apply else "DRY RUN"}: {target} — niwa-exec only; existing 16 GiB volume')
    print('Add executor --workareas and application capability. Administrator runtime toggle remains unchanged (initially off).')
    print('No legacy files moved. No services restarted. No image or journal replaced.')
    if apply:
        if os.geteuid() != 0:
            raise RuntimeError('Run --apply with sudo')
        target.mkdir(exist_ok=True, mode=0o711)
        os.chown(target, executor.pw_uid, executor.pw_gid)
        os.chmod(target, 0o711)  # Traversal for keep-id namespace root; no listing for other identities.
        for path, content in [(env_file, '\n'.join(lines) + '\n'), (config_file, json.dumps(config, indent=2) + '\n')]:
            temporary = path.with_name(path.name + '.workareas-new')
            info = path.stat()
            fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, stat.S_IMODE(info.st_mode))
            with os.fdopen(fd, 'w') as file:
                os.fchown(file.fileno(), info.st_uid, info.st_gid)
                file.write(content)
                file.flush()
                os.fsync(file.fileno())
            os.replace(temporary, path)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true')
    try:
        prepare(parser.parse_args().apply)
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as error:
        raise SystemExit(str(error))
