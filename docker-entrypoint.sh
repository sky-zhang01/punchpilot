#!/bin/bash
set -e

PUID=${PUID:-1000}
PGID=${PGID:-1000}

# Create group/user with requested IDs if running as root
if [ "$(id -u)" = "0" ]; then
  # Create group if it doesn't exist
  if ! getent group "${PGID}" >/dev/null 2>&1; then
    groupadd -g "${PGID}" ppuser
  fi

  # Create user if it doesn't exist
  if ! getent passwd "${PUID}" >/dev/null 2>&1; then
    useradd -u "${PUID}" -g "${PGID}" -d /app -s /bin/false ppuser 2>/dev/null || true
  fi

  # Fix ownership of writable directories
  chown -R "${PUID}:${PGID}" /app/data /app/logs /app/screenshots /app/keystore

  # Drop privileges and exec the CMD
  exec gosu "${PUID}:${PGID}" "$@"
fi

# Already running as non-root (e.g. user: "568:568" in compose), just exec
exec "$@"
