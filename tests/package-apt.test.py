"""Real apt local acquisition regression; dpkg is debug-only and state is temporary."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(shutil.which('apt-get') and shutil.which('dpkg-deb'), 'Debian apt required')
class AptTests(unittest.TestCase):
    def test_local_deb_acquisition_without_repositories(self):
        script = """
          import {packageArguments} from './dist/tools/packages/install.js';
          const image='sha256:'+'a'.repeat(64);
          const args=packageArguments(image,'/stage','niwa-package-12345678-1234-1234-1234-123456789abc',1);
          console.log(JSON.stringify(args.slice(args.indexOf(image)+1)));
        """
        flags = json.loads(subprocess.check_output(['node', '--input-type=module', '-e', script], cwd=ROOT, text=True))
        with tempfile.TemporaryDirectory(prefix='niwa-apt-test-') as temp:
            root = Path(temp)
            for directory in ['pkg/DEBIAN', 'state/lists/partial', 'cache/archives/partial', 'log', 'empty']:
                (root / directory).mkdir(parents=True)
            (root / 'pkg/DEBIAN/control').write_text('Package: niwa-acceptance\nVersion: 1.0\nArchitecture: all\nMaintainer: Niwa <example@example.invalid>\nDescription: synthetic test\n')
            deb = root / '0.deb'
            subprocess.run(['dpkg-deb', '--build', '--root-owner-group', str(root / 'pkg'), str(deb)], check=True, capture_output=True)
            (root / 'status').touch()
            config = root / 'apt.conf'
            config.write_text(f'''Dir::Etc::parts "{root}/empty";
Dir::Etc::main "/dev/null";
Dir::State "{root}/state";
Dir::State::status "{root}/status";
Dir::Cache "{root}/cache";
Dir::Log "{root}/log";
Debug::NoLocking "true";
Debug::pkgDPkgPM "true";
''')
            flags[-1] = str(deb)
            env = dict(os.environ, APT_CONFIG=str(config))
            failed = subprocess.run(['apt-get', '--no-download', *flags], env=env, capture_output=True, text=True)
            self.assertNotEqual(failed.returncode, 0)
            self.assertIn('Pathname to install is not absolute', failed.stderr)
            passed = subprocess.run(['apt-get', *flags], env=env, capture_output=True, text=True)
            self.assertEqual(passed.returncode, 0, passed.stdout + passed.stderr)
            self.assertIn('--unpack', passed.stderr)
            self.assertIn(str(deb), passed.stderr)
            self.assertEqual((root / 'status').read_text(), '')  # No actual installation.


if __name__ == '__main__':
    unittest.main()
