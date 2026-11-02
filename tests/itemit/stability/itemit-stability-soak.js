// Scenario 1 (most important) — SOAK: 1–3 VUs for 3 hours, each iteration = one typical Cypress test.
// Goal: does response time grow over time, and from which minute do errors start?
// Cypress produces ~1 user of load for hours and failures started after 1–2 h — this reproduces that.
import { initRun, setWindowTag, windowLabels, stabilitySetup, sweepLeftovers } from "./lib/client.js";
import { runJourney } from "./lib/journey.js";
import { trendSubmetrics, buildSummary } from "./lib/summary.js";
import { assertTestEnvironment, BASE_THRESHOLDS, SUMMARY_TREND_STATS, displaySubmetrics, allRequestNames } from "./lib/config.js";

assertTestEnvironment();

const VUS            = parseInt(__ENV.VUS || "2");          // 1–3
const DURATION_MIN   = parseInt(__ENV.DURATION_MIN || "180");
const WINDOW_MIN     = parseInt(__ENV.WINDOW_MIN || "30");   // trend table granularity
const LOGIN_MODE     = __ENV.LOGIN_MODE || "iteration";      // Cypress logs in on every test
const WINDOWS        = windowLabels(DURATION_MIN, WINDOW_MIN);

export const options = {
  scenarios: {
    soak: {
      executor:  "constant-vus",
      vus:       VUS,
      duration:  `${DURATION_MIN}m`,
      gracefulStop: "60s",
    },
  },
  summaryTrendStats: SUMMARY_TREND_STATS,
  thresholds: {
    ...displaySubmetrics("http_req_duration", allRequestNames().map((name) => ({ name }))), // p95/p99 per request
    ...trendSubmetrics("window", WINDOWS),
    ...BASE_THRESHOLDS,
    "http_req_duration{target:frontend}": ["p(95)<3000"],
    "errors{type:timeout}":               ["count<1"],
    "errors{type:5xx}":                   ["count<1"],
  },
};

export function setup() {
  return stabilitySetup("tests/itemit/stability/itemit-stability-soak.js",
    `Soak: ${VUS} VU × ${DURATION_MIN} min, login per ${LOGIN_MODE}, windows of ${WINDOW_MIN} min`);
}

export default function (data) {
  initRun(data);
  setWindowTag(WINDOW_MIN);
  runJourney(data, { loginMode: LOGIN_MODE });
}

export function teardown(data) {
  sweepLeftovers(data.workspaceId);
}

export function handleSummary(data) {
  return buildSummary(data, "itemit-stability-soak", "window", WINDOWS);
}
