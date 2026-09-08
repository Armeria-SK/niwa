#!/bin/sh
set -eu
test "$#" -eq 1 && test "$1" = --apply || { echo 'Usage: sudo sh verify-packages.sh --apply' >&2; exit 2; }
test "$(id -u)" -eq 0 || { echo 'Run with sudo.' >&2; exit 1; }
root=/home/niwa/niwa
executor_uid=$(id -u niwa-exec)
runuser -u niwa-exec -- env -i PATH=/usr/bin:/bin HOME="$root/runtime/executor/home" \
  XDG_RUNTIME_DIR="/run/user/$executor_uid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$executor_uid/bus" \
  systemd-run --user --wait --pipe --collect --property=Delegate=yes --property=MemoryMax=2G --property=TasksMax=512 \
  --setenv="HOME=$root/runtime/executor/home" --setenv="XDG_RUNTIME_DIR=/run/user/$executor_uid" \
  /usr/bin/node "$root/deploy/ubuntu/verify-packages.mjs" --apply
