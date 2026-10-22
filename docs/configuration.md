# Updating, backup and settings

Purpose: how to update PunchPilot, what to back up, and which `.env` settings matter. Back to the [README](../README.md).

## Update

In the `punchpilot` folder, run:

```bash
git pull
docker compose up -d
```

- Compose downloads the new image.
- If you set `PUNCHPILOT_IMAGE` in `.env`, change its version too.
- Read the upgrade notes in the [CHANGELOG](../CHANGELOG.md) first.
- A punch or batch job that is running finishes first, which can take a few minutes.

## Back up

Back up these three together:

1. The `./data` folder.
2. The keystore Docker volume (normally named `punchpilot_keystore`).
3. Your `.env` file.

Why together: the saved freee credentials are encrypted with a secret kept in the keystore. Without the matching keystore, they cannot be decrypted. The rest of `./data` (logs, schedule, company name) is not encrypted, so keep backups private.

## Settings in `.env`

Copy [`.env.example`](../.env.example) to `.env` and edit it. The options most people use:

| Setting | What it does |
| --- | --- |
| `TZ` | The time zone your schedule follows (default `Asia/Tokyo`). |
| `PORT` | The port PunchPilot listens on (default `8681`). If you change it, register the matching callback URL in your freee app. |
| `PUID` / `PGID` | The user and group that own the data files (default `1000`). Some NAS systems need different values. |
| `PUNCHPILOT_IMAGE` | Optional. Pins the published image to a specific version, for example `ghcr.io/sky-zhang01/punchpilot:0.5.5`. Change it when you update. |
| `PUNCHPILOT_PUBLIC_ORIGIN`, `TRUST_PROXY` | For access from other devices. See [Remote access](remote-access.md). |

Other settings are explained in comments in `.env.example`.

## Initial admin password

A fresh database generates a one-time admin password in the keystore. Read it with:

```bash
docker compose exec punchpilot cat /app/keystore/initial-admin-password
```

To supply your own instead, set exactly one of these in `.env` (documented in `.env.example`):

- `PUNCHPILOT_INITIAL_ADMIN_PASSWORD`
- `PUNCHPILOT_INITIAL_ADMIN_PASSWORD_FILE` (preferred, because container environment variables can be inspected)

A supplied password must be at least 16 bytes, and must stay out of source control. An existing password file must be a regular file owned by the app user with mode `0600`.

## Forgot your password: factory reset

There is no password recovery. After three failed sign-ins, the sign-in page shows the factory-reset command:

```bash
docker exec -it punchpilot node server/reset-password.js
```

- It erases all PunchPilot data and settings. Your freee records are not affected.
- It removes the generated keystore password but keeps external password files. If you supplied your own initial password, rotate or remove it before restarting if the reset should also change it.
- After running it, restart with `docker compose restart punchpilot` and repeat [Install](../README.md#install) from step 2. If the initial password comes from `.env`, run `docker compose up -d --force-recreate punchpilot` instead, because a restart keeps the old environment values.
