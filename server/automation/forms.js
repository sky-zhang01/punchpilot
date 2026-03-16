import chalk from "chalk";
import { FREEE_ERROR_MESSAGES } from "../constants.js";
import { APPROVAL_TYPE_MAP } from "./constants.js";

/**
 * Submit a work time correction via freee Web form (勤務時間修正申請).
 * This navigates directly to the correction form URL with the target date,
 * fills in times, and clicks submit.
 *
 * @param {import('./punch-bot.js').PunchBot} bot
 * @param {string} date — YYYY-MM-DD
 * @param {object} times — { clockInHour, clockInMin, clockOutHour, clockOutMin, breakStartHour?, breakStartMin?, breakEndHour?, breakEndMin? }
 * @param {string} [reason] — 申請理由 text
 * @returns {{ success: boolean, error?: string }}
 */
export async function submitWorkTimeCorrection(bot, date, times, reason) {
  const formUrl = `https://p.secure.freee.co.jp/approval_requests#/requests/new?type=ApprovalRequest::WorkTime&target_date=${date}`;
  console.log(chalk.blue(`[Bot] Navigating to correction form: ${formUrl}`));

  await bot.navigateToSpaForm(formUrl);

  // Wait for the form to render — try both selectors for forward-compatibility
  const dateInput = bot.page
    .locator("#approval-request-date-input, #approval-request-fields-date")
    .first();
  await bot.waitForElement(
    async () => (await dateInput.count()) > 0,
    formUrl,
    { debugPrefix: `web-correction-${date}` },
  );
  const dateValue = await dateInput.inputValue();
  if (dateValue !== date) {
    console.log(
      chalk.yellow(`[Bot] Date mismatch: expected ${date}, got ${dateValue}`),
    );
  }

  // Ensure "勤務時間を修正する" radio is selected (default, but be explicit)
  const modifyRadio = bot.page.locator(
    '[data-testid="clear-work-time-false"]',
  );
  if ((await modifyRadio.count()) > 0) {
    await modifyRadio.click();
    await bot.page.waitForTimeout(300);
  }

  // Helper: fill a combobox time input
  const fillTimeInput = async (id, value) => {
    const input = bot.page.locator(`#${id}`);
    if ((await input.count()) === 0) {
      throw new Error(`Time input #${id} not found`);
    }
    await input.click();
    await bot.page.waitForTimeout(200);
    await input.fill(String(value).padStart(2, "0"));
    await bot.page.waitForTimeout(200);
    await bot.page.keyboard.press("Tab");
    await bot.page.waitForTimeout(200);
  };

  // Fill check-in time
  await fillTimeInput(
    "approval-request-fields-segment-clock-in-at-hour-0",
    times.clockInHour,
  );
  await fillTimeInput(
    "approval-request-fields-segment-clock-in-at-minute-0",
    times.clockInMin,
  );

  // Fill check-out time
  await fillTimeInput(
    "approval-request-fields-segment-clock-out-at-hour-0",
    times.clockOutHour,
  );
  await fillTimeInput(
    "approval-request-fields-segment-clock-out-at-minute-0",
    times.clockOutMin,
  );

  // Fill break times (if provided), or remove the default empty break row
  if (
    times.breakStartHour !== undefined &&
    times.breakEndHour !== undefined
  ) {
    await fillTimeInput(
      "approval-request-fields-break-clock-in-at-hour-0",
      times.breakStartHour,
    );
    await fillTimeInput(
      "approval-request-fields-break-clock-in-at-minute-0",
      times.breakStartMin,
    );
    await fillTimeInput(
      "approval-request-fields-break-clock-out-at-hour-0",
      times.breakEndHour,
    );
    await fillTimeInput(
      "approval-request-fields-break-clock-out-at-minute-0",
      times.breakEndMin,
    );
  } else {
    // No break data — remove the default empty break row (freee adds one by default)
    // The delete button is near the break time inputs (trash icon button)
    try {
      const breakDeleteBtn = bot.page
        .locator('button[aria-label*="削除"], button[aria-label*="休憩"]')
        .first();
      if ((await breakDeleteBtn.count()) > 0) {
        await breakDeleteBtn.click();
        await bot.page.waitForTimeout(300);
        console.log(chalk.blue("[Bot] Removed empty break row"));
      } else {
        // Fallback: find the trash icon button near break fields
        const breakSection = bot.page.locator(
          "#approval-request-fields-break-clock-in-at-hour-0",
        );
        if ((await breakSection.count()) > 0) {
          // The delete button is a sibling in the same row — find it by proximity
          const rowBtns = await bot.page.evaluate(() => {
            const breakInput = document.getElementById(
              "approval-request-fields-break-clock-in-at-hour-0",
            );
            if (!breakInput) return null;
            // Walk up to find the row container
            let row = breakInput;
            for (let i = 0; i < 10 && row.parentElement; i++) {
              row = row.parentElement;
              const btns = row.querySelectorAll("button");
              if (btns.length > 0) {
                // Find the delete/trash button (usually last button with an SVG icon)
                for (const btn of btns) {
                  const svg = btn.querySelector("svg");
                  if (svg && !btn.textContent?.trim()) {
                    btn.click();
                    return "clicked";
                  }
                }
              }
            }
            return null;
          });
          if (rowBtns === "clicked") {
            await bot.page.waitForTimeout(300);
            console.log(chalk.blue("[Bot] Removed empty break row (via JS)"));
          }
        }
      }
    } catch (breakErr) {
      console.log(
        chalk.yellow(
          `[Bot] Could not remove empty break row: ${breakErr.message}`,
        ),
      );
    }
  }

  // Fill reason
  if (reason) {
    const reasonInput = bot.page.locator('[data-testid="申請理由"]');
    if ((await reasonInput.count()) > 0) {
      await reasonInput.click();
      await bot.page.waitForTimeout(200);
      await reasonInput.fill(reason);
      await bot.page.waitForTimeout(200);
    }
  }

  // Select approver — freee uses vibes vb-comboBox (not <select>)
  // Input: id="approval-request-fields-approver_id", placeholder="選択してください"
  // The listbox options are covered by adjacent combobox overlays, so we use
  // page.evaluate() to programmatically click instead of Playwright .click()
  try {
    const approverInput = bot.page.locator(
      "#approval-request-fields-approver_id",
    );
    if ((await approverInput.count()) > 0) {
      const currentVal = await approverInput.inputValue();
      if (!currentVal) {
        // Scroll the approver input into view first
        await approverInput.scrollIntoViewIfNeeded();
        await bot.page.waitForTimeout(300);

        // Click the input to open the dropdown
        await approverInput.click();
        await bot.page.waitForTimeout(800);

        // Get the listbox ID and select the first option via JS (bypasses overlay interception)
        const approverName = await bot.page.evaluate(() => {
          const input = document.getElementById(
            "approval-request-fields-approver_id",
          );
          if (!input) return null;
          const listboxId = input.getAttribute("aria-controls");
          if (!listboxId) return null;
          const listbox = document.getElementById(listboxId);
          if (!listbox) return null;
          const firstOption = listbox.querySelector('[role="option"]');
          if (!firstOption) return null;
          const name = firstOption.textContent?.trim();
          // Dispatch click event directly on the option element
          firstOption.dispatchEvent(
            new MouseEvent("mousedown", { bubbles: true }),
          );
          firstOption.dispatchEvent(
            new MouseEvent("mouseup", { bubbles: true }),
          );
          firstOption.dispatchEvent(
            new MouseEvent("click", { bubbles: true }),
          );
          return name;
        });

        await bot.page.waitForTimeout(500);

        if (approverName) {
          // Verify the input now has a value
          const newVal = await approverInput.inputValue();
          if (newVal) {
            console.log(
              chalk.green(
                `[Bot] Selected approver: ${approverName} (confirmed: ${newVal})`,
              ),
            );
          } else {
            // If dispatchEvent didn't trigger React state update, try keyboard approach
            console.log(
              chalk.yellow(
                `[Bot] Click dispatch didn't set value, trying keyboard...`,
              ),
            );
            await approverInput.click();
            await bot.page.waitForTimeout(500);
            await bot.page.keyboard.press("ArrowDown");
            await bot.page.waitForTimeout(200);
            await bot.page.keyboard.press("Enter");
            await bot.page.waitForTimeout(500);
            const retryVal = await approverInput.inputValue();
            console.log(
              chalk.green(`[Bot] Approver after keyboard: "${retryVal}"`),
            );
          }
        } else {
          console.log(
            chalk.yellow("[Bot] No approver options found in listbox"),
          );
        }
      } else {
        console.log(
          chalk.green(`[Bot] Approver already selected: ${currentVal}`),
        );
      }
    } else {
      console.log(
        chalk.yellow(
          "[Bot] Approver input #approval-request-fields-approver_id not found",
        ),
      );
    }
  } catch (approverErr) {
    console.log(
      chalk.yellow(`[Bot] Approver selection error: ${approverErr.message}`),
    );
  }

  const screenshots = bot.takeScreenshots(`web-correction-${date}`);
  const beforePath = await screenshots.before();

  // Click submit button
  console.log(chalk.blue(`[Bot] Submitting correction for ${date}...`));
  const submitBtn = bot.page
    .locator('button[type="submit"]')
    .filter({ hasText: "申請" });
  if ((await submitBtn.count()) === 0) {
    throw new Error("Submit button not found");
  }
  await submitBtn.click();
  await bot.page.waitForTimeout(5000);

  const afterPath = await screenshots.after();

  // Check for errors
  const result = await bot.checkSubmitResult();
  if (!result.success) {
    console.log(
      chalk.red(`[Bot] Correction form error for ${date}: ${result.error}`),
    );
    return {
      success: false,
      error: result.error,
      screenshotBefore: beforePath,
      screenshotAfter: afterPath,
    };
  }

  // If we're still on the same form URL, check for validation errors
  const postSubmitUrl = bot.page.url();
  if (postSubmitUrl.includes("requests/new")) {
    const hasError = await bot.page
      .locator('.vb-message--error, [role="alert"]')
      .count();
    if (hasError > 0) {
      const errorText = await bot.page
        .locator('.vb-message--error, [role="alert"]')
        .first()
        .textContent();
      return {
        success: false,
        error: errorText || "Validation error",
        screenshotBefore: beforePath,
        screenshotAfter: afterPath,
      };
    }
  }

  console.log(chalk.green(`[Bot] Correction submitted for ${date}`));
  return {
    success: true,
    screenshotBefore: beforePath,
    screenshotAfter: afterPath,
  };
}

