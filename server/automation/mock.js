import chalk from "chalk";
import { FREEE_STATE } from "../constants.js";
import { ACTION_LABELS } from "./constants.js";
import { isActionValidForState } from "./scheduling.js";

// In-memory mock state for the session
let mockState = FREEE_STATE.NOT_CHECKED_IN;
let mockStateDate = "";

export function resetMockStateIfNewDay() {
  const today = new Date().toISOString().slice(0, 10);
  if (mockStateDate !== today) {
    mockState = FREEE_STATE.NOT_CHECKED_IN;
    mockStateDate = today;
  }
}

export function mockDetectState() {
  resetMockStateIfNewDay();
  return mockState;
}

function mockTransition(actionType) {
  resetMockStateIfNewDay();
  switch (actionType) {
    case "checkin":
      mockState = FREEE_STATE.WORKING;
      break;
    case "break_start":
      mockState = FREEE_STATE.ON_BREAK;
      break;
    case "break_end":
      mockState = FREEE_STATE.WORKING;
      break;
    case "checkout":
      mockState = FREEE_STATE.CHECKED_OUT;
      break;
  }
}

export async function mockExecuteAction(actionType) {
  console.log(chalk.yellow(`[MOCK] Simulating ${ACTION_LABELS[actionType]}`));
  await new Promise((r) => setTimeout(r, 300 + Math.random() * 700));

  // Validate transition
  const valid = isActionValidForState(actionType, mockDetectState());
  if (!valid.ok) {
    return {
      status: "skipped",
      screenshotBefore: null,
      screenshotAfter: null,
      durationMs: 100,
      error: valid.reason,
      mock: true,
      detectedState: mockDetectState(),
    };
  }

  mockTransition(actionType);
  console.log(
    chalk.green(
      `[MOCK] ${ACTION_LABELS[actionType]} done -> state=${mockState}`,
    ),
  );

  return {
    status: "success",
    screenshotBefore: null,
    screenshotAfter: null,
    durationMs: Math.floor(300 + Math.random() * 1500),
    error: null,
    mock: true,
    detectedState: mockState,
  };
}
