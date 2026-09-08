#!/bin/sh
set -eu
test "$#" -eq 1 || { echo 'Usage: sudo sh diagnose-browser.sh sha256:IMAGE_ID' >&2; exit 2; }
test "$(id -u)" -eq 0 || { echo 'Run with sudo.' >&2; exit 1; }
root=/home/niwa/niwa
executor_uid=$(id -u niwa-exec)
python3 "$root/deploy/ubuntu/prepare-browser-seccomp.py" --apply
exec runuser -u niwa-exec -- env -i PATH=/usr/bin:/bin HOME="$root/runtime/executor/home" \
 XDG_RUNTIME_DIR="/run/user/$executor_uid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$executor_uid/bus" \
 systemd-run --user --wait --pipe --collect --property=Delegate=yes --property=MemoryMax=2G --property=TasksMax=512 \
 --setenv="HOME=$root/runtime/executor/home" --setenv="XDG_RUNTIME_DIR=/run/user/$executor_uid" \
 /usr/bin/node "$root/deploy/ubuntu/diagnose-browser.mjs" "$1"