/**
 * Scrape employee profile information from freee Web.
 * Navigates to the profile page and extracts key fields.
 *
 * @param {import('./punch-bot.js').PunchBot} bot
 * @param {string|number} employeeId — freee employee ID
 * @returns {object} Employee info: { name, department, position, employment_type, entry_date, employee_num, ... }
 */
export async function scrapeEmployeeInfo(bot, employeeId) {
  const profileUrl = `https://p.secure.freee.co.jp/employees/${employeeId}/profile`;
  console.log(
    chalk.blue(`[Bot] Navigating to employee profile: ${profileUrl}`),
  );

  // First try the newer URL format
  await bot.page.goto(profileUrl);
  await bot.page.waitForTimeout(4000);

  // If redirected to a different page, try the hash-based format
  if (!bot.page.url().includes("profile")) {
    const altUrl = `https://p.secure.freee.co.jp/employees#${employeeId}/profile`;
    console.log(chalk.blue(`[Bot] Trying alternative URL: ${altUrl}`));
    await bot.page.goto(altUrl);
    await bot.page.waitForTimeout(4000);
  }

  // Extract employee info from the page
  const info = await bot.page.evaluate(() => {
    const result = {};
    const body = document.body.innerText;

    // Try to find common profile field patterns
    // freee profile pages typically show fields in label-value pairs
    const getFieldValue = (labels) => {
      for (const label of labels) {
        // Look for patterns like "姓名\nValue" or label in a dd/dt structure
        const regex = new RegExp(`${label}[\\s:：]*([^\\n]+)`, "i");
        const match = body.match(regex);
        if (match) return match[1].trim();
      }
      return null;
    };

    result.name = getFieldValue(["氏名", "名前", "Name"]);
    result.department = getFieldValue(["部門", "部署", "Department"]);
    result.position = getFieldValue(["役職", "Position", "Title"]);
    result.employment_type = getFieldValue(["雇用形態", "Employment"]);
    result.entry_date = getFieldValue(["入社日", "Entry Date", "入社年月日"]);
    result.employee_num = getFieldValue([
      "社員番号",
      "Employee Number",
      "Employee No",
    ]);

    // Also try to extract from structured elements
    const dts = document.querySelectorAll("dt, th, label");
    for (const dt of dts) {
      const text = dt.textContent.trim();
      const dd = dt.nextElementSibling;
      const value = dd ? dd.textContent.trim() : null;
      if (!value) continue;

      if (text.includes("氏名") || text.includes("名前"))
        result.name = result.name || value;
      if (text.includes("部門") || text.includes("部署"))
        result.department = result.department || value;
      if (text.includes("役職")) result.position = result.position || value;
      if (text.includes("雇用形態"))
        result.employment_type = result.employment_type || value;
      if (text.includes("入社日") || text.includes("入社年月日"))
        result.entry_date = result.entry_date || value;
      if (text.includes("社員番号"))
        result.employee_num = result.employee_num || value;
    }

    return result;
  });

  console.log(
    chalk.green(`[Bot] Employee info scraped: ${JSON.stringify(info)}`),
  );
  return info;
}

