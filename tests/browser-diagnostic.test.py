"""Exercise the exact diagnostic CDP probe using the local sandboxed test Chromium."""
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
CHROME = ROOT / '.local/chrome-testing/run-chrome'


class DiagnosticTests(unittest.TestCase):
    @unittest.skipUnless(CHROME.exists(), 'Local Chromium required')
    def test_real_cdp_startup_and_failed_executable(self):
        source = (ROOT / 'deploy/ubuntu/diagnose-browser.mjs').read_text()
        probe = source.split('String.raw`', 1)[1].split('`);', 1)[0]
        with tempfile.TemporaryDirectory(prefix='niwa-diagnostic-') as temp:
            probe = probe.replace("'/tmp/niwa-browser'", repr(temp)).replace('/app/dist/', str(ROOT / 'dist') + '/')
            working = probe.replace("'/usr/bin/chromium'", repr(str(CHROME)))
            result = subprocess.run(['node', '-e', working], capture_output=True, text=True, timeout=55)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn('PASS: Chromium CDP', result.stdout)
            failed = probe.replace("'/usr/bin/chromium'", "'/nonexistent-niwa-test-chromium'")
            result = subprocess.run(['node', '-e', failed], capture_output=True, text=True, timeout=55)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('Chromium spawn failed: ENOENT', result.stderr)


if __name__ == '__main__': unittest.main()
