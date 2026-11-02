// OWASP API2 — Broken Authentication: brute force, token bypass, account enumeration
import http from "k6/http";
import { check, group, sleep } from "k6";
import encoding from "k6/encoding";
import { uuidv4 } from "https://jslib.k6.io/k6-utils/1.4.0/index.js";
import { htmlReport } from "https://raw.githubusercontent.com/benc-uk/k6-reporter/main/dist/bundle.js";
import { textSummary } from "https://jslib.k6.io/k6-summary/0.1.0/index.js";
import { login, getDefaultWorkspace, buildAuthHeaders, API_KEY } from "../../../src/auth/login.js";

export const options = {
  vus: 1,
  iterations: 1,
  thresholds: {
    checks: ["rate==1.0"],
  },
};

const BASE_URL = __ENV.BASE_URL || "https://test-api.itemit.com";

// Raw login without error handling — used to test failure scenarios
function loginRaw(email, password) {
  const credentials = encoding.b64encode(`${email}:${password}`);
  return http.post(`${BASE_URL}/v1/login`, null, {
    headers: {
      Authorization: `Basic ${credentials}`,
      "x-api-key": API_KEY,
      accept: "application/json",
    },
  });
}

function secLog(label, status, passed) {
  const icon = passed ? "✔️ " : "❌  VULNERABILITY —";
  console.log(`  ${icon} ${label} → HTTP ${status}`);
}

export function setup() {
  const email    = __ENV.EMAIL;
  const password = __ENV.PASSWORD;

  if (!email || !password) {
    throw new Error(
      "EMAIL and PASSWORD env vars required.\n" +
      "Run: k6 run -e EMAIL=you@test.com -e PASSWORD=pass tests/itemit/security/itemit-auth-bypass.js"
    );
  }

  const { userId, userToken } = login(email, password);
  const workspaceId = __ENV.WORKSPACE_ID || getDefaultWorkspace(userId, userToken);

  console.log(`\n✔️  Baseline auth OK for: ${email}`);
  console.log(`   Workspace: ${workspaceId}\n`);

  return { email, password, userId, userToken, workspaceId };
}