/**
 * Submit a leave request via freee Web form.
 *
 * @param {import('./punch-bot.js').PunchBot} bot
 * @param {string} type — e.g. 'PaidHoliday', 'SpecialHoliday', 'Absence', 'HolidayWork'
 * @param {string} date — YYYY-MM-DD
 * @param {object} options — { halfDay?: boolean, reason?: string }
 * @returns {{ success: boolean, error?: string }}
 */
export async function submitLeaveRequest(bot, type, date, options = {}) {
  const freeeType =
    APPROVAL_TYPE_MAP[type] || `ApprovalRequest::${type}`;
  const formUrl = `https://p.secure.freee.co.jp/approval_requests#/requests/new?type=${freeeType}&target_date=${date}`;
  console.log(
    chalk.blue(`[Bot] Navigating to leave request form: ${formUrl}`),
  );

  await bot.navigateToSpaForm(formUrl, { finalWaitMs: 4000 });

  // Wait for date input to appear
  const dateInput = bot.page.locator("#approval-request-fields-date");
  await bot.waitForElement(
    async () => (await dateInput.count()) > 0,
    formUrl,
    { debugPrefix: `leave-${type}-${date}` },
  );

  // Fill time fields if provided (for OvertimeWork, PaidHoliday half/hour)
  if (options.startTime) {
    const startInput = bot.page.locator(
      "#approval-request-fields-started-at",
    );
    if ((await startInput.count()) > 0) {
      await startInput.click();
      await bot.page.waitForTimeout(200);
      await startInput.fill(options.startTime);
      await bot.page.keyboard.press("Tab");
      await bot.page.waitForTimeout(200);
    }
  }
  if (options.endTime) {
    const endInput = bot.page.locator("#approval-request-fields-end-at");
    if ((await endInput.count()) > 0) {
      await endInput.click();
      await bot.page.waitForTimeout(200);
      await endInput.fill(options.endTime);
      await bot.page.keyboard.press("Tab");
      await bot.page.waitForTimeout(200);
    }
  }

  // Fill reason if provided
  if (options.reason) {
    const reasonInput = bot.page.locator('[data-testid="申請理由"]');
    if ((await reasonInput.count()) > 0) {
      await reasonInput.click();
      await bot.page.waitForTimeout(200);
      await reasonInput.fill(options.reason);
      await bot.page.waitForTimeout(200);
    }
  }

  // Select approval route if available
  const routeSelect = bot.page.locator("#approval-request-fields-route-id");
  if ((await routeSelect.count()) > 0 && options.routeId) {
    await routeSelect.selectOption(String(options.routeId));
    await bot.page.waitForTimeout(300);
  }

  // Select approver if needed
  if (options.approverId) {
    const approverInput = bot.page.locator(
      "#approval-request-fields-approver_id",
    );
    if ((await approverInput.count()) > 0) {
      await approverInput.click();
      await bot.page.waitForTimeout(500);
      await approverInput.fill("");
      await bot.page.waitForTimeout(500);
      // Select first option from the dropdown
      const listboxId = await approverInput.getAttribute("aria-controls");
      if (listboxId) {
        const firstOption = bot.page
          .locator(`#${listboxId} [role="option"]`)
          .first();
        if ((await firstOption.count()) > 0) {
          await firstOption.click();
          await bot.page.waitForTimeout(300);
        }
      }
    }
  }

  const screenshots = bot.takeScreenshots(`leave-${type}-${date}`);
  await screenshots.before();

  // Submit
  console.log(chalk.blue(`[Bot] Submitting ${type} leave for ${date}...`));
  const submitBtn = bot.page
    .locator('button[type="submit"]')
    .filter({ hasText: "申請" });
  if ((await submitBtn.count()) === 0) {
    throw new Error("Submit button not found");
  }
  await submitBtn.click();
  await bot.page.waitForTimeout(5000);

  await screenshots.after();

  // Check for errors
  const result = await bot.checkSubmitResult();
  if (!result.success) {
    return { success: false, error: result.error };
  }

  console.log(
    chalk.green(`[Bot] Leave request submitted: ${type} for ${date}`),
  );
  return { success: true };
}

