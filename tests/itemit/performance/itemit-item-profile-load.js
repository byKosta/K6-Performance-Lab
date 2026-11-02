import http from "k6/http";
import { check, sleep } from "k6";
import { Trend, Rate, Counter } from "k6/metrics";
import { htmlReport } from "https://raw.githubusercontent.com/benc-uk/k6-reporter/main/dist/bundle.js";
import { textSummary } from "https://jslib.k6.io/k6-summary/0.1.0/index.js";
import { login, getDefaultWorkspace, buildAuthHeaders } from "../../../src/auth/login.js";

const profileLoadTime = new Trend("item_profile_load_time_ms", true);
const profileErrorRate = new Rate("item_profile_error_rate");
const profileRequests = new Counter("item_profile_requests_total");

const TARGET_VUS = __ENV.VUS ? parseInt(__ENV.VUS) : 20;
const RAMP_UP   = __ENV.RAMP_UP   || "30s";
const STEADY    = __ENV.STEADY    || "2m";
const RAMP_DOWN = __ENV.RAMP_DOWN || "30s";

export const options = {
  scenarios: {
    item_profile_load: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: RAMP_UP,   target: TARGET_VUS },
        { duration: STEADY,    target: TARGET_VUS },
        { duration: RAMP_DOWN, target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_failed:          ["rate<0.05"],
    http_req_duration:        ["p(95)<3000", "p(99)<5000"],
    item_profile_load_time_ms: ["p(95)<3000", "p(99)<5000"],
    item_profile_error_rate:   ["rate<0.05"],
  },
};

const BASE_URL = __ENV.BASE_URL || "https://test-api.itemit.com";

// Runs once: login + collect item profile IDs to use during the test
export function setup() {
  const email    = __ENV.EMAIL;
  const password = __ENV.PASSWORD;

  if (!email || !password) {
    throw new Error(
      "EMAIL and PASSWORD env vars required.\n" +
      "Run: k6 run -e EMAIL=you@example.com -e PASSWORD=pass tests/itemit/performance/itemit-item-profile-load.js"
    );
  }

  const { userId, userToken } = login(email, password);
  const workspaceId = __ENV.WORKSPACE_ID || getDefaultWorkspace(userId, userToken);
  const headers = buildAuthHeaders(userId, userToken, workspaceId);

  // Fetch up to 100 item profile IDs to randomise requests during the test
  const res = http.get(`${BASE_URL}/v1/item-profiles?limit=100&skip=0`, { headers });

  if (res.status !== 200) {
    throw new Error(`Failed to fetch item profiles [${res.status}]: ${res.body}`);
  }

  const body = res.json();

  if (!body.results?.length) {
    throw new Error("No item profiles found in this workspace. Create some items first.");
  }

  const itemIds = body.results.map((item) => item.id);

  console.log(`\n✔️  Found ${itemIds.length} item profiles`);
  console.log(`✔️  Target VUs: ${TARGET_VUS} | Ramp-up: ${RAMP_UP} | Steady: ${STEADY}\n`);

  return { userId, userToken, workspaceId, itemIds };
}

export default function (data) {
  // Pick a random item from the pool on each iteration
  const itemId = data.itemIds[Math.floor(Math.random() * data.itemIds.length)];

  const res = http.get(
    `${BASE_URL}/v1/item-profiles/${itemId}`,
    { headers: buildAuthHeaders(data.userId, data.userToken, data.workspaceId) }
  );

  profileRequests.add(1);
  profileLoadTime.add(res.timings.duration);
  profileErrorRate.add(res.status !== 200);

  const json = res.json();

  check(res, {
    "Status 200":             () => res.status === 200,
    "Response has id":        () => json && !!json.id,
    "Response has name":      () => json && !!json.name,
    "Time to first byte < 1s": () => res.timings.waiting < 1000,
    "Response time < 3000ms": () => res.timings.duration < 3000,
  });

  if (res.status !== 200) {
    console.error(`❌ [${res.status}] item-profile/${itemId} — ${res.body?.substring(0, 200)}`);
  }

  // Simulate realistic think time between page loads
  sleep(Math.random() * 1 + 0.5);
}

export function handleSummary(data) {
  return {
    "reports/itemit-item-profile-load-report.html": htmlReport(data),
    stdout: textSummary(data, { indent: " ", enableColors: true }),
  };
}
