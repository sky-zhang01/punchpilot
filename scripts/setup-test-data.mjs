#!/usr/bin/env node
/**
 * Explore freee admin pages for:
 * 1. Company switching to テスト事業所
 * 2. Paid holiday granting (有給休暇付与)
 * 3. Special holiday settings (特別休暇設定)
 */
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const SCREENSHOTS_DIR = '/Users/sky_zhang01/Downloads/punchpilot/screenshots';
fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

const FREEE_EMAIL = process.env.FREEE_EMAIL;
const FREEE_PASSWORD = process.env.FREEE_PASSWORD;

if (!FREEE_EMAIL || !FREEE_PASSWORD) {
  console.error('Set FREEE_EMAIL and FREEE_PASSWORD env vars');
  process.exit(1);
}

let shotN = 0;
async function shot(page, label) {
  shotN++;
  const p = path.join(SCREENSHOTS_DIR, `explore-${String(shotN).padStart(2,'0')}-${label}.png`);
  await page.screenshot({ path: p, fullPage: false });
  console.log(`  [SS] ${p}`);
  return p;
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'ja-JP' })).newPage();

  try {
    // ─── Login via p.secure.freee.co.jp (same as automation.js) ───
    console.log('=== Step 1: Login ===');
    await page.goto('https://p.secure.freee.co.jp/');
    await page.waitForTimeout(3000);
    await page.fill("input[name='loginId']", FREEE_EMAIL);
    await page.fill("input[name='password']", FREEE_PASSWORD);
    await page.click("button[type='submit']");
    await page.waitForTimeout(5000);

    const afterLoginUrl = page.url();
    console.log('After login URL:', afterLoginUrl);
    await shot(page, 'after-login');

    // Check current company
    const headerText = await page.evaluate(() => {
      const header = document.querySelector('header') || document.body;
      return header.innerText.substring(0, 500);
    });
    console.log('Header:', headerText.substring(0, 200));

    // ─── Step 2: Switch to テスト事業所 ───
    console.log('\n=== Step 2: Switch company ===');
    // Click the company name in top-right to open switcher
    const companyBtn = page.locator('header').locator('button, a, [role="button"]').filter({ hasText: /GCU|事業所|会社/ }).first();
    if ((await companyBtn.count()) > 0) {
      console.log('Found company button, clicking...');
      await companyBtn.click();
      await page.waitForTimeout(2000);
      await shot(page, 'company-dropdown');

      // Look for テスト事業所
      const testCompanyLink = page.locator('a, button, li, [role="menuitem"], [role="option"]').filter({ hasText: 'テスト事業所' }).first();
      if ((await testCompanyLink.count()) > 0) {
        console.log('Found テスト事業所 link, clicking...');
        await testCompanyLink.click();
        await page.waitForTimeout(5000);
        await shot(page, 'after-company-switch');
        console.log('Switched! URL:', page.url());
      } else {
        console.log('テスト事業所 not in dropdown, listing all options...');
        const allOptions = await page.locator('[role="menuitem"], [role="option"], .company-item, li a').allInnerTexts();
        console.log('Dropdown options:', allOptions.join(' | '));
        await shot(page, 'dropdown-items');
      }
    } else {
      console.log('No company button in header. Scanning full header...');
      await shot(page, 'no-company-btn');
      // List all clickable elements in the top area
      const topElements = await page.locator('header a, header button, nav a, nav button').allInnerTexts();
      console.log('Top elements:', topElements.join(' | '));
    }

    // ─── Step 3: Explore employee list for 有給休暇 ───
    console.log('\n=== Step 3: Explore employees & 有給休暇 ===');
    await page.goto('https://p.secure.freee.co.jp/employees');
    await page.waitForTimeout(4000);
    await shot(page, 'employees-list');
    let pageText = await page.evaluate(() => document.body.innerText.substring(0, 3000));
    console.log('Employees page:', pageText.substring(0, 400));

    // Click on テスト太郎 if visible
    const testTaro = page.locator('a').filter({ hasText: 'テスト太郎' }).first();
    if ((await testTaro.count()) > 0) {
      await testTaro.click();
      await page.waitForTimeout(4000);
      await shot(page, 'employee-detail');
      pageText = await page.evaluate(() => document.body.innerText);
      console.log('Employee detail page:', pageText.substring(0, 800));

      // Look for 有給 or 休暇 links
      const holidayLinks = page.locator('a, button, [role="tab"]').filter({ hasText: /有給|年次有休|休暇/ });
      const count = await holidayLinks.count();
      console.log(`Found ${count} holiday-related links`);
      for (let i = 0; i < count; i++) {
        const t = await holidayLinks.nth(i).innerText().catch(() => '');
        const href = await holidayLinks.nth(i).getAttribute('href').catch(() => '');
        console.log(`  [${i}] "${t}" → ${href}`);
      }
      if (count > 0) {
        await holidayLinks.first().click();
        await page.waitForTimeout(3000);
        await shot(page, 'holiday-tab');
        pageText = await page.evaluate(() => document.body.innerText.substring(0, 2000));
        console.log('Holiday tab:', pageText.substring(0, 500));
      }
    } else {
      console.log('テスト太郎 not found on employees page');
    }

    // ─── Step 4: Settings page ───
    console.log('\n=== Step 4: Settings ===');
    await page.goto('https://p.secure.freee.co.jp/settings');
    await page.waitForTimeout(4000);
    await shot(page, 'settings-page');
    pageText = await page.evaluate(() => document.body.innerText);
    console.log('Settings page:', pageText.substring(0, 1500));

    // Look for all links on settings page
    const allSettingsLinks = await page.locator('a').all();
    console.log(`\nAll links on settings page (${allSettingsLinks.length}):`);
    for (const link of allSettingsLinks.slice(0, 30)) {
      const t = await link.innerText().catch(() => '');
      const href = await link.getAttribute('href').catch(() => '');
      if (t.trim() && href) console.log(`  "${t.trim()}" → ${href}`);
    }

    // ─── Step 5: Try known URLs ───
    console.log('\n=== Step 5: Try known admin URLs ===');
    const adminUrls = [
      'https://p.secure.freee.co.jp/settings/attendance_rules',
      'https://p.secure.freee.co.jp/settings/company',
      'https://p.secure.freee.co.jp/yearly_paid_leaves',
      'https://p.secure.freee.co.jp/special_holiday_settings',
    ];
    for (const url of adminUrls) {
      await page.goto(url);
      await page.waitForTimeout(2000);
      pageText = await page.evaluate(() => document.body.innerText.substring(0, 500));
      const is404 = pageText.includes('見つかりません') || pageText.includes('404');
      const isLogin = pageText.includes('ログイン') && !pageText.includes('ホーム');
      const slug = url.split('.co.jp')[1];
      console.log(`  ${slug}: ${is404 ? '404' : isLogin ? 'LOGIN' : 'OK'}`);
      if (!is404 && !isLogin) {
        await shot(page, slug.replace(/\//g, '_').substring(1));
        console.log(`    ${pageText.substring(0, 200)}`);
      }
    }

    await shot(page, 'final');
    console.log('\nDone!');

  } catch (err) {
    console.error('Error:', err.message);
    await shot(page, 'error').catch(() => {});
  } finally {
    await browser.close();
  }
}

main().catch(console.error);
