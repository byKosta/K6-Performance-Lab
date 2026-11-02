// OWASP A3 — Improper Input Validation: injections, oversized payloads, type mismatches
import http from "k6/http";
import { check, group, sleep } from "k6";
import { uuidv4 } from "https://jslib.k6.io/k6-utils/1.4.0/index.js";
import { htmlReport } from "https://raw.githubusercontent.com/benc-uk/k6-reporter/main/dist/bundle.js";
import { textSummary } from "https://jslib.k6.io/k6-summary/0.1.0/index.js";
import { login, getDefaultWorkspace, buildAuthHeaders } from "../../../src/auth/login.js";

export const options = {
  vus: 1,
  iterations: 1,
  thresholds: {
    checks: ["rate==1.0"],
  },
};

const BASE_URL = __ENV.BASE_URL || "https://test-api.itemit.com";

// Core rule: server must never return 500 regardless of input
const noServerError = (res) => res.status !== 500;
// Input is either safely stored or properly rejected — never crashes the server
const acceptedOrRejected = (res) => [200, 201, 400, 413, 422].includes(res.status);

function secLog(label, status, passed) {
  const icon = passed ? "✔️ " : "❌  VULNERABILITY —";
  console.log(`  ${icon} ${label} → HTTP ${status}`);
}

// Standard security test payloads
const PAYLOADS = {
  xss:          `<script>alert('k6-xss')</script>`,
  xssAttr:      `"><img src=x onerror=alert('k6')>`,
  sqli:         `'; DROP TABLE items; --`,
  sqliOr:       `' OR '1'='1`,
  nullByte:     `valid\u0000null`,
  longString:   "A".repeat(10_000),
  hugeString:   "B".repeat(100_000),
  unicodeRtl:   `\u202Ereversed text`,
  template:     `{{7*7}}`,                  // template injection probe
  jsonBreaker:  `{"name": "test"}`,         // JSON inside a string field
  crlf:         `injected\r\nX-Header: evil`,
};

export function setup() {
  const email    = __ENV.EMAIL;
  const password = __ENV.PASSWORD;

  if (!email || !password) {
    throw new Error(
      "EMAIL and PASSWORD env vars required.\n" +
      "Run: k6 run -e EMAIL=you@test.com -e PASSWORD=pass tests/itemit/security/itemit-input-validation.js"
    );
  }

  const { userId, userToken } = login(email, password);
  const workspaceId = __ENV.WORKSPACE_ID || getDefaultWorkspace(userId, userToken);

  // Create a base item to use for PATCH/information tests
  const itemId = uuidv4();
  const headers = buildAuthHeaders(userId, userToken, workspaceId);
  const res = http.post(
    `${BASE_URL}/v1/items`,
    JSON.stringify([{ id: itemId, name: "k6-input-validation-base", description: "Input validation test item" }]),
    { headers }
  );

  if (res.status !== 200) {
    throw new Error(`Failed to create base item [${res.status}]: ${res.body}`);
  }

  console.log(`\n✔️  Base item created: ${itemId}\n`);
  return { userId, userToken, workspaceId, itemId };
}

