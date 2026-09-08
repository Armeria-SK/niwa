"""Real nested user namespace regression for keep-id ancestor traversal."""
import importlib.util
from pathlib import Path
import subprocess
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'deploy/ubuntu/prepare-container-access.py'
spec = importlib.util.spec_from_file_location('container_access', SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ContainerAccessTests(unittest.TestCase):
    def test_subordinate_mapping_and_unsafe_ranges(self):
        self.assertEqual(module.namespace_root_uid('niwa:100000:65536\nniwa-exec:165536:65536\n', 'niwa-exec', 1001), 165536)
        self.assertEqual(module.namespace_root_uid('1001:165536:65536\n', 'niwa-exec', 1001), 165536)
        for source in ('', 'niwa-exec:0:65536', 'niwa-exec:165536:1',
                       'niwa-exec:165536:65536\nother:165537:65536',
                       'niwa-exec:165536:65536\n1001:300000:65536'):
            with self.subTest(source=source), self.assertRaises(ValueError):
                module.namespace_root_uid(source, 'niwa-exec', 1001)

    def test_real_namespace_root_access_preserves_private_boundary(self):
        probe = subprocess.run(['unshare', '--user', '--map-auto', '--map-root-user', 'true'], capture_output=True)
        if probe.returncode:
            self.skipTest('Subordinate UID/GID mapping unavailable')
        result = subprocess.run(['unshare', '--user', '--map-auto', '--map-root-user', 'python3', '-', str(SCRIPT)], input=r'''
import importlib.util, os, subprocess, sys, tempfile
from pathlib import Path
spec = importlib.util.spec_from_file_location('access', sys.argv[1])
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
with tempfile.TemporaryDirectory(prefix='niwa-keep-id-') as temp:
    base = Path(temp); base.chmod(0o755)
    parent = base / 'parent'; parent.mkdir(); parent.chmod(0o750); os.chown(parent, 2, 2)
    storage = parent / 'storage'; storage.mkdir(mode=0o700); os.chown(storage, 3, 3)
    private = parent / 'private'; private.mkdir(mode=0o700); os.chown(private, 2, 2)
    subprocess.run(['setfacl', '-m', 'u:3:--x', str(parent)], check=True)
    # 2 (host application owner) is deliberately absent from the keep-id namespace.
    command = ['unshare', '--user', '--map-users=0:1:1', '--map-users=1:3:1',
               '--map-groups=0:1:1', '--map-groups=1:3:1', '--setuid=0', '--setgid=0', 'python3', '-c']
    check = 'import os,sys; os.stat(sys.argv[1])'
    before = subprocess.run(command + [check, str(storage)], capture_output=True)
    assert before.returncode != 0 and b'PermissionError' in before.stderr, before
    old_mode = parent.stat().st_mode
    module.allow_traversal([parent], 2, 1)
    assert parent.stat().st_mode == old_mode
    subprocess.run(command + [check, str(storage)], check=True)
    denied = """import os,sys
for path in sys.argv[1:]:
    try: os.listdir(path)
    except PermissionError: pass
    else: raise AssertionError(path)
"""
    subprocess.run(command + [denied, str(parent), str(private)], check=True)
    # The original executor ACL is also still traversal-only.
    def executor(): os.setgid(3); os.setuid(3)
    subprocess.run(['python3', '-c', denied, str(parent), str(private)], preexec_fn=executor, check=True)
    # Symlinks and unsafe ownership are rejected before mutation.
    link = base / 'link'; link.symlink_to(parent)
    for paths, owner in [([link], 2), ([parent], 0)]:
        try: module.allow_traversal(paths, owner, 1)
        except ValueError: pass
        else: raise AssertionError('unsafe target accepted')
''', text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == '__main__':
    unittest.main()
