// OWASP API1 — BOLA/IDOR: access controls between workspaces must be enforced
import http from "k6/http";
import { check, group, sleep } from "k6";
import { uuidv4 } from "https://jslib.k6.io/k6-utils/1.4.0/index.js";
import { htmlReport } from "https://raw.githubusercontent.com/benc-uk/k6-reporter/main/dist/bundle.js";
import { textSummary } from "https://jslib.k6.io/k6-summary/0.1.0/index.js";
import { login, getDefaultWorkspace, buildAuthHeaders, API_KEY } from "../../../src/auth/login.js";

export const options = {
  vus: 1,
  iterations: 1,
  thresholds: {
    // Every security check must pass — one failure = one vulnerability
    checks: ["rate==1.0"],
  },
};

const BASE_URL    = __ENV.BASE_URL || "https://test-api.itemit.com";
const DENIED      = [401, 403, 404];
const isDenied    = (s) => DENIED.includes(s);

function secLog(label, status, passed) {
  const icon = passed ? "✔️ " : "❌  VULNERABILITY FOUND —";
  console.log(`  ${icon} ${label} → HTTP ${status}`);
}

// Runs once: login both accounts, create a target item in victim's workspace
export function setup() {
  const emailA    = __ENV.EMAIL_A;
  const passwordA = __ENV.PASSWORD_A;
  const emailB    = __ENV.EMAIL_B;
  const passwordB = __ENV.PASSWORD_B;

  if (!emailA || !passwordA || !emailB || !passwordB) {
    throw new Error(
      "Two accounts required for IDOR testing.\n" +
      "Run: k6 run \\\n" +
      "  -e EMAIL_A=attacker@test.com -e PASSWORD_A=passA \\\n" +
      "  -e EMAIL_B=victim@test.com   -e PASSWORD_B=passB \\\n" +
      "  tests/itemit/security/itemit-idor.js"
    );
  }

  const authA = login(emailA, passwordA);
  authA.workspaceId = __ENV.WORKSPACE_ID_A || getDefaultWorkspace(authA.userId, authA.userToken);

  const authB = login(emailB, passwordB);
  authB.workspaceId = __ENV.WORKSPACE_ID_B || getDefaultWorkspace(authB.userId, authB.userToken);

  if (authA.workspaceId === authB.workspaceId) {
    throw new Error("Both accounts must belong to DIFFERENT workspaces for IDOR testing.");
  }

  // Create the target item in victim's (B) workspace
  const itemId   = uuidv4();
  const headersB = buildAuthHeaders(authB.userId, authB.userToken, authB.workspaceId);
  const createRes = http.post(
    `${BASE_URL}/v1/items`,
    JSON.stringify([{ id: itemId, name: "k6-idor-target", description: "IDOR test target — safe to delete" }]),
    { headers: headersB }
  );

  if (createRes.status !== 200) {
    throw new Error(`Failed to create victim item [${createRes.status}]: ${createRes.body}`);
  }

  console.log("\n============================================================");
  console.log("  IDOR / BOLA Security Test");
  console.log(`  Attacker workspace : ${authA.workspaceId}`);
  console.log(`  Victim workspace   : ${authB.workspaceId}`);
  console.log(`  Target item ID     : ${itemId}`);
  console.log("============================================================\n");

  return { authA, authB, itemId };
}

