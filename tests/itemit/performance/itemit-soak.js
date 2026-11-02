// Soak test: sustained moderate load over long duration — detects memory leaks and degradation
import http from "k6/http";
import { check, sleep } from "k6";
import { Trend, Rate } from "k6/metrics";
import { htmlReport } from "https://raw.githubusercontent.com/benc-uk/k6-reporter/main/dist/bundle.js";
import { textSummary } from "https://jslib.k6.io/k6-summary/0.1.0/index.js";
import { login, getDefaultWorkspace, buildAuthHeaders } from "../../../src/auth/login.js";

// Separate trends per endpoint — allows spotting which call degrades over time
const profileTime   = new Trend("soak_item_profile_ms",  true);
const itemListTime  = new Trend("soak_items_list_ms",    true);
const workspaceTime = new Trend("soak_workspace_ms",     true);
const errorRate     = new Rate("soak_error_rate");

const SOAK_VUS      = __ENV.VUS      ? parseInt(__ENV.VUS)      : 10;
const SOAK_DURATION = __ENV.DURATION || "1h";

export const options = {
  scenarios: {
    soak: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "2m",          target: SOAK_VUS }, // gentle ramp-up
        { duration: SOAK_DURATION, target: SOAK_VUS }, // sustained load
        { duration: "2m",          target: 0 },        // ramp-down
      ],
    },
  },
  thresholds: {
    // Soak: thresholds are strict — no degradation allowed over time
    http_req_failed:      ["rate<0.05"],
    soak_error_rate:      ["rate<0.05"],
    soak_item_profile_ms: ["p(95)<3000", "p(99)<6000"],
    soak_items_list_ms:   ["p(95)<2000"],
    soak_workspace_ms:    ["p(95)<1500"],
  },
};

const BASE_URL = __ENV.BASE_URL || "https://test-api.itemit.com";

export function setup() {
  const email    = __ENV.EMAIL;
  const password = __ENV.PASSWORD;

  if (!email || !password) {
    throw new Error(
      "EMAIL and PASSWORD env vars required.\n" +
      "Run: k6 run -e EMAIL=you@example.com -e PASSWORD=pass -e DURATION=1h tests/itemit/performance/itemit-soak.js\n" +
      "Quick smoke run: k6 run -e EMAIL=... -e PASSWORD=... -e DURATION=5m -e VUS=3 ..."
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

  console.log(`\n✔️  Soak test ready`);
  console.log(`   Duration  : ${SOAK_DURATION}`);
  console.log(`   VUs       : ${SOAK_VUS}`);
  console.log(`   Item pool : ${itemIds.length} profiles\n`);
  console.log("   Goal: detect memory leaks, connection exhaustion, gradual response time drift\n");

  return { userId, userToken, workspaceId, itemIds };
}

export default function (data) {
  const headers = buildAuthHeaders(data.userId, data.userToken, data.workspaceId);

  // Realistic traffic mix — weighted by typical usage patterns
  const roll = Math.random();

  if (roll < 0.55) {
    // 55% — Item profile view (main page, known bottleneck)
    const itemId = data.itemIds[Math.floor(Math.random() * data.itemIds.length)];
    const res = http.get(`${BASE_URL}/v1/item-profiles/${itemId}`, { headers });

    profileTime.add(res.timings.duration);
    errorRate.add(res.status !== 200);

    check(res, {
      "Item profile — status 200":      () => res.status === 200,
      "Item profile — time < 3000ms":   () => res.timings.duration < 3000,
    });

    sleep(Math.random() * 2 + 1);

  } else if (roll < 0.80) {
    // 25% — Items list (browsing inventory)
    const res = http.get(`${BASE_URL}/v1/items?limit=25&skip=0`, { headers });

    itemListTime.add(res.timings.duration);
    errorRate.add(res.status !== 200);

    check(res, {
      "Items list — status 200":     () => res.status === 200,
      "Items list — time < 2000ms":  () => res.timings.duration < 2000,
    });

    sleep(Math.random() * 1.5 + 0.5);

  } else if (roll < 0.90) {
    // 10% — Workspace info (settings check)
    const res = http.get(`${BASE_URL}/v1/workspaces`, { headers });

    workspaceTime.add(res.timings.duration);
    errorRate.add(res.status !== 200);

    check(res, {
      "Workspaces — status 200":    () => res.status === 200,
      "Workspaces — time < 1500ms": () => res.timings.duration < 1500,
    });

    sleep(Math.random() * 1 + 0.5);

  } else {
    // 10% — Item search with a short query (search box usage)
    const res = http.get(`${BASE_URL}/v1/item-profiles?search=a&limit=10`, { headers });

    itemListTime.add(res.timings.duration);
    errorRate.add(res.status !== 200);

    check(res, {
      "Item search — status 200":    () => res.status === 200,
      "Item search — time < 2000ms": () => res.timings.duration < 2000,
    });

    sleep(Math.random() * 2 + 1);
  }
}

export function handleSummary(data) {
  return {
    "reports/itemit-soak-report.html": htmlReport(data),
    stdout: textSummary(data, { indent: " ", enableColors: true }),
  };
}
