#!/bin/sh
# Completes host session preparation after prepare-executor.sh; no Niwa service or container is started.
set -eu
test "$#" -eq 1 && test "$1" = --apply || { echo 'Usage: sudo sh prepare-executor-session.sh --apply'; exit 2; }
test "$(id -u)" -eq 0 || { echo 'Administrator authentication is required.' >&2; exit 1; }
# Use the shell builtin: Ubuntu's uutils test 0.8.0 ignores named ACL entries.
executor_access() {
  runuser -u niwa-exec -- /bin/sh -c 'test "$1" "$2"' access-check "$@"
}
root=/home/niwa/niwa
executor_uid=$(id -u niwa-exec)
executor_gid=$(id -g niwa-exec)
ipc_gid=$(getent group niwa-ipc | cut -d: -f3)
test "$executor_uid" -ne 0
executor_home=$root/runtime/executor/home
executor_runtime=/run/user/$executor_uid

# Validate the prepared tree before changing login state. Never repair ownership recursively.
for path in /home /home/niwa "$root" "$root/runtime"; do
  test -d "$path" && test ! -L "$path"
done
for path in "$root/runtime/executor" "$executor_home" "$root/runtime/executor/state" "$root/workspace"; do
  test -d "$path" && test ! -L "$path"
  test "$(stat -c '%u:%g:%a' "$path")" = "$executor_uid:$executor_gid:700"
done
test ! -L "$root/runtime/sockets"
test "$(stat -c '%u:%g:%a' "$root/runtime/sockets")" = "$executor_uid:$ipc_gid:2770"
for user in niwa niwa-exec; do
  case " $(id -G "$user") " in *" $ipc_gid "*) ;; *) echo "Missing IPC membership: $user" >&2; exit 1 ;; esac
done
for path in "$root" "$root/dist" "$root/node_modules"; do
  executor_access -x "$path"
  if executor_access -w "$path"; then echo "Executor can modify application path: $path" >&2; exit 1; fi
done
for path in "$root/dist/entrypoints/executor.js" "$root/dist/sandbox/preflight.js"; do
  executor_access -r "$path"
done
for path in /home/niwa "$root"; do
  if executor_access -r "$path"; then echo "Executor can list private parent: $path" >&2; exit 1; fi
done
for path in "$root/state" "$root/secrets" "$root/backups"; do
  if test -e "$path"; then
    if executor_access -r "$path" || executor_access -x "$path"; then
      echo "Executor can access private data: $path" >&2; exit 1
    fi
  fi
done
echo 'PASS: prepared ownership, IPC membership and executor access checks'

loginctl enable-linger niwa-exec
systemctl start "user@$executor_uid.service"
test -d "$executor_runtime" && test ! -L "$executor_runtime"
test "$(stat -c '%u:%a' "$executor_runtime")" = "$executor_uid:700"
runuser -u niwa-exec -- env -i PATH=/usr/bin:/bin HOME="$executor_home" XDG_RUNTIME_DIR="$executor_runtime" \
  DBUS_SESSION_BUS_ADDRESS="unix:path=$executor_runtime/bus" \
  systemd-run --user --wait --pipe --collect --property=Delegate=yes \
  --setenv="HOME=$executor_home" --setenv="XDG_RUNTIME_DIR=$executor_runtime" \
  --setenv="DBUS_SESSION_BUS_ADDRESS=unix:path=$executor_runtime/bus" \
  /usr/bin/node "$root/deploy/ubuntu/verify-podman-host.mjs"