/**
 * Withdraw (取下げ) an approval request via freee Web.
 * Navigates to the request detail page and clicks the withdraw button.
 *
 * @param {import('./punch-bot.js').PunchBot} bot
 * @param {string} type — freee type e.g. 'PaidHoliday', 'WorkTime', 'OvertimeWork'
 * @param {string|number} requestId — freee approval request ID
 * @returns {{ success: boolean, error?: string }}
 */
export async function withdrawApprovalRequest(bot, type, requestId) {
  const freeeType =
    APPROVAL_TYPE_MAP[type] || `ApprovalRequest::${type}`;
  const detailUrl = `https://p.secure.freee.co.jp/approval_requests#requests/${requestId}?type=${encodeURIComponent(freeeType)}`;
  console.log(
    chalk.blue(`[Bot] Navigating to approval request detail: ${detailUrl}`),
  );

  await bot.navigateToSpaForm(detailUrl, {
    finalWaitMs: 4000,
    useLocationHref: true,
  });

  // Wait for detail page — look for withdraw button text or request status
  await bot.waitForElement(
    async () => {
      const bodyText = await bot.page
        .evaluate(() => document.body.innerText.substring(0, 3000))
        .catch(() => "");
      return (
        bodyText.includes("取り下げ") ||
        bodyText.includes("取下げ") ||
        bodyText.includes("申請中") ||
        bodyText.includes("承認待ち")
      );
    },
    detailUrl,
    { debugPrefix: `withdraw-${type}-${requestId}` },
  );

  const screenshots = bot.takeScreenshots(
    `withdraw-${type}-${requestId}`,
  );
  const beforePath = await screenshots.before();

  // Find and click the 取下げ button
  let withdrawBtn = bot.page
    .locator("button")
    .filter({ hasText: "取り下げ" });
  if ((await withdrawBtn.count()) === 0) {
    withdrawBtn = bot.page.locator("button").filter({ hasText: "取下げ" });
  }
  if ((await withdrawBtn.count()) === 0) {
    withdrawBtn = bot.page
      .locator("a, button")
      .filter({ hasText: /取り?下げ/ });
  }

  if ((await withdrawBtn.count()) === 0) {
    const bodyText = await bot.page
      .evaluate(() => document.body.innerText.substring(0, 2000))
      .catch(() => "");
    console.log(
      chalk.red(
        `[Bot] Withdraw button not found. Page text: ${bodyText.substring(0, 300)}`,
      ),
    );
    return {
      success: false,
      error: "Withdraw button (取下げ) not found on page",
      screenshotBefore: beforePath,
    };
  }

  console.log(chalk.blue(`[Bot] Clicking withdraw button...`));
  await withdrawBtn.first().click();
  await bot.page.waitForTimeout(2000);

  // Handle confirmation dialog
  const confirmBtn = bot.page
    .locator("button")
    .filter({ hasText: /^(OK|はい|確認|取り下げ(する|る)?|取下げ)$/ });
  if ((await confirmBtn.count()) > 0) {
    console.log(chalk.blue(`[Bot] Clicking confirm button in dialog...`));
    await confirmBtn.first().click();
    await bot.page.waitForTimeout(3000);
  }

  const afterPath = await screenshots.after();

  // Check for errors (withdraw-specific indicators)
  const result = await bot.checkSubmitResult({
    extraIndicators: ["取り下げできません", "削除できない"],
  });
  if (!result.success) {
    console.log(chalk.red(`[Bot] Withdrawal failed: ${result.error}`));
    return {
      success: false,
      error: result.error,
      screenshotBefore: beforePath,
      screenshotAfter: afterPath,
    };
  }

  console.log(
    chalk.green(
      `[Bot] Approval request ${type}-${requestId} withdrawn successfully`,
    ),
  );
  return {
    success: true,
    screenshotBefore: beforePath,
    screenshotAfter: afterPath,
  };
}

