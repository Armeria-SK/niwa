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
if getent passwd niwa-exec >/dev/null || getent group niwa-ipc >/dev/null; then
  printf 'Execution identities already exist; review them before preparing this installation.\n'; exit 1
fi
apt-get install -y --no-install-recommends --no-upgrade --no-remove podman uidmap fuse-overlayfs acl curl xz-utils ca-certificates
scratch_dir=$(mktemp -d /tmp/niwa-executor-prepare.XXXXXXXX)
trap 'rm -rf -- "$scratch_dir"' EXIT HUP INT TERM
archive=node-v24.16.0-linux-x64.tar.xz
curl --fail --location --proto '=https' --tlsv1.2 --output "$scratch_dir/$archive" "https://nodejs.org/download/release/v24.16.0/$archive"
printf '%s  %s\n' d804845d34eddc21dc1092b519d643ef40b1f58ec5dec5c22b1f4bd8fabde6c9 "$scratch_dir/$archive" | sha256sum --check --strict
groupadd niwa-ipc
useradd --user-group --no-create-home --home-dir "$root/runtime/executor/home" --shell /usr/sbin/nologin niwa-exec
usermod --append --groups niwa-ipc niwa
usermod --append --groups niwa-ipc niwa-exec
grep -q '^niwa-exec:' /etc/subuid && grep -q '^niwa-exec:' /etc/subgid
install -d -o root -g root -m 755 "$root/app" "$root/app/runtime" "$root/runtime"
tar --extract --xz --file "$scratch_dir/$archive" --directory "$root/app/runtime" --no-same-owner
install -d -o niwa-exec -g niwa-exec -m 700 "$root/runtime/executor" "$root/runtime/executor/home" "$root/runtime/executor/state"
install -d -o niwa-exec -g niwa-ipc -m 2770 "$root/runtime/sockets"
install -d -o niwa-exec -g niwa-exec -m 700 "$root/workspace"
setfacl -m u:niwa-exec:--x /home/niwa
"$root/app/runtime/node-v24.16.0-linux-x64/bin/node" --version
printf 'Executor prerequisites prepared. No service, model account, image or program has been started.\n'
