"""Allow keep-id namespace root to traverse the two application ancestors."""
import os
from pathlib import Path
import pwd
import subprocess
import sys


def namespace_root_uid(contents, name, uid):
    entries = [line.split(':') for line in contents.splitlines() if line.strip()]
    selected = [entry for entry in entries if entry[0] in (name, str(uid))]
    if len(selected) != 1 or len(selected[0]) != 3:
        raise ValueError('Expected one subordinate UID range for niwa-exec')
    start, count = map(int, selected[0][1:])
    if start < 65536 or count <= uid or start <= uid < start + count:
        raise ValueError('Unsafe or insufficient subordinate UID range')
    for entry in entries:
        if entry is selected[0]:
            continue
        other, length = map(int, entry[1:])
        if start < other + length and other < start + count:
            raise ValueError('Overlapping subordinate UID ranges')
    return start


def allow_traversal(paths, owner_uid, mapped_uid):
    # Validate all targets first. Preserve the ACL mask: never activate dormant grants.
    for path in paths:
        info = path.lstat()
        if path.is_symlink() or not path.is_dir() or info.st_uid != owner_uid:
            raise ValueError(f'Unexpected ancestor ownership or type: {path}')
        if info.st_mode & 0o022 or not info.st_mode & 0o010:
            raise ValueError(f'Unsafe ancestor permissions or missing search mask: {path}')
    subprocess.run(['setfacl', '--no-mask', '-m', f'u:{mapped_uid}:--x',
                    *map(str, paths)], check=True)


def main():
    if sys.argv[1:] != ['--apply']:
        raise ValueError('Usage: python3 prepare-container-access.py --apply')
    executor = pwd.getpwnam('niwa-exec')
    owner = pwd.getpwnam('niwa')
    if os.geteuid() not in (0, owner.pw_uid):
        raise ValueError('Run as niwa or root')
    mapped_uid = namespace_root_uid(Path('/etc/subuid').read_text(), executor.pw_name, executor.pw_uid)
    if any(account.pw_uid == mapped_uid for account in pwd.getpwall()):
        raise ValueError('Subordinate UID is assigned to a login account')
    allow_traversal([Path('/home/niwa'), Path('/home/niwa/niwa')], owner.pw_uid, mapped_uid)
    print(f'PASS: traversal-only ancestor ACL for keep-id namespace root UID {mapped_uid}')


if __name__ == '__main__':
    main()
