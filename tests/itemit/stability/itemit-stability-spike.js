// Scenario 4 — SPIKE: 1 VU baseline → 20–30 VUs for 1–2 min → back to 1 VU.
// Goal: does the server recover on its own, or stay slow after the spike?
// Compare the "baseline" row with "recovery_late" in the trend table.
// ⚠️ Warn the team before running; make sure nobody is running Cypress at the same time.
import { initRun, stabilitySetup, sweepLeftovers } from "./lib/client.js";
import { runJourney } from "./lib/journey.js";
import { trendSubmetrics, buildSummary } from "./lib/summary.js";
import { assertTestEnvironment, BASE_THRESHOLDS, SUMMARY_TREND_STATS, displaySubmetrics, allRequestNames } from "./lib/config.js";

assertTestEnvironment();

const SPIKE_VUS    = parseInt(__ENV.SPIKE_VUS || "25");
const SPIKE_MIN    = parseInt(__ENV.SPIKE_MIN || "2");
const BASELINE_MIN = parseInt(__ENV.BASELINE_MIN || "5");
const LOGIN_MODE   = __ENV.LOGIN_MODE || "vu";
const PHASES       = ["baseline", "spike", "recovery_early", "recovery_late"];

// Errors during the spike itself are acceptable — the global failure threshold is replaced by a recovery one
const { http_req_failed: _ignored, ...THRESHOLDS_WITHOUT_GLOBAL_FAILED } = BASE_THRESHOLDS;

const phase = (tag, vus, start, duration) => ({
  executor: "constant-vus", vus, startTime: `${start}m`, duration: `${duration}m`,
  gracefulStop: "30s", tags: { phase: tag },
});

export const options = {
  scenarios: {
    baseline:       phase("baseline",       1,         0,                            BASELINE_MIN),
    spike:          phase("spike",          SPIKE_VUS, BASELINE_MIN,                 SPIKE_MIN),
    recovery_early: phase("recovery_early", 1,         BASELINE_MIN + SPIKE_MIN,     5),   // first 5 min after spike
    recovery_late:  phase("recovery_late",  1,         BASELINE_MIN + SPIKE_MIN + 5, 10),  // should match baseline
  },
  summaryTrendStats: SUMMARY_TREND_STATS,
  thresholds: {
    ...displaySubmetrics("http_req_duration", allRequestNames().map((name) => ({ name }))),
    ...trendSubmetrics("phase", PHASES),
    ...THRESHOLDS_WITHOUT_GLOBAL_FAILED,
    "http_req_failed{phase:recovery_late}":               ["rate<0.01"],
    "http_req_duration{phase:recovery_late,target:api}":  ["p(95)<2000"],
  },
};

export function setup() {
  return stabilitySetup("tests/itemit/stability/itemit-stability-spike.js",
    `Spike: 1 VU ${BASELINE_MIN}m → ${SPIKE_VUS} VUs ${SPIKE_MIN}m → 1 VU 15m, login per ${LOGIN_MODE}`);
}

export default function (data) {
  initRun(data);
  runJourney(data, { loginMode: LOGIN_MODE });
}

export function teardown(data) {
  sweepLeftovers(data.workspaceId);
}

export function handleSummary(data) {
  return buildSummary(data, "itemit-stability-spike", "phase", PHASES);
}
