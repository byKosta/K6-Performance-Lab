// OWASP API4 — Rate Limiting: verifies the 100 req/min API key limit is enforced
import http from "k6/http";
import { check, group, sleep } from "k6";
import { Counter, Rate } from "k6/metrics";
import { htmlReport } from "https://raw.githubusercontent.com/benc-uk/k6-reporter/main/dist/bundle.js";
import { textSummary } from "https://jslib.k6.io/k6-summary/0.1.0/index.js";
import { login, getDefaultWorkspace, buildAuthHeaders } from "../../../src/auth/login.js";

const rateLimitedCount = new Counter("rate_limited_429_count");
const successCount     = new Counter("rate_limit_success_count");
const rateLimitRate    = new Rate("rate_limit_triggered_rate");

export const options = {
  scenarios: {
    // Burst: send requests at 3× the documented limit (100 req/min) to trigger 429
    burst: {
      executor: "constant-arrival-rate",
      rate:           5,   // 5 req/sec = 300 req/min — 3× over the 100/min limit
      timeUnit:       "1s",
      duration:       "40s",
      preAllocatedVUs: 10,
      maxVUs:          20,
    },
  },
  thresholds: {
    // Rate limiting must fire: we expect 429s, so http_req_failed will be high — that's OK
    rate_limited_429_count: ["count>0"],      // 429 must appear at some point
    http_req_failed:        ["rate<1"],       // not every request should fail (429 ≠ infra failure)
  },
};

const BASE_URL = __ENV.BASE_URL || "https://test-api.itemit.com";

export function setup() {
  const email    = __ENV.EMAIL;
  const password = __ENV.PASSWORD;

  if (!email || !password) {
    throw new Error(
      "EMAIL and PASSWORD env vars required.\n" +
      "Run: k6 run -e EMAIL=you@example.com -e PASSWORD=pass tests/itemit/security/itemit-rate-limit.js"
    );
  }

  const { userId, userToken } = login(email, password);
  const workspaceId = __ENV.WORKSPACE_ID || getDefaultWorkspace(userId, userToken);

  // Prefetch an item ID so the burst hits a real endpoint (not a no-op)
  const headers = buildAuthHeaders(userId, userToken, workspaceId);
  const res = http.get(`${BASE_URL}/v1/item-profiles?limit=1`, { headers });
  const firstItemId = res.json()?.results?.[0]?.id || null;

  console.log(`\n✔️  Rate limit test ready`);
  console.log(`   Target rate : 5 req/sec (300/min — 3× the 100/min limit)`);
  console.log(`   Duration    : 40 seconds (~200 total requests)\n`);

  return { userId, userToken, workspaceId, firstItemId };
}

export default function (data) {
  const headers = buildAuthHeaders(data.userId, data.userToken, data.workspaceId);

  // Hit the item-profiles endpoint — real read operation, not a ping
  const endpoint = data.firstItemId
    ? `${BASE_URL}/v1/item-profiles/${data.firstItemId}`
    : `${BASE_URL}/v1/item-profiles?limit=1`;

  const res = http.get(endpoint, { headers });

  if (res.status === 429) {
    rateLimitedCount.add(1);
    rateLimitRate.add(1);

    // Check that 429 includes retry guidance
    const hasRetryAfter = !!(
      res.headers["Retry-After"] ||
      res.headers["X-RateLimit-Reset"] ||
      res.headers["X-Rate-Limit-Reset"]
    );

    check(res, {
      "429 received (rate limiting active)":         () => true,
      "429 includes Retry-After or RateLimit header": () => hasRetryAfter,
    });

    if (!hasRetryAfter) {
      console.warn("  ⚠️  429 returned but no Retry-After / X-RateLimit-Reset header");
    }

  } else {
    successCount.add(1);
    rateLimitRate.add(0);

    check(res, {
      "Request succeeded (200) before rate limit": () => res.status === 200,
    });
  }
}

// After burst, verify system recovers — requests succeed again after cooldown
export function teardown(data) {
  console.log("\n⏳ Waiting 65s for rate limit window to reset...");
  sleep(65);

  const headers = buildAuthHeaders(data.userId, data.userToken, data.workspaceId);
  const res = http.get(`${BASE_URL}/v1/item-profiles?limit=1`, { headers });

  if (res.status === 200) {
    console.log("✔️  System recovered — requests succeed after rate limit window reset");
  } else if (res.status === 429) {
    console.error(`❌ Still rate limited after 65s cooldown — window may be longer than 1 minute`);
  } else {
    console.warn(`⚠️  Unexpected status after cooldown: ${res.status}`);
  }
}

export function handleSummary(data) {
  const total429   = data.metrics.rate_limited_429_count?.values?.count || 0;
  const totalSucc  = data.metrics.rate_limit_success_count?.values?.count || 0;
  const totalReqs  = total429 + totalSucc;

  console.log(`\n========== Rate Limit Summary ==========`);
  console.log(`  Total requests  : ${totalReqs}`);
  console.log(`  Succeeded (200) : ${totalSucc}`);
  console.log(`  Rate limited (429): ${total429}`);
  console.log(`  First 429 after : ~${totalSucc} requests`);
  console.log(`=========================================\n`);

  return {
    "reports/itemit-rate-limit-report.html": htmlReport(data),
    stdout: textSummary(data, { indent: " ", enableColors: true }),
  };
}
