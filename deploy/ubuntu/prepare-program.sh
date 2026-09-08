#!/bin/sh
# Explicit operator preparation and artificial-data acceptance, not application deployment.
set -eu
test "$#" -eq 1 && test "$1" = --apply || { echo 'Usage: sudo sh prepare-program.sh --apply'; exit 2; }
test "$(id -u)" -eq 0 || { echo 'Administrator authentication is required.' >&2; exit 1; }
root=/home/niwa/niwa
executor_uid=$(id -u niwa-exec)
test "$executor_uid" -ne 0
for path in "$root/workspace" "$root/runtime/executor"; do
  test -d "$path" && test ! -L "$path"
  mountpoint -q "$path"
done
systemctl is-active --quiet "user@$executor_uid.service"
executor_home=$root/runtime/executor/home
executor_runtime=/run/user/$executor_uid
exec runuser -u niwa-exec -- env -i PATH=/usr/bin:/bin HOME="$executor_home" XDG_RUNTIME_DIR="$executor_runtime" \
  DBUS_SESSION_BUS_ADDRESS="unix:path=$executor_runtime/bus" \
  systemd-run --user --wait --pipe --collect --property=Delegate=yes --property=MemoryMax=2G --property=TasksMax=512 \
  --setenv="HOME=$executor_home" --setenv="XDG_RUNTIME_DIR=$executor_runtime" \
  --setenv="DBUS_SESSION_BUS_ADDRESS=unix:path=$executor_runtime/bus" \
  /usr/bin/node "$root/deploy/ubuntu/prepare-program.mjs" --apply
