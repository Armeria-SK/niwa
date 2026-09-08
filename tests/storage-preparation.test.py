"""Exercise copy/verification ordering with synthetic trees; never mount or alter systemd."""
import importlib.util
from pathlib import Path
import os
import shutil
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('storage', Path(__file__).resolve().parents[1] / 'deploy/ubuntu/prepare-disks.py')
storage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(storage)
real_run = subprocess.run


class StorageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='niwa-storage-')
        self.base = Path(self.temp.name)
        self.root, self.units = self.base / 'product', self.base / 'units'
        self.units.mkdir()
        self.targets = [self.root / 'workspace', self.root / 'runtime/executor']
        for path in self.targets:
            path.mkdir(parents=True); path.chmod(0o700)
            (path / 'keep').write_text('original data')
        self.calls = []
        self.corrupt = False
        self.containers = ''
        self.identity = SimpleNamespace(pw_uid=os.getuid(), pw_gid=os.getgid(), pw_dir=str(self.targets[1] / 'home'))
        self.stack = []
        for target, value in [('ROOT', self.root), ('UNITS', self.units), ('SIZES', {'workspace': 1 / 64, 'executor': 1 / 64})]:
            self.stack.append(patch.object(storage, target, value))
        self.stack.extend([
            patch.object(storage.os, 'geteuid', return_value=0),
            patch.object(storage.pwd, 'getpwnam', return_value=self.identity),
            patch.object(storage.shutil, 'which', return_value='/synthetic/tool'),
            patch.object(storage.shutil, 'disk_usage', return_value=SimpleNamespace(free=100 * 1024**3, total=4 * 1024**2)),
            patch.object(storage.os, 'chown', side_effect=lambda *args: self.calls.append(('chown', *args))),
            patch.object(storage, 'run', side_effect=self.command),
            patch.object(storage.subprocess, 'run', side_effect=self.process),
        ])
        for context in self.stack:
            context.start()
        self.addCleanup(self.cleanup)

    def cleanup(self):
        for context in reversed(self.stack):
            context.stop()
        for target in self.targets:
            target.chmod(0o700)
        self.temp.cleanup()

    def process(self, args, **kwargs):
        if args[0] in ('mountpoint', 'pgrep'):
            return SimpleNamespace(returncode=1)
        if args[:2] == ['systemctl', 'is-active']:
            return SimpleNamespace(stdout='inactive\n')
        raise AssertionError(args)

    def command(self, *args):
        args = tuple(str(arg) for arg in args); self.calls.append(args)
        if args[0] == 'systemd-escape':
            return real_run(args, check=True, capture_output=True, text=True).stdout.strip()
        if args[0] in ('fallocate', 'mkfs.ext4'):
            args = tuple(str(int(float(arg))) if arg.endswith('.0') else arg for arg in args)
            return real_run(args, check=True, capture_output=True, text=True).stdout.strip()
        if args[0] == 'du': return '4096\tpath'
        if args[0] == 'runuser': return self.containers
        if args[0] == 'findmnt': return 'ext4' if '-M' in args else ''
        if args[0] == 'rsync':
            if 'n' in args[1] and self.corrupt: return 'checksum mismatch'
            return real_run(args, check=True, capture_output=True, text=True).stdout.strip()
        return ''

    def test_copies_originals_before_mount_registration_and_restart(self):
        storage.prepare()
        for key, original in zip(('workspace', 'executor'), self.targets):
            self.assertEqual((self.root / f'runtime/volumes/{key}-stage/keep').read_text(), 'original data')
            self.assertEqual(original.stat().st_mode & 0o777, 0)
            original.chmod(0o700)
            self.assertEqual((original / 'keep').read_text(), 'original data')
        copied = max(i for i, call in enumerate(self.calls) if call[0] == 'rsync')
        protected = min(i for i, call in enumerate(self.calls) if call[0] == 'chown' and call[1] in self.targets)
        self.assertLess(copied, protected)
        self.assertEqual(self.calls[-1], ('systemctl', 'start', f'user@{os.getuid()}.service'))
        config = self.units / f'user@{os.getuid()}.service.d/niwa-storage.conf'
        self.assertIn('Requires=', config.read_text())

    def test_failed_copy_keeps_originals_accessible_and_does_not_register_mounts(self):
        self.corrupt = True
        with self.assertRaisesRegex(RuntimeError, 'Copy verification failed'):
            storage.prepare()
        self.assertFalse(list(self.units.iterdir()))
        for original in self.targets:
            self.assertEqual(original.stat().st_mode & 0o777, 0o700)
            self.assertEqual((original / 'keep').read_text(), 'original data')
        self.assertEqual(self.calls[-1][0], 'umount')

    def test_existing_containers_or_preparation_refuse_before_changes(self):
        self.containers = 'saved-container-id'
        with self.assertRaisesRegex(RuntimeError, 'Existing containers'):
            storage.prepare()
        self.assertFalse((self.root / 'runtime/volumes').exists())
        self.containers = ''
        (self.root / 'runtime/volumes').mkdir()
        with self.assertRaisesRegex(RuntimeError, 'already started'):
            storage.prepare()
        self.assertFalse(any(call[:2] == ('systemctl', 'stop') for call in self.calls))

    def test_insufficient_capacity_rejected(self):
        with self.assertRaisesRegex(RuntimeError, 'Insufficient free disk'):
            storage.reserve_check(25 * 1024**3, {'workspace': 8, 'executor': 16})

    def test_existing_application_lock_is_preserved_and_refused(self):
        sockets = self.root / 'runtime/sockets'; sockets.mkdir()
        lock = sockets / 'service-lock.db'; lock.write_text('existing lock')
        with self.assertRaisesRegex(RuntimeError, 'Existing application lock'):
            storage.prepare()
        self.assertEqual(lock.read_text(), 'existing lock')
        self.assertFalse((self.root / 'runtime/volumes').exists())


if __name__ == '__main__':
    unittest.main()
