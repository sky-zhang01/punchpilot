# How PunchPilot works

This page explains what PunchPilot decides each day, and when it does nothing. Back to the [README](../README.md).

## Planning the day

Shortly after midnight, PunchPilot plans four steps: check-in, break start, break end and check-out. Each step can be a fixed time or a random minute inside a window.

Default windows:

| Step | Window |
|---|---|
| Check-in | 09:50-10:00 |
| Break start | 12:00-12:30 |
| Break end | 13:00-13:30 |
| Check-out | 19:00-20:00 |

Change them in **Settings → Schedule Configuration**.

## Days that are skipped

PunchPilot skips the whole day on:

- weekends
- Japanese public holidays
- custom holidays you add under **Holiday Management → Custom Holidays**
- days freee shows as full-day leave, absence or a company holiday

China holidays are optional. If you also select China under **Holiday Skip for Auto-Punch**, Chinese public holidays are skipped too, and China's weekend make-up workdays (调休) are punched as normal workdays.

Half-day or hourly leave that does not cover the whole workday does not skip the day.

PunchPilot only skips leave that freee already shows. Leave that is not yet approved or recorded does not skip the day.

## Before each punch

Just before each punch, PunchPilot checks freee again.

- If you already punched by hand, it does nothing for that step.
- If it cannot confirm your attendance status, your leave, or which freee account it is acting for, it pauses instead of guessing. The dashboard shows the pause, and the "Daily Schedule Check" entry in **Logs** gives the reason.
- It never overwrites punches that are already in freee.

## Breaks

A 60-90 minute break is added only when the workday is longer than six hours, following Japan's Labor Standards Act (Article 34).

## If PunchPilot was not running

If PunchPilot was not running at check-in time, it does not record a late arrival. It checks in only if it is up to five minutes late. Otherwise it skips that day's automatic punches, and you punch in freee yourself.

The five-minute limit applies only when PunchPilot was not running at the planned time.

## If freee is temporarily unavailable (v0.5.3 and later)

If PunchPilot is running but freee is temporarily unavailable or rate-limited, it retries the punch for about an hour.

- Before each retry it checks freee's punch history, so nothing is punched twice.
- It stops early if the next retry would land at or after the day's next planned action.
- While retries are still running, the dashboard can show the step as failed.
- If the punch still fails in the end, the **Logs** page records the reason, and you punch in freee yourself.

## When you act by hand

PunchPilot sees punches you make in freee or through **Manual Trigger** and adjusts the rest of the day. For example, if you clock out early yourself, the automatic check-out is skipped. To work late or take leave that freee does not show yet, turn off **Auto Scheduling** and turn it back on before your next working day. See [Daily use](daily-use.md).

When freee asks you to sign in again, the dashboard shows a **Re-authorize** banner, and automatic punching stays paused until you do.

## What PunchPilot will not do

- The PunchPilot server connects only to freee and to public holiday calendars (hosted on GitHub). There is no telemetry.
- It does not punch when it cannot confirm your attendance status, your leave, or which freee account it is acting for. It pauses and tells you.
- It never overwrites punches that are already in freee.
- It does not send email or chat notifications. Check the dashboard and logs.
- It does not decide whether automatic punching is allowed where you work. Follow your company's attendance rules.
