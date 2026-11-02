// Scenario 3 — RAMP-UP: 1 → 5 → 10 → 20 VUs, 10 minutes per step.
// Goal: capacity headroom — at which load level do latency degradation and errors start?
// ⚠️ Warn the team before running; make sure nobody is running Cypress at the same time.
import { initRun, stabilitySetup, sweepLeftovers } from "./lib/client.js";
import { runJourney } from "./lib/journey.js";
import { trendSubmetrics, buildSummary } from "./lib/summary.js";
import { assertTestEnvironment, BASE_THRESHOLDS, SUMMARY_TREND_STATS, displaySubmetrics, allRequestNames } from "./lib/config.js";

assertTestEnvironment();

const STEPS      = (__ENV.STEPS || "1,5,10,20").split(",").map(Number);
const STEP_MIN   = parseInt(__ENV.STEP_MIN || "10");
const LOGIN_MODE = __ENV.LOGIN_MODE || "vu"; // per-iteration login × 20 VUs would mostly measure the login rate limit
const STEP_TAGS  = STEPS.map((v) => `vus${String(v).padStart(2, "0")}`);

// One constant-vus scenario per step, started back to back → every request is tagged with its step
const scenarios = {};
STEPS.forEach((vus, i) => {
  scenarios[STEP_TAGS[i]] = {
    executor:     "constant-vus",
    vus,
    duration:     `${STEP_MIN}m`,
    startTime:    `${i * STEP_MIN}m`,
    gracefulStop: "30s",
    tags:         { step: STEP_TAGS[i] },
  };
});

export const options = {
  scenarios,
  summaryTrendStats: SUMMARY_TREND_STATS,
  thresholds: {
    ...displaySubmetrics("http_req_duration", allRequestNames().map((name) => ({ name }))),
    ...trendSubmetrics("step", STEP_TAGS),
    ...BASE_THRESHOLDS,
    "http_req_duration{target:frontend}": ["p(95)<3000"],
  },
};

export function setup() {
  return stabilitySetup("tests/itemit/stability/itemit-stability-ramp.js",
    `Ramp: ${STEPS.join(" → ")} VUs, ${STEP_MIN} min per step, login per ${LOGIN_MODE}`);
}

export default function (data) {
  initRun(data);
  runJourney(data, { loginMode: LOGIN_MODE });
}

export function teardown(data) {
  sweepLeftovers(data.workspaceId);
}

export function handleSummary(data) {
  return buildSummary(data, "itemit-stability-ramp", "step", STEP_TAGS);
}
