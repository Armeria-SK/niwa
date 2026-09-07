#!/bin/sh
# Explicit administrator action; prepares an empty installation, never starts Niwa.
set -eu
test "${1-}" = --apply || { printf 'Usage: sudo sh prepare-executor.sh --apply\n'; exit 2; }
test "$(id -u)" -eq 0
test "$(uname -m)" = x86_64
root=/home/niwa/niwa
test -d "$root" && test ! -L "$root"
test -z "$(find "$root" -mindepth 1 -maxdepth 1 -print -quit)" || { printf 'Refusing an existing installation.\n'; exit 1; }
id niwa >/dev/null
/usr/bin/node -e 'const [major,minor]=process.versions.node.split(".").map(Number);process.exit(major===24&&minor>=16?0:1)'
if getent passwd niwa-exec >/dev/null || getent group niwa-ipc >/dev/null; then
  printf 'Execution identities already exist; review them before preparing this installation.\n'; exit 1
fi
apt-get install -y --no-install-recommends --no-upgrade --no-remove podman uidmap fuse-overlayfs acl
groupadd niwa-ipc
useradd --user-group --no-create-home --home-dir "$root/runtime/executor/home" --shell /usr/sbin/nologin niwa-exec
usermod --append --groups niwa-ipc niwa
usermod --append --groups niwa-ipc niwa-exec
grep -q '^niwa-exec:' /etc/subuid && grep -q '^niwa-exec:' /etc/subgid
install -d -o niwa -g niwa -m 755 "$root/app"
install -d -o niwa -g niwa -m 755 "$root/runtime"
install -d -o niwa-exec -g niwa-exec -m 700 "$root/runtime/executor" "$root/runtime/executor/home" "$root/runtime/executor/state"
install -d -o niwa-exec -g niwa-ipc -m 2770 "$root/runtime/sockets"
install -d -o niwa-exec -g niwa-exec -m 700 "$root/workspace"
setfacl -m u:niwa-exec:--x /home/niwa
setfacl -m u:niwa-exec:--x "$root"
/usr/bin/node --version
printf 'Executor prerequisites prepared. No service, model account, image or program has been started.\n'