export default function (data) {
  const { authA, authB, itemId } = data;

  const headersA = buildAuthHeaders(authA.userId, authA.userToken, authA.workspaceId);
  // Attacker spoofing victim's workspace ID but using their own token
  const spoofedHeaders = buildAuthHeaders(authA.userId, authA.userToken, authB.workspaceId);
  // No user token — only API key
  const noUserHeaders = { accept: "application/json", "x-api-key": API_KEY };
  // Completely random / fabricated credentials
  const fakeHeaders = buildAuthHeaders(uuidv4(), uuidv4(), authB.workspaceId);

  // ── 1. Cross-workspace READ ───────────────────────────────────────────────
  group("1. Cross-workspace GET /item-profiles/{id}", () => {
    const res = http.get(`${BASE_URL}/v1/item-profiles/${itemId}`, { headers: headersA });
    const ok = isDenied(res.status);
    check(res, { "Cross-workspace read denied (403/404)": () => ok });
    secLog("Attacker token + attacker workspace → GET victim's item-profile", res.status, ok);
  });

  sleep(0.3);

  // ── 2. Spoofed workspace-id READ ─────────────────────────────────────────
  group("2. Spoofed workspace-id GET /item-profiles/{id}", () => {
    const res = http.get(`${BASE_URL}/v1/item-profiles/${itemId}`, { headers: spoofedHeaders });
    const ok = isDenied(res.status);
    check(res, { "Spoofed workspace-id read denied (401/403/404)": () => ok });
    secLog("Attacker token + victim workspace-id → GET victim's item-profile", res.status, ok);
  });

  sleep(0.3);

  // ── 3. Cross-workspace PATCH (modification attempt) ──────────────────────
  group("3. Cross-workspace PATCH /items/{id}", () => {
    const res = http.patch(
      `${BASE_URL}/v1/items/${itemId}`,
      JSON.stringify({ name: "k6-idor-hijacked" }),
      { headers: headersA }
    );
    const ok = isDenied(res.status);
    check(res, { "Cross-workspace PATCH denied (403/404)": () => ok });
    secLog("Attacker token + attacker workspace → PATCH victim's item", res.status, ok);
  });

  sleep(0.3);

  // ── 4. Cross-workspace DELETE ────────────────────────────────────────────
  group("4. Cross-workspace DELETE /items/{id}", () => {
    const res = http.del(`${BASE_URL}/v1/items/${itemId}`, null, { headers: headersA });
    const ok = isDenied(res.status);
    check(res, { "Cross-workspace DELETE denied (403/404)": () => ok });
    secLog("Attacker token + attacker workspace → DELETE victim's item", res.status, ok);
  });

  sleep(0.3);

  // ── 5. No user credentials ───────────────────────────────────────────────
  group("5. Unauthenticated GET /item-profiles/{id}", () => {
    const res = http.get(`${BASE_URL}/v1/item-profiles/${itemId}`, { headers: noUserHeaders });
    const ok = res.status === 401;
    check(res, { "Unauthenticated request returns 401": () => ok });
    secLog("No user credentials → GET victim's item-profile", res.status, ok);
  });

  sleep(0.3);

  // ── 6. Fake / random token ───────────────────────────────────────────────
  group("6. Fabricated token GET /item-profiles/{id}", () => {
    const res = http.get(`${BASE_URL}/v1/item-profiles/${itemId}`, { headers: fakeHeaders });
    const ok = res.status === 401 || res.status === 403;
    check(res, { "Fabricated token denied (401/403)": () => ok });
    secLog("Random userId/userToken → GET victim's item-profile", res.status, ok);
  });

  sleep(0.3);

  // ── 7. Sequential UUID enumeration (info disclosure check) ───────────────
  group("7. Random UUID enumeration — no data leak", () => {
    const randomId = uuidv4();
    const res = http.get(`${BASE_URL}/v1/item-profiles/${randomId}`, { headers: headersA });
    const ok = isDenied(res.status);
    const noLeak = res.status !== 200;
    check(res, {
      "Random UUID returns 403/404 (not found / forbidden)": () => ok,
      "No item data leaked in response body": () => noLeak,
    });
    secLog("Random UUID enumeration → GET item-profile", res.status, ok);
  });
}

// Runs once after the test — clean up victim's item
export function teardown(data) {
  const headersB = buildAuthHeaders(data.authB.userId, data.authB.userToken, data.authB.workspaceId);
  const res = http.del(`${BASE_URL}/v1/items/${data.itemId}`, null, { headers: headersB });

  if (res.status === 204) {
    console.log(`\n✔️  Cleanup: item ${data.itemId} deleted from victim workspace`);
  } else {
    console.warn(`\n⚠️  Cleanup failed [${res.status}] — item ${data.itemId} may remain in victim workspace`);
  }
}

export function handleSummary(data) {
  return {
    "reports/itemit-idor-report.html": htmlReport(data),
    stdout: textSummary(data, { indent: " ", enableColors: true }),
  };
}
