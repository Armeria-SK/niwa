#!/bin/sh
set -eu
test "$(id -u)" -eq 0 && test "$#" -eq 1 && test -d "$1" || { echo 'Usage: sudo sh verify-environment-model.sh /absolute/staged/src' >&2; exit 2; }
compiled=$1
root=$(mktemp -d /home/niwa/niwa/runtime/executor/.model-execution-test-XXXXXX)
bridge=$(mktemp -d /tmp/niwa-model-bridge-XXXXXX)
chmod 711 "$bridge"
unit=niwa-model-acceptance-$(basename "$root" | tr -cd 'A-Za-z0-9')
userctl() { runuser -u niwa-exec -- env HOME=/home/niwa/niwa/runtime/executor/home XDG_RUNTIME_DIR=/run/user/1001 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1001/bus systemctl --user "$@"; }
cleanup() { userctl stop "$unit.service" >/dev/null 2>&1 || true; }
trap cleanup EXIT
chown niwa-exec:niwa-exec "$root"; chmod 711 "$root"
mkdir "$bridge/ipc" "$bridge/app"
chown niwa-exec:niwa "$bridge/ipc"; chmod 2770 "$bridge/ipc"
chown niwa:niwa "$bridge/app"; chmod 700 "$bridge/app"
image=$(sed -n 's/^NIWA_PROGRAM_IMAGE=//p' /home/niwa/niwa/config/executor.env)
start() {
 runuser -u niwa-exec -- env HOME=/home/niwa/niwa/runtime/executor/home XDG_RUNTIME_DIR=/run/user/1001 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1001/bus systemd-run --user --unit="$unit" --collect --property=Delegate=yes --property=MemoryMax=2G --property=TasksMax=384 /usr/bin/node /home/niwa/niwa/deploy/ubuntu/verify-environment-model.mjs executor "$root" "$compiled" "$image" "$bridge"
 attempts=0
 until test -S "$bridge/ipc/executor.sock"; do attempts=$((attempts+1)); test "$attempts" -le 30 || exit 1; sleep 1; done
}
start
runuser -u niwa -- /usr/bin/node /home/niwa/niwa/deploy/ubuntu/verify-environment-model.mjs model "$root" "$compiled" "$image" "$bridge"
userctl stop "$unit.service"
start
runuser -u niwa -- /usr/bin/node /home/niwa/niwa/deploy/ubuntu/verify-environment-model.mjs reopen "$root" "$compiled" "$image" "$bridge"
echo "PASS: artificial model/executor evidence retained at $root and $bridge"
