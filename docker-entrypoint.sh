#!/bin/bash
set -euo pipefail
umask 077

PUID=${PUID:-1000}
PGID=${PGID:-1000}

if [[ ! "$PUID" =~ ^[1-9][0-9]*$ ]] || [[ ! "$PGID" =~ ^[1-9][0-9]*$ ]]; then
  echo "PUID and PGID must be positive, non-zero integers." >&2
  exit 1
fi

# RESET_DB=true deletes the database and rotates the one-time administrator password.
if [ "${RESET_DB:-false}" = "true" ]; then
  if [ -f /app/data/punchpilot.db ]; then
    echo "[PunchPilot] RESET_DB=true — removing existing database"
    rm -f /app/data/punchpilot.db /app/data/punchpilot.db-wal /app/data/punchpilot.db-shm
  fi
  rm -f /app/keystore/initial-admin-password
fi

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
  chmod 700 /app/data /app/logs /app/screenshots /app/keystore

  # Drop privileges and exec the CMD
  exec gosu "${PUID}:${PGID}" "$@"
fi

# Already running as non-root (e.g. user: "568:568" in compose), just exec
exec "$@"
