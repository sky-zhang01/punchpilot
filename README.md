# PunchPilot

**Automatic clock-in and clock-out for [freee HR](https://www.freee.co.jp/hr/) (freee人事労務), running on your own computer or server.**

[**中文**](README.zh-CN.md) | [**日本語**](README.ja.md)

If your company records attendance in freee HR, you have to clock in, start and end a break, and clock out every working day. Miss one and you have to file a correction later. PunchPilot makes those punches for you on a schedule you choose and skips the days you are not working. Its web dashboard also lets you fix missed days, request leave, close the month and, if you are an approver in freee, approve your team's requests.

PunchPilot is a single-user tool: each person runs their own copy for their own freee account. It is an independent open-source project and is not affiliated with freee K.K.

## A normal day

1. Shortly after midnight, PunchPilot plans the day: check-in, break start, break end and check-out. Each one can be a fixed time or a random minute inside a window. The defaults are check-in 09:50–10:00, break start 12:00–12:30, break end 13:00–13:30 and check-out 19:00–20:00.
2. It skips the whole day on weekends, Japanese public holidays, custom holidays you add, and days that freee shows as full-day leave, absence or a company holiday. If you also select China under **Holiday Skip for Auto-Punch**, Chinese public holidays are skipped too, and China's weekend make-up workdays (调休) are punched as normal workdays. Half-day or hourly leave that does not cover the whole workday does not skip the day.
3. Just before each punch it checks freee again. If you already punched by hand, it does nothing. If it cannot confirm your status, it pauses instead of guessing: the dashboard shows the pause and the Logs page records the reason.
4. A 60–90 minute break is added only when the workday is longer than six hours, following Japan's Labor Standards Act (Article 34).
5. If PunchPilot was not running at check-in time, it does not record a late arrival. It checks in only if it is up to five minutes late. Otherwise it skips that day's automatic punches, and you punch in freee yourself.

## Common situations

Corrections, requests, approvals and custom holidays are on the **Calendar & Holidays** page. **Auto Scheduling** is in **Settings → Schedule Configuration**, and **Manual Trigger** is on the Dashboard. Corrections and requests need the freee API connection. Request lists and approvals appear when your company uses freee approval routes.

| You want to… | Do this |
|---|---|
| Fix days you forgot to punch | **Punch Correction → Select All Missing**, then submit. Days that already have punches or are days off are skipped. |
| Take a planned day off | **Leave Request**: paid leave (full day, half day or hourly), special leave or absence. Once freee shows the full-day leave, that day is skipped automatically. |
| Call in sick, or take leave that is not approved yet | Turn off **Auto Scheduling** before check-in, and turn it back on before your next working day. PunchPilot only skips leave that freee already shows. |
| Go on vacation or a business trip | Turn off **Auto Scheduling**, and turn it back on when you return. |
| Work late | Turn off **Auto Scheduling** before the check-out window. When you leave, press **Check-out** in **Manual Trigger**, then turn **Auto Scheduling** back on. |
| Leave early | Clock out yourself. PunchPilot sees the punch and skips the automatic check-out. |
| Record overtime or work on a holiday | **Leave Request → Overtime Request**, or **Work Request → Holiday Work**. Holiday work requests always use your freee Web login. |
| Take back a request | **View Requests**, then withdraw it while it is still pending. |
| Approve your team's requests | **View Requests → Incoming Requests**: approve or reject one at a time or in bulk. |
| Close the month | **Monthly Closing**. It appears when your company uses approval routes or a freee Web login is saved. |
| Punch right now | **Dashboard → Manual Trigger**. |
| Take a company holiday off | **Holiday Management → Custom Holidays**. |
| Find out why nothing happened today | Check the status on the dashboard. For holidays, leave and pauses, the "Daily Schedule Check" entry in **Logs** gives the reason. |

When freee asks you to sign in again, the dashboard shows a **Re-authorize** banner. Automatic punching stays paused until you do.

## What PunchPilot will not do

- The PunchPilot server connects only to freee and to public holiday calendars. There is no telemetry.
- It does not punch when it cannot confirm your attendance status, your leave, or which freee account it is acting for. It pauses and tells you.
- It never overwrites punches that are already in freee.
- It does not send email or chat notifications. Check the dashboard and logs.
- It does not decide whether automatic punching is allowed where you work. Follow your company's attendance rules.

## Before you start

- **A freee HR employee account.**
- **A freee developer app** (Client ID and Client Secret). Automatic punching and requests go through the freee API, so this is required. Register this callback URL in the app: `http://localhost:8681/api/config/oauth-callback`. If you change `PORT`, use that port instead. If you use your own HTTPS address, register `https://<your address>/api/config/oauth-callback`.
- **Optional: your freee Web login** (email, password and the exact company name). Holiday work requests always use it. PunchPilot also uses it when your company's approval routes cannot be handled through the API.
- **A computer that stays on and awake during working hours**, with Docker and Docker Compose. A laptop that goes to sleep misses punches. Supported platforms are `linux/amd64` and 64-bit `linux/arm64`. Docker Desktop on Windows and macOS runs the same image, but the project does not test it.

## Quick start

```bash
git clone https://github.com/sky-zhang01/punchpilot.git
cd punchpilot
cp .env.example .env
docker compose up -d
```

1. On the same computer, open <http://localhost:8681>.
2. Read the one-time password, then sign in as `admin` and choose your own username and password:

   ```bash
   docker compose exec punchpilot cat /app/keystore/initial-admin-password
   ```

3. In **Settings → API Configuration (OAuth2)**, enter your Client ID and Client Secret and click **Save App Credentials**. Then click **Authorize with freee**, and choose your company if you have more than one.
4. Optional: in **Settings → freee Web Login**, enter your freee email, password and exact company name. PunchPilot checks them when you save.
5. In **Settings → Schedule Configuration**, set your times and holiday options.
6. **Turn off Mock Mode** in Settings. New installations start in Mock Mode, which only simulates the clock-in, break and clock-out punches.

When the **Mock Mode** tag disappears from the sidebar, PunchPilot punches for real. The dashboard shows the next planned punch. After your first check-in time, confirm in freee that the punch arrived.

## Opening PunchPilot from another device

By default, you can sign in only on the computer that runs PunchPilot, at `http://localhost:8681`. From another device the page may open over plain `http://`, but sign-in is refused on purpose. To use it from your phone or another computer:

1. Put PunchPilot behind an HTTPS reverse proxy.
2. In `.env`, set `PUNCHPILOT_PUBLIC_ORIGIN` (for example `https://punchpilot.example.com`) and `TRUST_PROXY`.
3. Register the matching callback URL in your freee app.

After that, sign in at the HTTPS address. Sign-in at `localhost` stops working.

## Updating, backup and settings

- **Update:** in the `punchpilot` folder, run `git pull` and then `docker compose up -d`. Compose downloads the new image. If you set `PUNCHPILOT_IMAGE` in `.env`, change its version too. Read the upgrade notes in the [CHANGELOG](CHANGELOG.md) first. A punch or batch job that is running finishes first, which can take a few minutes.
- **Back up** the `./data` folder, the keystore Docker volume (normally named `punchpilot_keystore`) and your `.env` together. Without the matching keystore, the saved freee credentials cannot be decrypted. The rest of `./data` (logs, schedule, company name) is not encrypted, so keep backups private.
- **Settings:** the options most people use are `TZ` (the time zone your schedule follows), `PORT`, `PUID`/`PGID` (the user and group that own the data files; some NAS systems need different values), `PUNCHPILOT_PUBLIC_ORIGIN` and `TRUST_PROXY`. Other settings are explained in [`.env.example`](.env.example).

## FAQ

**I forgot my PunchPilot password.** There is no password recovery. After three failed sign-ins, the sign-in page shows a factory-reset command. It erases all PunchPilot data and settings; your freee records are not affected. After running it, restart with `docker compose restart punchpilot` and repeat the quick start from step 2.

**Is my freee password safe?** Saved credentials are encrypted on your own server. In the standard Docker Compose setup, the automated browser runs in Chromium's sandbox. See [SECURITY.md](SECURITY.md) for details and for how to report a vulnerability.

**Can I try it without connecting to freee?** Yes. Keep Mock Mode on and leave steps 3 and 4 of the quick start empty; punches are only simulated. Mock Mode covers punches only: once freee is connected, corrections, leave requests, approvals and monthly closing are sent to freee for real.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for local development and tests.

## Acknowledgments

PunchPilot started from [freee-checkin](https://github.com/newbdez33/freee-checkin) by [@newbdez33](https://github.com/newbdez33), which provided the original browser-based freee attendance automation.

## License

[MIT](LICENSE)