export default function (data) {
  const { email, password, userId, userToken, workspaceId } = data;
  const headers = buildAuthHeaders(userId, userToken, workspaceId);

  // ── 1. No API key ─────────────────────────────────────────────────────────
  group("1. No API key", () => {
    const res = http.get(`${BASE_URL}/v1/account`, {
      headers: { accept: "application/json" },
    });
    const ok = res.status === 401 || res.status === 403;
    check(res, { "No x-api-key → 401/403": () => ok });
    secLog("Request without x-api-key", res.status, ok);
  });

  sleep(0.4);

  // ── 2. Invalid / random API key ───────────────────────────────────────────
  group("2. Invalid API key", () => {
    const res = http.get(`${BASE_URL}/v1/account`, {
      headers: { accept: "application/json", "x-api-key": `invalid-${uuidv4()}` },
    });
    const ok = res.status === 401 || res.status === 403;
    check(res, { "Invalid x-api-key → 401/403": () => ok });
    secLog("Random invalid API key", res.status, ok);
  });

  sleep(0.4);

  // ── 3. API key present, no user token ─────────────────────────────────────
  group("3. Missing x-user-token (API key only)", () => {
    const res = http.get(`${BASE_URL}/v1/account`, {
      headers: { accept: "application/json", "x-api-key": API_KEY },
    });
    const ok = res.status === 401 || res.status === 403;
    check(res, { "Missing x-user-token → 401/403": () => ok });
    secLog("API key only, no x-user-token", res.status, ok);
  });

  sleep(0.4);

  // ── 4. Completely fabricated user credentials ─────────────────────────────
  group("4. Fabricated userId + userToken", () => {
    const fakeHeaders = buildAuthHeaders(uuidv4(), uuidv4(), workspaceId);
    const res = http.get(`${BASE_URL}/v1/account`, { headers: fakeHeaders });
    const ok = res.status === 401 || res.status === 403;
    check(res, { "Random userId/userToken → 401/403": () => ok });
    secLog("Fabricated userId + userToken", res.status, ok);
  });

  sleep(0.4);

  // ── 5. Valid token, mismatched user ID (token hijack simulation) ──────────
  group("5. Valid token with wrong userId", () => {
    const mismatchHeaders = buildAuthHeaders(uuidv4(), userToken, workspaceId);
    const res = http.get(`${BASE_URL}/v1/account`, { headers: mismatchHeaders });
    const ok = res.status === 401 || res.status === 403;
    check(res, { "Token/userId mismatch → 401/403": () => ok });
    secLog("Valid token + random userId (token hijack)", res.status, ok);
  });

  sleep(0.4);

  // ── 6. Account enumeration — must run BEFORE brute force to avoid 429 pollution
  group("6. Account enumeration via login response", () => {
    const fakeEmail  = `nonexistent-${uuidv4()}@k6.invalid`;
    const resReal    = loginRaw(email, "definitively-wrong-pass-k6!");
    const resFake    = loginRaw(fakeEmail, "definitively-wrong-pass-k6!");
    const sameStatus = resReal.status === resFake.status;

    check({ sameStatus }, {
      "Same HTTP status for wrong-pass vs non-existent account (no email enumeration)": () => sameStatus,
    });

    if (!sameStatus) {
      console.warn(`  ⚠️  Email enumeration possible: real account=${resReal.status}, non-existent=${resFake.status}`);
    } else {
      console.log(`  ✔️  Both return HTTP ${resReal.status} — no email enumeration`);
    }
  });

  sleep(0.5);

  // ── 7. Brute force: repeated wrong-password login attempts ────────────────
  group("7. Brute force — 10 wrong-password attempts", () => {
    let gotRateLimited = false;
    let lastStatus     = 0;

    for (let i = 0; i < 10; i++) {
      const res = loginRaw(email, `WrongPass${i}!X9`);
      lastStatus = res.status;

      if (res.status === 429) {
        gotRateLimited = true;
        console.log(`  ✔️  Rate limited after ${i + 1} attempts (429 Too Many Requests)`);
        break;
      }

      sleep(0.2);
    }

    check({ gotRateLimited, lastStatus }, {
      "Brute force: 429 rate limiting OR consistent rejection (401/400)": () =>
        gotRateLimited || lastStatus === 401 || lastStatus === 400,
    });

    if (!gotRateLimited) {
      console.warn("  ⚠️  No 429 rate limiting after 10 failed attempts — consider adding brute force protection");
    }
  });

  sleep(1);

  // ── 8. Password reset with invalid token ─────────────────────────────────
  group("8. Password reset with fabricated token", () => {
    const res = http.post(
      `${BASE_URL}/v1/reset-password`,
      JSON.stringify({ email, token: uuidv4(), newPassword: "NewPass123!" }),
      { headers: { "content-type": "application/json", accept: "application/json", "x-api-key": API_KEY } }
    );
    const ok = res.status === 401 || res.status === 400;
    check(res, { "Password reset with fake token → 400/401": () => ok });
    secLog("Password reset with fabricated reset token", res.status, ok);
  });

  sleep(0.4);

  // ── 9. Confirm no PERMANENT lockout (429 = still in rate-limit window = acceptable) ──
  group("9. No permanent lockout after brute force", () => {
    const res = loginRaw(email, password);
    // 200 = fully recovered, 429 = still rate-limited (temporary, not permanent — both OK)
    const ok  = res.status === 200 || res.status === 429;
    check(res, {
      "No permanent lockout — 200 (recovered) or 429 (rate-limited, temporary)": () => ok,
    });
    if (res.status === 200) {
      console.log("  ✔️  Account fully recovered after brute force test");
    } else if (res.status === 429) {
      console.log("  ✔️  Account temporarily rate-limited (expected) — not permanently locked out");
    } else {
      console.error(`  ❌  Unexpected status post-test: ${res.status}`);
    }
  });
}

export function handleSummary(data) {
  return {
    "reports/itemit-auth-bypass-report.html": htmlReport(data),
    stdout: textSummary(data, { indent: " ", enableColors: true }),
  };
}
