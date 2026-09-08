"""Installer validation and resume tests using synthetic files; no OS installation."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / 'deploy/ubuntu/setup-services.py'
spec = importlib.util.spec_from_file_location('setup_services', SOURCE)
setup = importlib.util.module_from_spec(spec); spec.loader.exec_module(setup)
IMAGE = 'sha256:' + 'a' * 64
REFERENCE = 'docker.io/library/python@sha256:' + 'b' * 64


def receipt():
    return dict(image=IMAGE, reference=REFERENCE, checks=sorted(setup.CHECKS), verified_at='2026-09-08T01:00:00Z')


class SetupTests(unittest.TestCase):
    def test_rejects_incomplete_or_different_acceptance(self):
        self.assertEqual(setup.validate_receipt(receipt(), REFERENCE), IMAGE)
        for field, value in [('image', 'python:latest'), ('reference', 'other'), ('checks', []), ('verified_at', '')]:
            data = receipt(); data[field] = value
            with self.subTest(field=field), self.assertRaises(RuntimeError):
                setup.validate_receipt(data, REFERENCE)

    def test_existing_files_never_overwritten_or_followed(self):
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp) / 'unit'
            setup.managed_file(target, 'original', os.getuid(), os.getgid(), 0o600)
            setup.managed_file(target, 'original', os.getuid(), os.getgid(), 0o600)
            with self.assertRaises(RuntimeError):
                setup.managed_file(target, 'replacement', os.getuid(), os.getgid(), 0o600)
            link = Path(temp) / 'link'; link.symlink_to(target)
            with self.assertRaises(RuntimeError):
                setup.managed_file(link, 'original', os.getuid(), os.getgid(), 0o600)
            self.assertEqual(target.read_text(), 'original')

    def test_resume_uses_receipt_and_starts_only_after_configuration(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); deploy = root / 'deploy/ubuntu'; deploy.mkdir(parents=True)
            (deploy / 'systemd').mkdir()
            for name in ['niwa.service', 'niwa-workspace.service', 'niwa-executor.service']:
                (deploy / 'systemd' / name).write_text('[Service]\nType=exec\n')
            (deploy / 'program-image.json').write_text(json.dumps(dict(reference=REFERENCE)))
            for name in ['runtime/volumes', 'runtime/executor/state', 'runtime/executor/home', 'config', 'state']:
                (root / name).mkdir(parents=True, exist_ok=True)
            accepted = root / 'runtime/executor/state/program-acceptance.json'
            accepted.write_text(json.dumps(receipt())); accepted.chmod(0o600)
            config_path = root / 'config/niwa.json'
            original = json.dumps(dict(version=1, origin='http://127.0.0.1:3210', port=3210))
            config_path.write_text(original); config_path.chmod(0o600)
            calls = []
            def command(*args, capture=False):
                calls.append(tuple(map(str, args)))
                if str(args[-1]) == 'start':
                    self.assertEqual(json.loads(config_path.read_text())['programExecutorUid'], os.getuid())
                return ''
            def user(name, *args, capture=False):
                calls.append((name, *map(str, args)))
                if args[:3] == ('podman', 'image', 'inspect'):
                    return json.dumps([dict(Id=IMAGE, Digest=REFERENCE.split('@')[1], Os='linux', Architecture='amd64')])
                return ''
            def identity(name):
                return types.SimpleNamespace(pw_uid=os.getuid(), pw_gid=os.getgid(),
                    pw_dir=str(root / 'runtime/executor/home' if name == 'niwa-exec' else root))
            write = setup.managed_file
            def local_write(path, content, uid=0, gid=0, mode=0o644):
                return write(path, content, os.getuid(), os.getgid(), mode)
            response = types.SimpleNamespace(status=200, read=lambda: b'{"authenticated":false}')
            from contextlib import nullcontext
            old_cwd = Path.cwd()
            try:
                with patch.multiple(setup, ROOT=root, DEPLOY=deploy, SYSTEM=root / 'units'), \
                     patch.object(setup.os, 'geteuid', return_value=0), \
                     patch.object(setup.pwd, 'getpwnam', side_effect=identity), \
                     patch.object(setup, 'run', side_effect=command), \
                     patch.object(setup, 'as_user', side_effect=user), \
                     patch.object(setup, 'managed_file', side_effect=local_write), \
                     patch.object(setup, 'verify_storage'), \
                     patch.object(setup.urllib.request, 'build_opener', return_value=types.SimpleNamespace(open=lambda *a, **kw: nullcontext(response))):
                    setup.install()
                    # A second stopped-install run preserves the exact configuration and managed files.
                    setup.install()
            finally:
                os.chdir(old_cwd)
            self.assertEqual((root / 'config/niwa.before-services.json').read_text(), original)
            flat = '\n'.join(' '.join(call) for call in calls)
            self.assertNotIn('prepare-disks.py', flat)
            self.assertNotIn('prepare-program.sh', flat)
            self.assertNotIn('prepare-executor.sh', flat)
            self.assertIn('prepare-executor-session.sh', flat)
            self.assertLess(flat.index('daemon-reload'), flat.index('services.sh start'))


if __name__ == '__main__':
    unittest.main()
