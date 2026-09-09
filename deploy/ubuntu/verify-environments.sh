#!/bin/sh
set -eu
test "$#" -eq 1 && test -d "$1" || { echo "Usage: sudo sh verify-environments.sh /absolute/staged/src" >&2; exit 2; }
test "$(id -u)" -eq 0 || { echo "Run with sudo" >&2; exit 2; }
compiled=$1
root=$(mktemp -d /home/niwa/niwa/runtime/executor/.environment-test-XXXXXX)
trap 'rm -rf -- "$root"' EXIT
chown niwa-exec:niwa-exec "$root"
chmod 711 "$root"
uid=$(id -u niwa-exec)
image=$(sed -n 's/^NIWA_PROGRAM_IMAGE=//p' /home/niwa/niwa/config/executor.env)
runuser -u niwa-exec -- env -i PATH=/usr/bin:/bin HOME=/home/niwa/niwa/runtime/executor/home XDG_RUNTIME_DIR=/run/user/$uid DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$uid/bus systemd-run --user --wait --pipe --collect --property=Delegate=yes --property=MemoryMax=2G --property=TasksMax=192 --setenv=HOME=/home/niwa/niwa/runtime/executor/home --setenv=XDG_RUNTIME_DIR=/run/user/$uid /usr/bin/node /home/niwa/niwa/deploy/ubuntu/verify-environments.mjs "$root" "$image" "$compiled"
