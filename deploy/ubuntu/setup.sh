#!/bin/sh
# Fresh install / resume completed preparation stages. Run from the cloned checkout.
set -eu
root=/home/niwa/niwa
if test "$(id -u)" -ne 0; then exec sudo sh "$root/deploy/ubuntu/setup.sh" "$@"; fi
test "$#" -eq 0 || { echo 'Usage: sudo sh /home/niwa/niwa/deploy/ubuntu/setup.sh' >&2; exit 2; }
stage='host checks'
trap 'echo "Setup stopped during: $stage. Existing data was retained; inspect the error before retrying." >&2' 0
# This installer targets the documented Ubuntu/systemd/amd64 layout.
. /etc/os-release
test "$ID" = ubuntu && test "$(uname -m)" = x86_64
test -d /run/systemd/system && test -f /sys/fs/cgroup/cgroup.controllers
id niwa >/dev/null
test "$(readlink -f "$root")" = "$root"
test "$(stat -c %U "$root")" = niwa
# Avoid rebuilding a running installation; use the documented stop command first.
for service in niwa.service niwa-workspace.service; do
  if systemctl is-active --quiet "$service"; then
    echo 'Niwa is already running. Use services.sh for daily operations; stop it before rerunning setup.' >&2; exit 1
  fi
done
if ss -H -ltn 'sport = :3210' | /bin/grep -q .; then
  echo 'Port 3210 is already in use. Stop the existing process before setup.' >&2; exit 1
fi
if id niwa-exec >/dev/null 2>&1; then
  executor_uid=$(id -u niwa-exec)
  if runuser -u niwa-exec -- env XDG_RUNTIME_DIR="/run/user/$executor_uid" \
      DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$executor_uid/bus" \
      systemctl --user is-active --quiet niwa-executor.service; then
    echo 'Stop the existing executor with services.sh stop before setup.' >&2; exit 1
  fi
fi
stage='system dependencies'
apt-get update
apt-get install -y --no-install-recommends --no-remove ca-certificates curl git python3 rsync e2fsprogs acl
if ! /usr/bin/node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a===24&&b>=16?0:1)' 2>/dev/null; then
  # A different existing major needs an explicit upgrade decision, never an automatic downgrade.
  if test -x /usr/bin/node; then echo 'System Node must be 24.16 or newer within 24.x. Update it before setup.' >&2; exit 1; fi
  stage='Node.js 24 installation'
  installer=$(mktemp)
  curl --fail --silent --show-error --location https://deb.nodesource.com/setup_24.x -o "$installer"
  bash "$installer"
  rm -f "$installer"
  apt-get install -y --no-install-recommends --no-remove nodejs
fi
/usr/bin/node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a===24&&b>=16?0:1)'
stage='build, isolation acceptance and service installation'
python3 "$root/deploy/ubuntu/setup-services.py"
trap - 0
