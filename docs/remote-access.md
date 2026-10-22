# Remote access

How to open PunchPilot from your phone or another computer. Back to the [README](../README.md).

## Default behavior

By default, you can sign in only on the computer that runs PunchPilot, at `http://localhost:8681`. From another device the page may open over plain `http://`, but sign-in is refused on purpose.

To use PunchPilot from another device, serve it over HTTPS and tell PunchPilot its public address.

## Setup

1. **Put PunchPilot behind an HTTPS reverse proxy.**
2. **Set two values in `.env`:**
   - `PUNCHPILOT_PUBLIC_ORIGIN`: your HTTPS address, for example `https://punchpilot.example.com`.
   - `TRUST_PROXY`: the address your reverse proxy connects to PunchPilot from.
3. **Register the matching callback URL in your freee app:** `https://<your address>/api/config/oauth-callback`. See [freee app setup](freee-app-setup.md).
4. **Apply the change** with `docker compose up -d`.

After that, sign in at the HTTPS address. Sign-in at `localhost` stops working.

## TRUST_PROXY values

`TRUST_PROXY` is a list of addresses, not an on/off switch.

| Value | Accepted |
| --- | --- |
| The proxy's exact IP address or a CIDR range | Yes, preferred |
| `loopback`, `linklocal`, `uniquelocal` (named ranges, useful for container networks) | Yes |
| `true` or similar on/off values | No: PunchPilot refuses to start |

PunchPilot trusts forwarded headers only from the addresses listed here. Keep the list as narrow as you can. See [`.env.example`](../.env.example) for the full comment.

## Safety

- Do not expose PunchPilot directly to the internet. Reach it only through your HTTPS reverse proxy, and keep the proxy's own access controls in place.
- Set `TRUST_PROXY` to your proxy's address only.
- Secure cookies and HSTS follow `PUNCHPILOT_PUBLIC_ORIGIN`, so use the same HTTPS address in the browser.

For the security model, see the [threat model](security-threat-model.md). Other settings are in [Configuration](configuration.md).