/**
 * Submit monthly attendance closing via freee Web form (月次勤怠締め申請).
 * Used as fallback when API returns 400 for companies with dept/role-based routing
 * (役職、部門を利用する申請はWebから申請してください).
 *
 * The form is pre-populated from URL params (target_year, target_month) and the
 * user's department — only the "申請" submit button needs to be clicked.
 *
 * @param {import('./punch-bot.js').PunchBot} bot
 * @param {number|string} year — e.g. 2026
 * @param {number|string} month — e.g. 2
 * @returns {{ success: boolean, screenshotBefore: string, screenshotAfter: string }}
 */
export async function submitMonthlyClosingWeb(bot, year, month) {
  const formUrl = `https://p.secure.freee.co.jp/approval_requests#/requests/new?type=ApprovalRequest::MonthlyAttendance&target_year=${year}&target_month=${month}`;
  console.log(
    chalk.blue(`[Bot] Navigating to monthly closing form: ${formUrl}`),
  );

  await bot.navigateToSpaForm(formUrl);

  // Wait for the "申請" submit button to appear (form is pre-populated from URL params)
  const submitBtn = bot.page
    .locator("button.vb-button--appearancePrimary")
    .filter({ hasText: "申請" });
  await bot.waitForElement(
    async () => (await submitBtn.count()) > 0,
    formUrl,
    { debugPrefix: `monthly-closing-${year}-${month}` },
  );

  const screenshots = bot.takeScreenshots(
    `monthly-closing-${year}-${month}`,
  );
  const beforePath = await screenshots.before();

  console.log(
    chalk.blue(
      `[Bot] Clicking 申請 button for ${year}-${month} monthly closing`,
    ),
  );
  await submitBtn.click();
  await bot.page.waitForTimeout(3000);

  const afterPath = await screenshots.after();

  // If still on the form page, check whether freee blocked it as duplicate
  const finalUrl = bot.page.url();
  if (finalUrl.includes("/requests/new")) {
    const bodyText = await bot.page
      .evaluate(() => document.body.innerText.substring(0, 2000))
      .catch(() => "");

    if (
      bodyText.includes(
        FREEE_ERROR_MESSAGES.MONTHLY_CLOSING_ALREADY_SUBMITTED,
      )
    ) {
      console.log(
        chalk.green(
          `[Bot] Monthly closing already exists for ${year}-${month} — treating as success (already_submitted)`,
        ),
      );
      return {
        success: true,
        alreadySubmitted: true,
        screenshotBefore: beforePath,
        screenshotAfter: afterPath,
      };
    }

    throw new Error(
      `Monthly closing submission may have failed — still on form page. Content: ${bodyText.substring(0, 200)}`,
    );
  }

  console.log(
    chalk.green(
      `[Bot] Monthly closing submitted successfully for ${year}-${month}`,
    ),
  );
  return {
    success: true,
    alreadySubmitted: false,
    screenshotBefore: beforePath,
    screenshotAfter: afterPath,
  };
}
