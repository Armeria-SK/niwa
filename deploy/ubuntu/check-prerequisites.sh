#!/bin/sh
# Read-only checks. Does not install packages, create users, or change mounts.
set -u
failed=0
check() { if "$@"; then printf 'PASS: %s\n' "$*"; else printf 'MISSING: %s\n' "$*"; failed=1; fi; }
check test "$(uname -s)" = Linux
check test "$(id -u)" -ne 0
check command -v node
if command -v node >/dev/null 2>&1; then
  check node -e 'const [major,minor]=process.versions.node.split(".").map(Number);process.exit(major===24&&minor>=16?0:1)'
fi
check command -v podman
check test -f /sys/fs/cgroup/cgroup.controllers
check id niwa-exec
if command -v findmnt >/dev/null 2>&1; then
  if findmnt -rn -t drvfs,9p | grep -Eq '(/mnt/[a-z] |[A-Z]:)'; then
    printf 'MISSING: Windows drive mounts must be removed before production use\n'; failed=1
  else printf 'PASS: no Windows drive mount detected\n'; fi
else printf 'MISSING: findmnt is required to check Windows drive mounts\n'; failed=1
fi
exit "$failed"
