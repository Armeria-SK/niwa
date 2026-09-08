#!/usr/bin/env python3
"""Activate accepted local executors, preserving images, configuration and catalog."""
import json
import os
from pathlib import Path
import pwd
import re
import runpy
import stat
import sys
import tempfile

helpers = runpy.run_path(str(Path(__file__).with_name('setup-services.py')))
ROOT = helpers['ROOT']
run, as_user, real_file, require = [helpers[key] for key in ('run', 'as_user', 'real_file', 'require')]


def replace(path, text):
    real_file(path)
    info = path.stat()
    fd, name = tempfile.mkstemp(dir=path.parent, prefix='.extension-')
    try:
        with os.fdopen(fd, 'w') as file:
            os.fchown(file.fileno(), info.st_uid, info.st_gid)
            os.fchmod(file.fileno(), stat.S_IMODE(info.st_mode))
            file.write(text)
            file.flush()
            os.fsync(file.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def main():
    require(sys.argv[1:] == ['--apply'] and os.geteuid() == 0, 'Usage: sudo python3 enable-extensions.py --apply')
    executor = pwd.getpwnam('niwa-exec')
    receipts = {}
    for kind, checks in [('browser', {'container-boundaries', 'sandbox-render', 'exact-approval-synthetic-send-reopen', 'cleanup'}),
                         ('package', {'offline-install', 'committed-version', 'nonroot-program-execution', 'base-unchanged'})]:
        path = ROOT / f'runtime/executor/state/{kind}-acceptance.json'
        real_file(path)
        receipt = json.loads(path.read_text())
        require(checks <= set(receipt.get('checks', [])), f'Incomplete {kind} acceptance')
        require(re.fullmatch(r'sha256:[a-f0-9]{64}', receipt.get('image', '')), 'Invalid image')
        as_user('niwa-exec', 'podman', 'image', 'exists', receipt['image'])
        receipts[kind] = receipt
    config_path, env_path = ROOT / 'config/niwa.json', ROOT / 'config/executor.env'
    real_file(config_path); real_file(env_path)
    before_config, before_env = config_path.read_text(), env_path.read_text()
    config = json.loads(before_config)
    require(config.get('programExecutorUid') == executor.pw_uid, 'Unexpected program identity')
    catalog = ROOT / 'runtime/executor/environments/catalog'
    options = f'--browser-image {receipts["browser"]["image"]} --packages {catalog}'
    lines = before_env.splitlines()
    require(f'NIWA_PROGRAM_IMAGE={receipts["package"]["base"]}' in lines, 'Package acceptance uses a different base')
    require(all(line.startswith('NIWA_PROGRAM_IMAGE=') or line == f'NIWA_EXECUTOR_OPTIONS={options}' for line in lines),
            'Existing executor options need review before replacement')
    # Empty is intentional: no arbitrary upstream or synthetic package becomes a production choice.
    as_user('niwa-exec', '/usr/bin/node', '--input-type=module', '-e', '''
      import {mkdirSync,existsSync,writeFileSync} from 'node:fs';
      import {PackageCatalog} from './dist/tools/packages/catalog.js';
      const path=process.argv[1]; mkdirSync(path,{recursive:true,mode:0o700});
      if(!existsSync(path+'/catalog.json')) writeFileSync(path+'/catalog.json','[]\\n',{flag:'wx',mode:0o600});
      new PackageCatalog(path);
    ''', catalog)
    config.update(browserExecutorUid=executor.pw_uid, packagesEnabled=True)
    new_env = '\n'.join(line for line in lines if line.startswith('NIWA_PROGRAM_IMAGE=')) + f'\nNIWA_EXECUTOR_OPTIONS={options}\n'
    run('sh', ROOT / 'deploy/ubuntu/services.sh', 'stop')
    try:
        replace(config_path, json.dumps(config, indent=2) + '\n')
        replace(env_path, new_env)
        run('sh', ROOT / 'deploy/ubuntu/services.sh', 'start')
        as_user('niwa', '/usr/bin/node', ROOT / 'deploy/ubuntu/verify-enabled.mjs')
    except Exception:
        run('sh', ROOT / 'deploy/ubuntu/services.sh', 'stop')
        replace(config_path, before_config); replace(env_path, before_env)
        run('sh', ROOT / 'deploy/ubuntu/services.sh', 'start')
        raise
    print('PASS: browser and package routes enabled; existing catalog preserved (new catalogs start empty)')


if __name__ == '__main__':
    os.chdir(ROOT)
    main()
