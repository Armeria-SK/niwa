"""Validate the worker import graph using only the declared image COPY inputs."""
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class BrowserImageTests(unittest.TestCase):
    def test_worker_loads_from_the_actual_minimal_image_context(self):
        with tempfile.TemporaryDirectory(prefix='niwa-browser-context-') as temp:
            context = Path(temp)
            for line in (ROOT / 'deploy/ubuntu/Containerfile.browser').read_text().splitlines():
                if not line.startswith('COPY '): continue
                _, source, destination = line.split()
                self.assertTrue(destination.startswith('/app/'))
                target = context / destination.removeprefix('/app/')
                target.parent.mkdir(parents=True, exist_ok=True)
                if (ROOT / source).is_dir(): shutil.copytree(ROOT / source, target)
                else: shutil.copyfile(ROOT / source, target)
            result = subprocess.run(['node', '--input-type=module', '-e',
                'await import(process.argv[1]); console.log("PASS: isolated worker module graph")',
                (context / 'dist/tools/browser/worker.js').as_uri()], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == '__main__': unittest.main()
