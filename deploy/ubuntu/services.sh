#!/bin/sh
# Daily operations for the system services and the dedicated executor user unit.
set -eu
case "${1:-}" in start|stop|restart|status) ;; *) echo 'Usage: sudo sh deploy/ubuntu/services.sh start|stop|restart|status' >&2; exit 2;; esac
test "$#" -eq 1 && test "$(id -u)" -eq 0 || { echo 'Run with sudo.' >&2; exit 1; }
root=/home/niwa/niwa
executor_uid=$(id -u niwa-exec)
userctl() {
  runuser -u niwa-exec -- env -i PATH=/usr/bin:/bin HOME="$root/runtime/executor/home" \
    XDG_RUNTIME_DIR="/run/user/$executor_uid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$executor_uid/bus" \
    systemctl --user "$@"
}
stop() {
  systemctl stop niwa.service
  systemctl stop niwa-workspace.service
  userctl stop niwa-executor.service
}
start() {
  systemctl start "user@$executor_uid.service"
  userctl start niwa-executor.service
  systemctl start niwa-workspace.service
  systemctl start niwa.service
}
case "$1" in
  start) start;;
  stop) stop;;
  restart) stop; start;;
  status)
    failed=0
    systemctl --no-pager --full status niwa.service niwa-workspace.service || failed=1
    userctl --no-pager --full status niwa-executor.service || failed=1
    exit "$failed";;
esac
