#!/bin/sh
# Continue from successful image acceptance; preserve installed images and live data.
set -eu
test "$#" -eq 1 && test "$1" = --apply || { echo 'Usage: sudo sh verify-continuity.sh --apply' >&2; exit 2; }
test "$(id -u)" -eq 0 || { echo 'Run with sudo.' >&2; exit 1; }
root=/home/niwa/niwa
executor_uid=$(id -u niwa-exec)
image=$(runuser -u niwa-exec -- /usr/bin/node --input-type=module -e '
  import {readFileSync} from "node:fs";
  const receipt=JSON.parse(readFileSync("/home/niwa/niwa/runtime/executor/state/browser-acceptance.json","utf8"));
  if(!/^sha256:[a-f0-9]{64}$/.test(receipt.image)) throw Error("Verified browser image required");
  process.stdout.write(receipt.image);
')
# Extend real browser acceptance through approval and synthetic transport; no rebuild.
runuser -u niwa-exec -- env -i PATH=/usr/bin:/bin HOME="$root/runtime/executor/home" \
  XDG_RUNTIME_DIR="/run/user/$executor_uid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$executor_uid/bus" \
  systemd-run --user --wait --pipe --collect --property=Delegate=yes --property=MemoryMax=3G --property=TasksMax=1024 \
  --setenv="HOME=$root/runtime/executor/home" --setenv="XDG_RUNTIME_DIR=/run/user/$executor_uid" \
  /usr/bin/node "$root/deploy/ubuntu/prepare-browser.mjs" --apply "$image"
runuser -u niwa -- /usr/bin/node "$root/deploy/ubuntu/verify-persistence.mjs"
runuser -u niwa -- /usr/bin/node "$root/deploy/ubuntu/verify-services.mjs"
sh "$root/deploy/ubuntu/services.sh" restart
runuser -u niwa -- /usr/bin/node "$root/deploy/ubuntu/verify-services.mjs"
/usr/bin/node --input-type=module -e '
  import assert from "node:assert/strict";
  import {setTimeout} from "node:timers/promises";
  let failure;
  for(let attempt=0;attempt<20;attempt++) {
    try {
      const response=await fetch("http://127.0.0.1:3210/api/session",{signal:AbortSignal.timeout(1000)});
      assert.equal(response.status,200); assert.deepEqual(await response.json(),{authenticated:false});
      failure=undefined; break;
    } catch(error) {failure=error; await setTimeout(250);}
  }
  if(failure) throw failure;
'
echo 'PASS: three-service restart, live IPC before/after restart and unauthenticated HTTP'
