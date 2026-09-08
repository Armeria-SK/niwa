"""Keep the installed Podman policy, permitting only Chromium's chroot syscall."""
import copy
import grp
import json
import os
from pathlib import Path
import stat
import sys
import tempfile


def browser_policy(source):
    if source.get('defaultAction') != 'SCMP_ACT_ERRNO' or not isinstance(source.get('syscalls'), list):
        raise ValueError('Unexpected host seccomp policy')
    result = copy.deepcopy(source)
    rules = []
    found = False
    for rule in result['syscalls']:
        if 'chroot' in rule['names']:
            found = True
            rule['names'] = [name for name in rule['names'] if name != 'chroot']
        if rule['names']:
            rules.append(rule)
    if not found:
        raise ValueError('Host policy has no chroot rules; review before modifying')
    result['syscalls'] = rules + [{'names': ['chroot'], 'action': 'SCMP_ACT_ALLOW', 'args': []}]
    return result


def main():
    if sys.argv[1:] != ['--apply'] or os.geteuid() != 0:
        raise ValueError('Usage: sudo python3 prepare-browser-seccomp.py --apply')
    target = Path('/home/niwa/niwa/config/browser-seccomp.json')
    for parent in target.parents:
        if not stat.S_ISDIR(parent.lstat().st_mode):
            raise ValueError(f'Unsafe policy directory: {parent}')
    if os.path.lexists(target):
        info = target.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1:
            raise ValueError('Unsafe existing browser policy')
    source = json.loads(Path('/usr/share/containers/seccomp.json').read_text())
    policy = browser_policy(source)
    descriptor, temporary = tempfile.mkstemp(prefix='.browser-seccomp-', dir=target.parent)
    try:
        with os.fdopen(descriptor, 'w') as file:
            os.fchown(file.fileno(), 0, grp.getgrnam('niwa-exec').gr_gid)
            os.fchmod(file.fileno(), 0o640)
            file.write(json.dumps(policy, indent=2) + '\n')
        os.replace(temporary, target)
    finally:
        if os.path.exists(temporary): os.unlink(temporary)
    print('PASS: browser-only seccomp policy; chroot allowed, all other host rules retained; no capabilities added')


if __name__ == '__main__': main()