export default function (data) {
  const headers = buildAuthHeaders(data.userId, data.userToken, data.workspaceId);
  const itemId  = data.itemId;

  // ── 1. XSS payloads in item name ─────────────────────────────────────────
  group("1. XSS payload in item name (PATCH)", () => {
    const res = http.patch(
      `${BASE_URL}/v1/items/${itemId}`,
      JSON.stringify({ name: PAYLOADS.xss }),
      { headers }
    );
    const ok = noServerError(res) && acceptedOrRejected(res);
    check(res, {
      "XSS in name — no 500 server error":          () => noServerError(res),
      "XSS in name — 200 (stored) or 400 (rejected)": () => acceptedOrRejected(res),
    });
    secLog("XSS payload in item name", res.status, ok);
    sleep(0.3);
  });

  // ── 2. SQL injection in item description ─────────────────────────────────
  group("2. SQL injection in item description", () => {
    const res = http.patch(
      `${BASE_URL}/v1/items/${itemId}`,
      JSON.stringify({ name: "k6-sqli-test", description: PAYLOADS.sqli }),
      { headers }
    );
    const ok = noServerError(res);
    check(res, {
      "SQLi in description — no 500 server error": () => ok,
      "SQLi in description — accepted or rejected": () => acceptedOrRejected(res),
    });
    secLog("SQL injection in item description", res.status, ok);
    sleep(0.3);
  });

  // ── 3. Oversized name (10 KB) ─────────────────────────────────────────────
  group("3. Oversized name field (10 KB)", () => {
    const res = http.patch(
      `${BASE_URL}/v1/items/${itemId}`,
      JSON.stringify({ name: PAYLOADS.longString }),
      { headers }
    );
    const ok = noServerError(res);
    check(res, {
      "10 KB name — no 500 server error":            () => ok,
      "10 KB name — rejected with 400/413 or stored": () => acceptedOrRejected(res),
    });
    secLog("Oversized item name (10 KB)", res.status, ok);
    sleep(0.3);
  });

  // ── 4. Huge payload body (100 KB string) ─────────────────────────────────
  group("4. Huge payload body (100 KB)", () => {
    const res = http.post(
      `${BASE_URL}/v1/items`,
      JSON.stringify([{ id: uuidv4(), name: "k6-huge", description: PAYLOADS.hugeString }]),
      { headers }
    );
    const ok = noServerError(res);
    check(res, {
      "100 KB payload — no 500 server error": () => ok,
      "100 KB payload — rejected (400/413) or accepted": () => acceptedOrRejected(res),
    });
    secLog("Huge payload body (100 KB description)", res.status, ok);

    // Cleanup if created
    if (res.status === 200) {
      const json = res.json();
      const id = Array.isArray(json) ? json[0]?.id : null;
      if (id) http.del(`${BASE_URL}/v1/items/${id}`, null, { headers });
    }
    sleep(0.3);
  });

  // ── 5. Malformed JSON body ────────────────────────────────────────────────
  group("5. Malformed JSON body", () => {
    const res = http.patch(
      `${BASE_URL}/v1/items/${itemId}`,
      `{ "name": "broken", invalid json here `,
      { headers }
    );
    const ok = res.status === 400;
    check(res, {
      "Malformed JSON → 400 Bad Request": () => ok,
      "Malformed JSON — no 500 server error": () => noServerError(res),
    });
    secLog("Malformed JSON body", res.status, noServerError(res));
    sleep(0.3);
  });

  // ── 6. Empty body ─────────────────────────────────────────────────────────
  group("6. Empty request body", () => {
    const res = http.patch(
      `${BASE_URL}/v1/items/${itemId}`,
      "",
      { headers }
    );
    const ok = noServerError(res);
    check(res, {
      "Empty body — no 500 server error":      () => ok,
      "Empty body — 400 or graceful handling": () => res.status === 400 || res.status === 200,
    });
    secLog("Empty request body (PATCH)", res.status, ok);
    sleep(0.3);
  });

  // ── 7. Wrong type: number in name field ──────────────────────────────────
  group("7. Wrong type: integer in name field", () => {
    // Send raw JSON with a number where a string is expected
    const res = http.patch(
      `${BASE_URL}/v1/items/${itemId}`,
      `{ "name": 12345 }`,
      { headers }
    );
    const ok = noServerError(res);
    check(res, {
      "Integer in string field — no 500": () => ok,
      "Integer in string field — 400 or coerced": () => res.status === 400 || res.status === 200,
    });
    secLog("Integer value in string field (name)", res.status, ok);
    sleep(0.3);
  });

  // ── 8. Null bytes in field value ─────────────────────────────────────────
  group("8. Null byte in item name", () => {
    const res = http.patch(
      `${BASE_URL}/v1/items/${itemId}`,
      JSON.stringify({ name: PAYLOADS.nullByte }),
      { headers }
    );
    const ok = noServerError(res);
    check(res, {
      "Null byte in name — no 500": () => ok,
    });
    secLog("Null byte in item name field", res.status, ok);
    sleep(0.3);
  });

  // ── 9. CRLF injection in item name ───────────────────────────────────────
  group("9. CRLF injection in name field", () => {
    const res = http.patch(
      `${BASE_URL}/v1/items/${itemId}`,
      JSON.stringify({ name: PAYLOADS.crlf }),
      { headers }
    );
    const ok = noServerError(res);
    check(res, {
      "CRLF in name — no 500":                 () => ok,
      "Response Content-Type is application/json": () =>
        (res.headers["Content-Type"] || "").includes("application/json"),
    });
    secLog("CRLF injection in item name", res.status, ok);
    sleep(0.3);
  });

  // ── 10. Template injection probe ─────────────────────────────────────────
  group("10. Template injection probe {{7*7}}", () => {
    const res = http.patch(
      `${BASE_URL}/v1/items/${itemId}`,
      JSON.stringify({ name: PAYLOADS.template }),
      { headers }
    );
    const ok = noServerError(res);
    const json = res.json();
    // If template was executed, the name would be "49" not "{{7*7}}"
    const notExecuted = !json?.name || json.name !== "49";
    check(res, {
      "Template probe — no 500":                  () => ok,
      "Template probe — not evaluated (no RCE)":  () => notExecuted,
    });
    secLog("Template injection {{7*7}} in name", res.status, ok && notExecuted);
    sleep(0.3);
  });

  // ── 11. XSS in search query parameter ────────────────────────────────────
  group("11. XSS in search query parameter", () => {
    const res = http.get(
      `${BASE_URL}/v1/item-profiles?search=${encodeURIComponent(PAYLOADS.xss)}&limit=1`,
      { headers }
    );
    const ok = noServerError(res);
    check(res, {
      "XSS in search param — no 500":                      () => ok,
      "XSS in search param — response is JSON (not HTML)": () =>
        (res.headers["Content-Type"] || "").includes("application/json"),
    });
    secLog("XSS payload in search query param", res.status, ok);
    sleep(0.3);
  });

  // ── 12. Negative value in numeric information field ───────────────────────
  group("12. Negative / extreme number in information field", () => {
    const infoId = uuidv4();
    const res = http.put(
      `${BASE_URL}/v1/items/${itemId}/information/${infoId}`,
      JSON.stringify({ name: "k6-qty-test", quantity: -99999999, type: "QUANTITY" }),
      { headers }
    );
    const ok = noServerError(res);
    check(res, {
      "Negative quantity — no 500":           () => ok,
      "Negative quantity — 400 or accepted":  () => acceptedOrRejected(res),
    });
    secLog("Negative value in QUANTITY information field", res.status, ok);

    if (res.status === 200) {
      http.del(`${BASE_URL}/v1/information/${infoId}`, null, { headers });
    }
  });
}

export function teardown(data) {
  const headers = buildAuthHeaders(data.userId, data.userToken, data.workspaceId);
  const res = http.del(`${BASE_URL}/v1/items/${data.itemId}`, null, { headers });

  if (res.status === 204) {
    console.log(`\n✔️  Cleanup: base item ${data.itemId} deleted`);
  } else {
    console.warn(`\n⚠️  Cleanup failed [${res.status}] — item ${data.itemId} may remain`);
  }
}

export function handleSummary(data) {
  return {
    "reports/itemit-input-validation-report.html": htmlReport(data),
    stdout: textSummary(data, { indent: " ", enableColors: true }),
  };
}
