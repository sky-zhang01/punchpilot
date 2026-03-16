/**
 * Explore freee monthly attendance closing form
 * Runs in headed mode so user can log in manually.
 * Usage: node scripts/explore-monthly-form.js
 */
import { chromium } from "playwright";

const TARGET_URL =
  "https://p.secure.freee.co.jp/approval_requests#/requests/new?type=ApprovalRequest::MonthlyAttendance&target_year=2026&target_month=2";

(async () => {
  const browser = await chromium.launch({ headless: false, slowMo: 100 });
  const context = await browser.newContext();
  const page = await context.newPage();

  console.log("[1] Navigating to freee login page...");
  await page.goto(TARGET_URL);

  // Wait for user to log in — poll until we leave accounts.secure.freee.co.jp
  console.log("[2] Waiting for you to log in... (watching URL)");
  await page.waitForURL(
    (url) => !url.hostname.includes("accounts.secure.freee.co.jp"),
    { timeout: 120_000 },
  );
  console.log("[3] Logged in! Current URL:", page.url());

  // Give the SPA time to render
  await page.waitForTimeout(3000);

  // Navigate directly to the monthly closing form
  console.log("[4] Navigating to monthly closing form...");
  await page.goto(TARGET_URL);
  await page.waitForTimeout(3000);

  console.log("[5] Current URL after nav:", page.url());

  // Screenshot
  const shot1 = "screenshots/explore-monthly-form-1.png";
  await page.screenshot({ path: shot1, fullPage: true });
  console.log("[6] Screenshot saved:", shot1);

  // Dump all visible text + input selectors
  const formInfo = await page.evaluate(() => {
    const inputs = [
      ...document.querySelectorAll("input, select, textarea, button"),
    ].map((el) => ({
      tag: el.tagName,
      type: el.type || null,
      name: el.name || null,
      id: el.id || null,
      placeholder: el.placeholder || null,
      value: el.value || null,
      text: el.innerText?.trim().slice(0, 80) || null,
      className: el.className?.slice(0, 60) || null,
    }));
    const headings = [...document.querySelectorAll("h1,h2,h3,label,th")].map(
      (el) => el.innerText?.trim().slice(0, 100),
    );
    return { inputs, headings, title: document.title, url: location.href };
  });
  console.log("\n[7] Page title:", formInfo.title);
  console.log("[7] Page URL:", formInfo.url);
  console.log("\n[7] Headings/Labels:");
  formInfo.headings.forEach((h) => console.log("   ", h));
  console.log("\n[7] Form elements:");
  formInfo.inputs.forEach((el) => console.log("   ", JSON.stringify(el)));

  // Wait a bit so user can inspect, then close
  console.log(
    "\n[Done] Keeping browser open for 30s so you can inspect manually...",
  );
  await page.waitForTimeout(30_000);

  await browser.close();
})();
