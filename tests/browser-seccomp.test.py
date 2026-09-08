import copy
import ctypes.util
import importlib.util
import json
from pathlib import Path
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('policy', ROOT / 'deploy/ubuntu/prepare-browser-seccomp.py')
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)


class PolicyTests(unittest.TestCase):
    def test_only_chroot_changes_in_installed_policy(self):
        original = json.loads(Path('/usr/share/containers/seccomp.json').read_text())
        before = copy.deepcopy(original)
        modified = module.browser_policy(original)
        def without_chroot(policy):
            result = copy.deepcopy(policy)
            for rule in result['syscalls']: rule['names'] = [n for n in rule['names'] if n != 'chroot']
            result['syscalls'] = [r for r in result['syscalls'] if r['names']]
            return result
        self.assertEqual(original, before)
        self.assertEqual(without_chroot(original), without_chroot(modified))
        self.assertEqual([r for r in modified['syscalls'] if 'chroot' in r['names']],
                         [{'names': ['chroot'], 'action': 'SCMP_ACT_ALLOW', 'args': []}])
        with self.assertRaises(ValueError): module.browser_policy({'defaultAction':'SCMP_ACT_ALLOW','syscalls':[]})

    @unittest.skipUnless(ctypes.util.find_library('seccomp'), 'libseccomp required')
    def test_kernel_chroot_denial_and_permission_inside_user_namespace(self):
        probe = subprocess.run(['unshare', '--user', '--map-root-user', 'true'], capture_output=True)
        if probe.returncode: self.skipTest('Unprivileged user namespace unavailable')
        code = r'''
import ctypes, ctypes.util, os, sys
lib = ctypes.CDLL(ctypes.util.find_library('seccomp'))
lib.seccomp_init.argtypes=[ctypes.c_uint32]; lib.seccomp_init.restype=ctypes.c_void_p
lib.seccomp_syscall_resolve_name.argtypes=[ctypes.c_char_p]; lib.seccomp_syscall_resolve_name.restype=ctypes.c_int
lib.seccomp_rule_add.argtypes=[ctypes.c_void_p,ctypes.c_uint32,ctypes.c_int,ctypes.c_uint]
lib.seccomp_load.argtypes=[ctypes.c_void_p]
context=lib.seccomp_init(0x7fff0000)
if sys.argv[1]=='deny':
    assert lib.seccomp_rule_add(context,0x50001,lib.seccomp_syscall_resolve_name(b'chroot'),0)==0
assert lib.seccomp_load(context)==0
libc=ctypes.CDLL(None,use_errno=True)
libc.chroot.argtypes=[ctypes.c_char_p]
result=libc.chroot(b'/proc/self/fdinfo/')
# No file access or library loading after the root change.
os._exit(0 if (result==-1 and ctypes.get_errno()==1 if sys.argv[1]=='deny' else result==0) else 1)
'''
        for mode in ['deny','allow']:
            result = subprocess.run(['unshare','--user','--map-root-user','python3','-c',code,mode],capture_output=True,text=True)
            self.assertEqual(result.returncode,0,result.stdout+result.stderr)


if __name__=='__main__': unittest.main()
