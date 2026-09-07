#!/bin/sh
# Explicit administrator action; prepares a fresh checkout, never starts Niwa.
set -eu
case "${1-}" in
  --check|--apply) test "$#" -eq 1 ;;
  *) printf 'Usage: sh prepare-executor.sh --check | sudo sh prepare-executor.sh --apply\n'; exit 2 ;;
esac
refuse() { printf 'Refusing preparation: %s\n' "$1" >&2; exit 1; }
if test "$1" = --apply; then
  test "$(id -u)" -eq 0 || refuse '--apply requires root.'
fi
test "$(uname -m)" = x86_64
root=/home/niwa/niwa
niwa_uid=$(id -u niwa)
# Check ancestors too: privileged writes must not follow a redirected checkout.
for path in /home /home/niwa "$root"; do
  test -d "$path" && test ! -L "$path" || refuse "Not a real directory: $path"
done
for path in /home/niwa "$root"; do
  test "$(stat -c %u "$path")" = "$niwa_uid" || refuse "Not owned by niwa: $path"
  test -z "$(find "$path" -maxdepth 0 -perm /022 -print)" || refuse "Group/other writable: $path"
done
# Allow source/build files, but never take over an initialized installation.
for path in .git src deploy; do
  test -d "$root/$path" && test ! -L "$root/$path" || refuse "Missing checkout directory: $path"
done
test -f "$root/package.json" && test ! -L "$root/package.json" || refuse 'Missing package.json.'
for path in runtime workspace; do
  test ! -e "$root/$path" && test ! -L "$root/$path" || refuse "Existing $path requires manual ownership/data review."
done
/usr/bin/node -e 'const [major,minor]=process.versions.node.split(".").map(Number);process.exit(major===24&&minor>=16?0:1)'
if getent passwd niwa-exec >/dev/null || getent group niwa-exec >/dev/null || getent group niwa-ipc >/dev/null; then
  printf 'Execution identities already exist; review them before preparing this installation.\n'; exit 1
fi
if test "$1" = --check; then
  printf 'Fresh checkout checks passed. No changes made; disk limits and service isolation still require verification.\n'
  exit 0
fi
apt-get install -y --no-install-recommends --no-upgrade --no-remove podman uidmap fuse-overlayfs acl
groupadd niwa-ipc
useradd --user-group --no-create-home --home-dir "$root/runtime/executor/home" --shell /usr/sbin/nologin niwa-exec
usermod --append --groups niwa-ipc niwa
usermod --append --groups niwa-ipc niwa-exec
grep -q '^niwa-exec:' /etc/subuid
grep -q '^niwa-exec:' /etc/subgid
install -d -o niwa -g niwa -m 755 "$root/runtime"
install -d -o niwa-exec -g niwa-exec -m 700 "$root/runtime/executor" "$root/runtime/executor/home" "$root/runtime/executor/state"
install -d -o niwa-exec -g niwa-ipc -m 2770 "$root/runtime/sockets"
install -d -o niwa-exec -g niwa-exec -m 700 "$root/workspace"
setfacl -m u:niwa-exec:--x /home/niwa
setfacl -m u:niwa-exec:--x "$root"
/usr/bin/node --version
printf 'Executor prerequisites prepared. No service, model account, image or program has been started.\n'
