import importlib.util
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import unittest
from unittest.mock import patch

REPO = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('reset_test', REPO / 'deploy/ubuntu/reset-test-environment.py')
reset = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reset)


class ResetTests(unittest.TestCase):
    def fixture(self, root):
        for name in ['state', 'workspace', 'config', 'secrets', 'runtime', 'backups']:
            (root / name).mkdir()
        (root / 'workspace/lost+found').mkdir()
        (root / 'workspace/test.txt').write_text('erase me')
        (root / 'config/niwa.json').write_text('{}')
        (root / 'secrets/key').write_text('synthetic-key')
        (root / 'backups/old').write_text('keep backup')
        (root / 'runtime/journal').write_text('keep journal')
        module = (REPO / 'dist/runtime/runtime.js').as_uri()
        code = f"""import {{Runtime}} from '{module}';
const r=new Runtime(process.argv[1]),a=r.administrator(),b=r.bootstrap(a),room=r.createRoom(a,'old');
r.post(a,room.id,'old message');r.tasks.create(a,b.id,room.id,'old work');r.close();"""
        subprocess.run(['node', '--input-type=module', '-e', code, str(root / 'state')], check=True)

    def test_apply_preserves_settings_environment_and_outside_link_target(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); self.fixture(root)
            outside = root / 'outside'; outside.write_text('keep outside')
            (root / 'workspace/link').symlink_to(outside)
            workareas = root / 'runtime/executor/workareas'; workareas.mkdir(parents=True)
            (workareas / 'index.db').write_text('synthetic scoped journal')
            (workareas / 'areas').mkdir(); (workareas / 'areas/draft').write_text('synthetic personal draft')
            before = reset.fingerprint(root); calls = []
            actual_run = subprocess.run
            def command(*args):
                calls.append(tuple(map(str, args)))
                if str(args[0]) == 'runuser' and str(args[5]).endswith('reset-test-state.mjs'):
                    actual_run(['node', str(REPO / 'deploy/ubuntu/reset-test-state.mjs'), str(args[6]), str(args[7])], check=True)
            with patch.object(reset, 'validate'), patch.object(reset, 'run', side_effect=command), patch.object(reset, 'wait_http'), patch.object(reset.subprocess, 'run'):
                reset.reset(root, True)
            self.assertEqual(reset.fingerprint(root), before)
            self.assertEqual(list(workareas.iterdir()), [])
            self.assertEqual(outside.read_text(), 'keep outside')
            self.assertEqual([p.name for p in (root / 'workspace').iterdir()], ['lost+found'])
            self.assertTrue((root / 'backups/old').exists()); self.assertTrue((root / 'runtime/journal').exists())
            with sqlite3.connect(root / 'state/control.db') as db:
                self.assertEqual(db.execute('select count(*) from agents').fetchone()[0], 1)
                for table in ['rooms', 'messages', 'tasks', 'artifacts', 'schedules']:
                    self.assertEqual(db.execute(f'select count(*) from {table}').fetchone()[0], 0)
            self.assertEqual(calls[0][-1], 'stop'); self.assertTrue(any(c[-1] == 'start' for c in calls))

    def test_preview_and_failed_build_do_not_delete_data(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); self.fixture(root)
            with patch.object(reset, 'validate'), patch.object(reset, 'run') as run:
                reset.reset(root)
                run.assert_not_called()
                with patch.object(reset.subprocess, 'run', side_effect=RuntimeError('build failed')):
                    with self.assertRaises(RuntimeError): reset.reset(root, True)
            self.assertEqual((root / 'workspace/test.txt').read_text(), 'erase me')
            with sqlite3.connect(root / 'state/control.db') as db:
                self.assertEqual(db.execute('select count(*) from messages').fetchone()[0], 1)

    def test_start_failure_keeps_old_state_for_inspection(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); self.fixture(root)
            actual_run = subprocess.run
            def command(*args):
                if str(args[0]) == 'runuser' and str(args[5]).endswith('reset-test-state.mjs'):
                    actual_run(['node', str(REPO / 'deploy/ubuntu/reset-test-state.mjs'), str(args[6]), str(args[7])], check=True)
                if str(args[-1]) == 'start': raise RuntimeError('startup failed')
            with patch.object(reset, 'validate'), patch.object(reset, 'run', side_effect=command), patch.object(reset.subprocess, 'run'):
                with self.assertRaises(RuntimeError): reset.reset(root, True)
            previous = list((root / 'runtime').glob('reset-test-*/old-state/control.db'))
            self.assertEqual(len(previous), 1)
            with sqlite3.connect(previous[0]) as db:
                self.assertEqual(db.execute('select count(*) from messages').fetchone()[0], 1)

    def test_missing_workspace_mount_and_nested_mount_fail_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); self.fixture(root)
            with patch.object(reset.os.path, 'ismount', return_value=False):
                with self.assertRaises(RuntimeError): reset.validate(root)
            with patch.object(reset.os.path, 'ismount', return_value=True):
                with self.assertRaises(RuntimeError): reset.workspace_entries(root / 'workspace')
            self.assertTrue((root / 'workspace/test.txt').exists())


if __name__ == '__main__': unittest.main()
