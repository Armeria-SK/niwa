#!/bin/sh
set -eu
[ "$(id -u)" -eq 0 ] && [ "$#" -eq 1 ] && [ -d "$1" ] || { echo 'Usage: sudo sh verify-quality.sh STAGED_BUILD' >&2; exit 2; }
case "$1" in /home/niwa/niwa/dist*) echo 'Use a staged build' >&2; exit 2;; esac
root=$(mktemp -d /home/niwa/niwa/runtime/executor/.quality-verification-XXXXXX)
chown niwa-exec:niwa-exec "$root"
chmod 711 "$root"
image=$(sed -n 's/^NIWA_PROGRAM_IMAGE=//p' /home/niwa/niwa/config/executor.env)
runuser -u niwa-exec -- env HOME=/home/niwa/niwa/runtime/executor/home XDG_RUNTIME_DIR=/run/user/1001 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1001/bus systemd-run --user --wait --pipe --collect --property=Delegate=yes --property=MemoryMax=1G --property=TasksMax=256 /usr/bin/node /home/niwa/niwa/deploy/ubuntu/verify-quality.mjs "$root" "$1" "$image"
echo "PASS: artificial evidence at $root/receipt.json; no image adoption or production restart"
