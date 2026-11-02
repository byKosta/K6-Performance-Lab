// Stress test: pushes item-profiles beyond normal capacity to find the breaking point
import http from "k6/http";
import { check, sleep } from "k6";
import { Trend, Rate, Counter } from "k6/metrics";
import { htmlReport } from "https://raw.githubusercontent.com/benc-uk/k6-reporter/main/dist/bundle.js";
import { textSummary } from "https://jslib.k6.io/k6-summary/0.1.0/index.js";
import { login, getDefaultWorkspace, buildAuthHeaders } from "../../../src/auth/login.js";

const responseTime = new Trend("stress_response_time_ms", true);
const errorRate    = new Rate("stress_error_rate");
const totalReqs    = new Counter("stress_total_requests");

// Stress stages: normal → elevated → stress → peak → recovery
// Adjust MAX_VUS for test env capacity (default 60 for test-api)
const MAX_VUS = __ENV.MAX_VUS ? parseInt(__ENV.MAX_VUS) : 60;

export const options = {
  scenarios: {
    stress: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "30s", target: Math.round(MAX_VUS * 0.2) },  // warm-up
        { duration: "1m",  target: Math.round(MAX_VUS * 0.5) },  // normal load
        { duration: "30s", target: MAX_VUS },                    // stress
        { duration: "1m",  target: MAX_VUS },                    // sustain stress
        { duration: "30s", target: Math.round(MAX_VUS * 1.5) },  // beyond capacity
        { duration: "1m",  target: Math.round(MAX_VUS * 1.5) },  // sustain beyond
        { duration: "1m",  target: 0 },                          // recovery
      ],
      gracefulRampDown: "30s",
    },
  },
  thresholds: {
    // Stress test: thresholds deliberately relaxed — we expect degradation
    http_req_failed:       ["rate<0.3"],   // tolerate up to 30% errors under extreme load
    stress_error_rate:     ["rate<0.3"],
    stress_response_time_ms: ["p(95)<10000"], // 10s max even under stress
  },
};

const BASE_URL = __ENV.BASE_URL || "https://test-api.itemit.com";

export function setup() {
  const email    = __ENV.EMAIL;
  const password = __ENV.PASSWORD;

  if (!email || !password) {
    throw new Error(
      "EMAIL and PASSWORD env vars required.\n" +
      "Run: k6 run -e EMAIL=you@example.com -e PASSWORD=pass -e MAX_VUS=60 tests/itemit/performance/itemit-stress.js"
    );
  }

  const { userId, userToken } = login(email, password);
  const workspaceId = __ENV.WORKSPACE_ID || getDefaultWorkspace(userId, userToken);
  const headers = buildAuthHeaders(userId, userToken, workspaceId);

  const res = http.get(`${BASE_URL}/v1/item-profiles?limit=100&skip=0`, { headers });
  if (res.status !== 200) {
    throw new Error(`Failed to fetch item profiles [${res.status}]: ${res.body}`);
  }

  const itemIds = res.json().results?.map((i) => i.id) || [];
  if (!itemIds.length) {
    throw new Error("No item profiles found — create some items first.");
  }

  console.log(`\n✔️  Stress test ready`);
  console.log(`   Item pool: ${itemIds.length} profiles`);
  console.log(`   Peak VUs : ${Math.round(MAX_VUS * 1.5)} (${Math.round(MAX_VUS * 1.5 / MAX_VUS * 100)}% above normal)\n`);

  return { userId, userToken, workspaceId, itemIds };
}

export default function (data) {
  const itemId = data.itemIds[Math.floor(Math.random() * data.itemIds.length)];

  const res = http.get(
    `${BASE_URL}/v1/item-profiles/${itemId}`,
    { headers: buildAuthHeaders(data.userId, data.userToken, data.workspaceId) }
  );

  totalReqs.add(1);
  responseTime.add(res.timings.duration);
  errorRate.add(res.status !== 200);

  check(res, {
    "Status 200":             () => res.status === 200,
    "No server error (500)":  () => res.status !== 500,
    "Response time < 10s":    () => res.timings.duration < 10_000,
  });

  // Log when system starts degrading (useful for breakpoint analysis)
  if (res.status === 429) {
    console.warn(`⚠️  Rate limited (429) — system throttling at ${__VU} VUs`);
  } else if (res.status === 503 || res.status === 502) {
    console.error(`❌ Service unavailable (${res.status}) — breaking point reached at ${__VU} VUs`);
  } else if (res.timings.duration > 5000) {
    console.warn(`⚠️  Slow response: ${res.timings.duration.toFixed(0)}ms at ${__VU} VUs`);
  }

  // Minimal think time — we want to stress the server
  sleep(Math.random() * 0.5);
}

export function handleSummary(data) {
  return {
    "reports/itemit-stress-report.html": htmlReport(data),
    stdout: textSummary(data, { indent: " ", enableColors: true }),
  };
}
