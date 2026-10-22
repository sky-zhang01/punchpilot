# freee developer app setup

Purpose: get the Client ID and Client Secret that PunchPilot needs, and connect them to your freee account. Back to the [README](../README.md).

## What you need

- A freee HR employee account.
- A freee developer app, which gives you a **Client ID** and a **Client Secret**. Automatic punching and requests go through the freee API, so this is required.
- Optional: your freee Web login (email, password and the exact company name).

## 1. Create the freee developer app

Create the app in the freee developers console by following the official guide at <https://developer.freee.co.jp/>. Its menus can change, so this page does not repeat them.

Whatever the console looks like, the one value PunchPilot dictates is the callback URL. Register it in the app:

| How you reach PunchPilot | Callback URL to register |
| --- | --- |
| On the same computer | `http://localhost:8681/api/config/oauth-callback` |
| Same computer, changed `PORT` | `http://localhost:<your port>/api/config/oauth-callback` |
| Your own HTTPS address (see [remote access](remote-access.md)) | `https://<your address>/api/config/oauth-callback` |

If you later move to a different address or port, register the matching callback URL in your freee app as well.

## 2. Enter the credentials in PunchPilot

1. Open **Settings → API Configuration (OAuth2)**.
2. Under "Step 1: Enter your freee Developer App credentials", enter the **Client ID** and **Client Secret**, then click **Save App Credentials**.
3. Under "Step 2: Authorize with your freee account", click **Authorize with freee** and approve access in freee.

The Client Secret and tokens are encrypted before storage. Keep the keystore backed up with your data; see the README.

## 3. Choose a company

If your freee account is linked to several companies, PunchPilot shows "Multiple companies detected". Use **Select a company** to pick the one used for attendance. You can change it later with **Switch Company**.

When the connection works, the OAuth status shows **Connected**. If freee asks you to sign in again, the dashboard shows a **Re-authorize** banner and automatic punching stays paused until you authorize again.

## 4. Optional: freee Web login

In **Settings → freee Web Login**, enter your freee email, password and the exact company name. PunchPilot checks them when you save.

Why it is used:

- Holiday work requests always use it.
- PunchPilot also uses it when your company's approval routes cannot be handled through the API.
- **Monthly Closing** appears when your company uses approval routes or a Web login is saved.

If you skip it, everything the API can do still works.

## Trying it first

You can leave all of this empty and keep **Mock Mode** on. Punches are then only simulated. Once freee is connected, corrections, leave requests, approvals and monthly closing are sent to freee for real, even in Mock Mode.
