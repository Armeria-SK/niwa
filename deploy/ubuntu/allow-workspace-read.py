"""Grant the host login read-only access to shared files; never follow file links."""
import json
import os
from pathlib import Path
import pwd
import stat
import subprocess
import sys
import time

ROOT = Path('/home/niwa/niwa')


def main():
    if sys.argv[1:] != ['--apply'] or os.geteuid() != 0:
        raise SystemExit('Usage: sudo python3 deploy/ubuntu/allow-workspace-read.py --apply')
    reader = pwd.getpwnam('niwa').pw_uid
    executor = pwd.getpwnam('niwa-exec').pw_uid
    for path in (Path('/home'), ROOT.parent, ROOT, ROOT / 'workspace', ROOT / 'backups'):
        if not stat.S_ISDIR(path.lstat().st_mode):
            raise ValueError('Expected real directories, not symbolic links')
    rootfd = os.open(ROOT / 'workspace', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    if os.fstat(rootfd).st_uid != executor:
        os.close(rootfd)
        raise ValueError('Unexpected workspace owner')
    device = os.fstat(rootfd).st_dev
    backup = ROOT / 'backups' / f'workspace-acl-{time.time_ns()}.jsonl'
    out = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    counts = {'directories': 0, 'files': 0, 'skipped': 0}

    def command(fd, *args):
        return subprocess.run([*args, f'/proc/self/fd/{fd}'], pass_fds=(fd,),
                              check=True, capture_output=True, text=True).stdout

    def visit(fd, relative):
        info = os.fstat(fd)
        directory = stat.S_ISDIR(info.st_mode)
        if not (directory or stat.S_ISREG(info.st_mode)):
            counts['skipped'] += 1
            return
        if info.st_dev != device or info.st_uid != executor or (not directory and info.st_nlink != 1):
            counts['skipped'] += 1
            return
        acl = command(fd, 'getfacl', '-c', '-n')
        os.write(out, (json.dumps({'path': relative, 'uid': info.st_uid, 'gid': info.st_gid, 'acl': acl}) + '\n').encode())
        os.fsync(out)  # Preserve the original ACL before each change.
        # Preserve effective grants when widening the mask for the named reader.
        entries = [line.split()[0].split(':') for line in acl.splitlines() if line and not line.startswith(('#', 'default:'))]
        mask = next((set(p) for kind, name, p in entries if kind == 'mask'), set('rwx'))
        changes = []
        for kind, name, permissions in entries:
            if kind == 'group' or (kind == 'user' and name and name != str(reader)):
                effective = ''.join(c if c in permissions and c in mask else '-' for c in 'rwx')
                changes.append(f'{kind}:{name}:{effective}')
        changes.append(f'u:{reader}:{"r-x" if directory else "r--"}')
        command(fd, 'setfacl', '-m', ','.join(changes))
        if directory:
            # New ordinary 0666/0777 and broker 0660/0770 files inherit this reader.
            command(fd, 'setfacl', '-m', f'd:u:{reader}:r-x')
        counts['directories' if directory else 'files'] += 1
        if directory:
            for name in os.listdir(fd):
                if name == 'lost+found':
                    counts['skipped'] += 1
                    continue
                try:
                    entry = os.stat(name, dir_fd=fd, follow_symlinks=False)
                    if not (stat.S_ISDIR(entry.st_mode) or stat.S_ISREG(entry.st_mode)):
                        counts['skipped'] += 1
                        continue
                    child = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
                    try:
                        actual = os.fstat(child)
                        if (actual.st_dev, actual.st_ino) != (entry.st_dev, entry.st_ino):
                            raise ValueError('Workspace entry changed during ACL preparation; retry after review')
                        visit(child, f'{relative}/{name}')
                    finally:
                        os.close(child)
                except FileNotFoundError:
                    counts['skipped'] += 1  # A live producer removed its temporary file.
    try:
        visit(rootfd, '.')
    finally:
        os.close(out)
        os.close(rootfd)
    print('PASS: workspace read ACL and inheritance', json.dumps(counts))
    print('Previous ACLs saved:', backup)


if __name__ == '__main__':
    main()
