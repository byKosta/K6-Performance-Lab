// OWASP API8 — Security Misconfiguration: response headers, CORS, info disclosure
import http from "k6/http";
import { check, group } from "k6";
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

function secLog(label, passed, detail = "") {
  const icon = passed ? "✔️ " : "❌  MISCONFIGURATION —";
  console.log(`  ${icon} ${label}${detail ? ` (${detail})` : ""}`);
}

function header(res, name) {
  // Headers in k6 are case-insensitive via object keys
  return res.headers[name] || res.headers[name.toLowerCase()] || "";
}

export function setup() {
  const email    = __ENV.EMAIL;
  const password = __ENV.PASSWORD;

  if (!email || !password) {
    throw new Error(
      "EMAIL and PASSWORD env vars required.\n" +
      "Run: k6 run -e EMAIL=you@example.com -e PASSWORD=pass tests/itemit/security/itemit-headers.js"
    );
  }

  const { userId, userToken } = login(email, password);
  const workspaceId = __ENV.WORKSPACE_ID || getDefaultWorkspace(userId, userToken);

  return { userId, userToken, workspaceId };
}

export default function (data) {
  const headers = buildAuthHeaders(data.userId, data.userToken, data.workspaceId);

  // ── 1. Content-Type on all responses ─────────────────────────────────────
  group("1. Content-Type header on JSON responses", () => {
    const endpoints = [
      `${BASE_URL}/v1/workspaces`,
      `${BASE_URL}/v1/item-profiles?limit=1`,
      `${BASE_URL}/v1/account`,
    ];

    endpoints.forEach((url) => {
      const res = http.get(url, { headers });
      const ct  = header(res, "Content-Type");
      const ok  = ct.includes("application/json");
      check(res, {
        [`${url.split("/v1/")[1]} — Content-Type: application/json`]: () => ok,
      });
      secLog(`Content-Type on ${url.split("/v1/")[1]}`, ok, ct || "missing");
    });
  });

  // ── 2. No sensitive server information in headers ─────────────────────────
  group("2. Server info not disclosed in headers", () => {
    const res = http.get(`${BASE_URL}/v1/account`, { headers });

    const serverHeader    = header(res, "Server");
    const poweredByHeader = header(res, "X-Powered-By");

    const noServer    = !serverHeader || serverHeader === "";
    const noPoweredBy = !poweredByHeader || poweredByHeader === "";

    check(res, {
      "No Server header (technology disclosure)":    () => noServer,
      "No X-Powered-By header (technology disclosure)": () => noPoweredBy,
    });
    secLog("Server header absent", noServer, serverHeader || "not present");
    secLog("X-Powered-By absent", noPoweredBy, poweredByHeader || "not present");
  });

  // ── 3. No stack traces in error responses ─────────────────────────────────
  group("3. No stack trace in error responses", () => {
    // Trigger a 404 by requesting a non-existent resource
    const res404 = http.get(`${BASE_URL}/v1/item-profiles/00000000-0000-0000-0000-000000000000`, { headers });
    const body404 = res404.body || "";

    const noStackTrace = !body404.includes("at ") &&
                         !body404.includes("Exception") &&
                         !body404.includes("stack") &&
                         !body404.includes("Traceback");

    check(res404, {
      "404 error — no stack trace in body": () => noStackTrace,
      "404 error — response is JSON":       () => (header(res404, "Content-Type") || "").includes("application/json"),
    });
    secLog("No stack trace in 404 response", noStackTrace);

    // Trigger a 400 with bad payload
    const res400 = http.patch(
      `${BASE_URL}/v1/items/00000000-0000-0000-0000-000000000000`,
      `{invalid}`,
      { headers }
    );
    const body400 = res400.body || "";
    const no400Trace = !body400.includes("at ") && !body400.includes("Exception");

    check(res400, {
      "400 error — no stack trace in body": () => no400Trace,
    });
    secLog("No stack trace in 400 response", no400Trace);
  });

  // ── 4. CORS headers on authenticated endpoints ────────────────────────────
  group("4. CORS — Access-Control-Allow-Origin not wildcard", () => {
    // OPTIONS preflight
    const res = http.options(`${BASE_URL}/v1/item-profiles`, {
      headers: {
        Origin: "https://evil-attacker.com",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "x-api-key,x-user-token",
      },
    });

    const acao      = header(res, "Access-Control-Allow-Origin");
    const notWild   = acao !== "*";
    const notEvil   = !acao.includes("evil-attacker.com");

    check(res, {
      "CORS — Access-Control-Allow-Origin not wildcard (*)":         () => notWild,
      "CORS — Untrusted origin not reflected in Allow-Origin":        () => notEvil,
    });
    secLog("CORS Allow-Origin not '*'", notWild, acao || "header absent");
    secLog("CORS doesn't reflect attacker origin", notEvil);
  });

  // ── 5. HTTPS redirect / HSTS ─────────────────────────────────────────────
  group("5. HTTPS — HSTS header present", () => {
    const res  = http.get(`${BASE_URL}/v1/account`, { headers });
    const hsts = header(res, "Strict-Transport-Security");
    const ok   = !!hsts;

    check(res, {
      "Strict-Transport-Security header present": () => ok,
    });
    secLog("HSTS header present", ok, hsts || "missing");
  });

  // ── 6. X-Content-Type-Options ─────────────────────────────────────────────
  group("6. X-Content-Type-Options: nosniff", () => {
    const res  = http.get(`${BASE_URL}/v1/account`, { headers });
    const xcto = header(res, "X-Content-Type-Options");
    const ok   = xcto === "nosniff";

    check(res, {
      "X-Content-Type-Options: nosniff": () => ok,
    });
    secLog("X-Content-Type-Options: nosniff", ok, xcto || "missing");
  });

  // ── 7. Unauthenticated response — no data leakage ────────────────────────
  group("7. Unauthenticated 401 — no data in response body", () => {
    const res  = http.get(`${BASE_URL}/v1/item-profiles?limit=10`, {
      headers: { accept: "application/json", "x-api-key": API_KEY },
    });
    const body = res.body || "";
    const ok   = res.status === 401 && !body.includes('"name"') && !body.includes('"id"');

    check(res, {
      "Unauthenticated request — 401 with no item data": () => ok,
    });
    secLog("401 response contains no item data", ok);
  });
}

export function handleSummary(data) {
  return {
    "reports/itemit-headers-report.html": htmlReport(data),
    stdout: textSummary(data, { indent: " ", enableColors: true }),
  };
}
