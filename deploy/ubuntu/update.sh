#!/bin/sh
# Update an installed Niwa to the newest commit of its tracked branch: stop, fast-forward, build, start.
# Refuses before stopping anything when the checkout or the incoming changes need review; a failed build restores the previous commit.
set -eu
root=/home/niwa/niwa
script="$root/deploy/ubuntu/update.sh"
if test "$(id -u)" -ne 0; then exec sudo sh "$script" "$@"; fi
# On WSL the login shell may sit in another mount namespace than systemd; use systemd's so the bounded volumes are visible.
if test "$(readlink /proc/self/ns/mnt)" != "$(readlink /proc/1/ns/mnt)"; then exec nsenter -t 1 -m -- sh "$script" "$@"; fi
backup_check=yes
case "$#:${1:-}" in
  0:) ;;
  1:--skip-backup-check) backup_check=no ;;
  *) echo 'Usage: sudo sh /home/niwa/niwa/deploy/ubuntu/update.sh [--skip-backup-check]' >&2; exit 2 ;;
esac
refuse() { trap - 0; printf 'Update refused: %s\nNothing was stopped or changed.\n' "$1" >&2; exit 1; }
# Source and build files are written as niwa with umask 022 so the executor and other users cannot modify them.
as_niwa() {
  runuser -u niwa -- env -i PATH=/usr/bin:/bin HOME=/home/niwa LANG=C.UTF-8 \
    /bin/sh -c 'umask 022 && cd /home/niwa/niwa && exec "$@"' niwa-update "$@"
}

stage='checks'
trap 'echo "Update stopped during: $stage. Existing data was retained; inspect the error before retrying." >&2' 0
test -f "$root/runtime/services-installed.json" || refuse 'Niwa is not installed yet. Run setup.sh first.'
test -z "$(as_niwa git status --porcelain --untracked-files=no)" || refuse 'The checkout has local changes. Commit or discard them first (git status).'
branch=$(as_niwa git rev-parse --abbrev-ref HEAD)
test "$branch" != HEAD || refuse 'The checkout is not on a branch. Switch to one first (git switch main).'

stage='fetch'
# Prune so a merged and deleted branch is reported instead of looking up to date against a stale copy.
as_niwa git fetch --prune --quiet
upstream=$(as_niwa git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null) ||
  refuse "Branch $branch has no upstream on the remote (a merged branch is usually deleted). Switch to main first: git switch main"
old=$(as_niwa git rev-parse HEAD)
new=$(as_niwa git rev-parse '@{u}')
as_niwa git merge-base --is-ancestor HEAD '@{u}' || refuse "The checkout has commits that $upstream does not have."
# The commit that dist was last built from; a pull without a build (or a build before this script existed) leaves it behind HEAD.
marker="$root/runtime/built-commit"
built=$(cat "$marker" 2>/dev/null || true)
if ! printf '%s' "$built" | grep -Eqx '[0-9a-f]{40}' || ! as_niwa git merge-base --is-ancestor "$built" "$new" 2>/dev/null; then built=''; fi
if test "$old" = "$new" && test "$built" = "$new"; then trap - 0; echo "Already up to date: $branch at $(as_niwa git rev-parse --short HEAD)."; exit 0; fi
base=${built:-$old}
# Installed units and verified images are copies made by setup; changing them needs setup or a documented preparation step.
review=$(as_niwa git diff --name-only "$base" "$new" -- deploy/ubuntu/systemd deploy/ubuntu/program-image.json \
  deploy/ubuntu/browser-image.json deploy/ubuntu/Containerfile.browser)
test -z "$review" || refuse "This update changes files that setup installs or verifies:
$review
This script does not replace them. Read the commit notes (git log $(as_niwa git rev-parse --short "$base")..$upstream) and follow the steps they give."
if test "$backup_check" = yes; then
  test -n "$(find "$root/backups" -mindepth 2 -maxdepth 2 -name manifest.json -mmin -1440 2>/dev/null)" ||
    refuse 'No backup from the last 24 hours. Press "Back up now" in Settings > Backup, or pass --skip-backup-check.'
fi
# Without a known build, node_modules may be from any version, so install it again.
if test -z "$built" || test -n "$(as_niwa git diff --name-only "$built" "$new" -- package.json package-lock.json)"; then dependencies=yes; else dependencies=''; fi
port=$(python3 -c 'import json,sys;print(int(json.load(open(sys.argv[1]))["port"]))' "$root/config/niwa.json")

# Called inside `if`, where set -e does not apply, so every step returns its failure explicitly.
build() {
  if test -n "$dependencies"; then as_niwa npm ci --no-audit --no-fund || return 1; fi
  as_niwa npm run build || return 1
  as_niwa /bin/sh -c 'git rev-parse HEAD > runtime/built-commit' || return 1
}
ready() {
  for _ in $(seq 30); do
    if curl -fsS --noproxy '*' -m 2 -o /dev/null "http://127.0.0.1:$port/" 2>/dev/null; then return 0; fi
    sleep 1
  done
  return 1
}

if test "$old" = "$new"; then
  if test -n "$built"; then from="from $(as_niwa git rev-parse --short "$built")"; else from='not recorded'; fi
  echo "Rebuilding $branch at $(as_niwa git rev-parse --short "$new"): the running build is $from."
else
  echo "Updating $branch: $(as_niwa git rev-parse --short "$old") -> $(as_niwa git rev-parse --short "$new")"
  as_niwa git log --oneline "$old..$new"
fi
stage='stop'
sh "$root/deploy/ubuntu/services.sh" stop
stage='update and build'
as_niwa git merge --ff-only --quiet '@{u}'
if ! build; then
  if test "$old" = "$new"; then
    trap - 0
    echo "Build failed; Niwa is stopped. Inspect the build error above, then run this script again." >&2
    exit 1
  fi
  stage='restoring the previous version'
  echo "Build failed. Restoring $(as_niwa git rev-parse --short "$old") and starting it again." >&2
  as_niwa git reset --keep "$old"
  dependencies=yes
  build
  sh "$root/deploy/ubuntu/services.sh" start
  ready || echo "Previous version did not respond at http://127.0.0.1:$port/; inspect journalctl -u niwa.service." >&2
  trap - 0
  echo "Update failed; the previous version is running again. Inspect the build error above before retrying." >&2
  exit 1
fi
stage='start'
sh "$root/deploy/ubuntu/services.sh" start
ready || { echo "Niwa did not respond at http://127.0.0.1:$port/; inspect journalctl -u niwa.service -u niwa-workspace.service." >&2; exit 1; }
trap - 0
echo "PASS: Niwa updated to $(as_niwa git rev-parse --short HEAD) and responding at http://127.0.0.1:$port/"
