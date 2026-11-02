// HTTP wrapper for the stability suite: every request gets name/target tags,
// errors are classified by type (timeout / network / 429 / 5xx / 4xx) and the first
// occurrences are logged with the minute of the test they happened at.
import http from "k6/http";
import encoding from "k6/encoding";
import exec from "k6/execution";
import { check } from "k6";
import { Counter, Trend } from "k6/metrics";
import { parseHTML } from "k6/html";
import { API_KEY, buildAuthHeaders, getDefaultWorkspace } from "../../../../src/auth/login.js";
import { API_URL, FRONT_URL, HTTP_TIMEOUT, ENTITY_PREFIX, LISTS, SEARCHES } from "./config.js";

// One counter, split by tags: errors{type:timeout}, errors{type:5xx}, errors{target:frontend}, ...
export const errors       = new Counter("errors");
export const bodyBytes    = new Trend("resp_body_bytes");
const MAX_LOGS_PER_TYPE   = 5;
const loggedByType        = {};

let runStart = Date.now();
let session  = null;   // per-VU: { userId, userToken }

export function initRun(data) {
  runStart = data.startTime;
}

export function elapsedMin() {
  return Math.floor((Date.now() - runStart) / 60000);
}

// Tags every metric emitted by this VU from now on with the current time window,
// so the summary can show p95 for "minutes 0-30" vs "minutes 150-180".
export function setWindowTag(windowMinutes) {
  const w    = Math.floor(elapsedMin() / windowMinutes);
  const from = String(w * windowMinutes).padStart(3, "0");
  const to   = String((w + 1) * windowMinutes).padStart(3, "0");
  exec.vu.metrics.tags.window = `m${from}-${to}`;
}

export function windowLabels(totalMinutes, windowMinutes) {
  const out = [];
  for (let s = 0; s < totalMinutes; s += windowMinutes) {
    out.push(`m${String(s).padStart(3, "0")}-${String(s + windowMinutes).padStart(3, "0")}`);
  }
  return out;
}

function classify(res, expected) {
  if (expected.includes(res.status)) return null;
  if (res.error_code === 1050)       return "timeout";
  if (res.status === 0)              return "network";
  if (res.status === 429)            return "429";
  if (res.status >= 500)             return "5xx";
  if (res.status === 401)            return "401";
  return "4xx";
}

function record(res, name, target, expected, tags = {}) {
  const type = classify(res, expected);
  if (type) {
    errors.add(1, { type, name, target, ...tags });
    loggedByType[type] = (loggedByType[type] || 0) + 1;
    if (loggedByType[type] <= MAX_LOGS_PER_TYPE) {
      console.warn(`[+${elapsedMin()}m] VU${exec.vu.idInTest} ${type.toUpperCase()} ${name} ` +
        `status=${res.status} ${res.error || ""} ${String(res.body || "").substring(0, 150)}`);
    }
  }
  bodyBytes.add(res.body ? res.body.length : 0, { name, target, ...tags });
  check(res, { [`${name} — ok`]: () => type === null }, { name, target });
  return type;
}

export function request(method, url, body, { name, target, headers = {}, expected = [200], tags = {} }) {
  const res = http.request(method, url, body, {
    headers,
    timeout: HTTP_TIMEOUT,
    tags: { name, target, ...tags },
    responseCallback: http.expectedStatuses(...expected),
  });
  res.errorType = record(res, name, target, expected, tags);
  return res;
}

// ── Auth ─────────────────────────────────────────────────────────────────────
export function loginTagged(email, password, tags = {}) {
  const res = request("POST", `${API_URL}/v1/login`, null, {
    name: "login", target: "api", tags,
    headers: {
      Authorization: `Basic ${encoding.b64encode(`${email}:${password}`)}`,
      "x-api-key": API_KEY,
      accept: "application/json",
    },
  });
  if (res.status !== 200) return null;
  const body = res.json();
  return body?.token?.id && body?.user?.id ? { userId: body.user.id, userToken: body.token.id } : null;
}

// mode "iteration": new login every iteration (mirrors Cypress — tokens are never logged out,
//                   which also tests the "accumulating sessions/tokens" hypothesis)
// mode "vu":        login once per VU, re-login only after a 401
export function ensureSession(mode) {
  if (mode === "iteration" || !session) {
    session = loginTagged(__ENV.EMAIL, __ENV.PASSWORD);
  }
  return session;
}

export function invalidateSession() {
  session = null;
}

export function apiHeaders(s, workspaceId) {
  return buildAuthHeaders(s.userId, s.userToken, workspaceId);
}

// ── Frontend ─────────────────────────────────────────────────────────────────
let assetUrls = null; // per-VU cache of JS/CSS bundle URLs parsed from index.html

function absolute(src) {
  if (/^https?:\/\//.test(src)) return src;
  return `${FRONT_URL}${src.startsWith("/") ? "" : "/"}${src}`;
}

// cy.visit = HTML document + its JS/CSS bundles. Bundles are fetched once per iteration
// (withAssets=true on the first visit) — later visits in a browser would hit the cache.
export function visitPage(page, withAssets) {
  const res = request("GET", `${FRONT_URL}${page.path}`, null, {
    name: page.name, target: "frontend", headers: { accept: "text/html" },
  });

  if (withAssets && res.status === 200 && __ENV.FE_ASSETS !== "false") {
    if (assetUrls === null) {
      const doc = parseHTML(res.body);
      assetUrls = [];
      doc.find("script[src]").each((_, el) => assetUrls.push(absolute(el.getAttribute("src"))));
      doc.find("link[rel=stylesheet]").each((_, el) => assetUrls.push(absolute(el.getAttribute("href"))));
    }
    if (assetUrls.length) {
      const responses = http.batch(assetUrls.map((u) => ["GET", u, null, {
        timeout: HTTP_TIMEOUT, tags: { name: "fe_asset", target: "frontend" },
      }]));
      responses.forEach((r) => record(r, "fe_asset", "frontend", [200]));
    }
  }
  return res;
}

// ── Setup helpers ────────────────────────────────────────────────────────────
// Probes unverified endpoints once; returns the names of endpoints that exist.
export function preflight(s, workspaceId) {
  const headers = apiHeaders(s, workspaceId);
  const enabled = [];
  for (const ep of [...LISTS, ...SEARCHES]) {
    const url = `${API_URL}${ep.path.replace("{q}", "a")}`;
    const res = http.get(url, { headers, timeout: HTTP_TIMEOUT, tags: { name: "preflight" } });
    if (res.status === 200) {
      enabled.push(ep.name);
    } else if (ep.verified) {
      throw new Error(`Preflight failed for verified endpoint ${ep.name} [${res.status}]: ${res.body}`);
    } else {
      console.warn(`⚠️  ${ep.name} (${ep.path}) → ${res.status}. Skipped — fix the path in lib/config.js`);
    }
  }
  return enabled;
}

// Deletes every item whose name starts with ENTITY_PREFIX (leftovers from failed iterations).
export function sweepLeftovers(workspaceId) {
  const s = loginTagged(__ENV.EMAIL, __ENV.PASSWORD, { phase: "teardown" });
  if (!s) {
    console.error("❌ Teardown: login failed, leftovers NOT cleaned. Search items for prefix " + ENTITY_PREFIX);
    return;
  }
  const headers = apiHeaders(s, workspaceId);
  let deleted = 0;
  for (let page = 0; page < 20; page++) {
    const res = http.get(`${API_URL}/v1/item-profiles?search=${encodeURIComponent(ENTITY_PREFIX)}&limit=100&skip=0`,
      { headers, tags: { name: "teardown" } });
    const ids = (res.json()?.results || [])
      .filter((i) => String(i.name || "").startsWith(ENTITY_PREFIX))
      .map((i) => i.id);
    if (!ids.length) break;
    for (const id of ids) {
      const del = http.del(`${API_URL}/v1/items/${id}`, null, { headers, tags: { name: "teardown" } });
      if (del.status === 204 || del.status === 200) deleted++;
    }
  }
  console.log(`🧹 Teardown: removed ${deleted} leftover "${ENTITY_PREFIX}*" items`);
}

// Common setup: env checks, prod guard, login, workspace, endpoint probe.
export function stabilitySetup(scriptPath, banner) {
  if (!__ENV.EMAIL || !__ENV.PASSWORD) {
    throw new Error(`EMAIL and PASSWORD env vars required.\nRun: k6 run -e EMAIL=... -e PASSWORD=... -e WORKSPACE_ID=... ${scriptPath}`);
  }
  const s = loginTagged(__ENV.EMAIL, __ENV.PASSWORD, { phase: "setup" });
  if (!s) throw new Error("Setup login failed — check credentials / rate limit");

  if (!__ENV.WORKSPACE_ID) {
    console.warn("⚠️  WORKSPACE_ID not set — using the account's default workspace. " +
      "A dedicated workspace is strongly recommended so the test doesn't add junk to Team.");
  }
  const workspaceId = __ENV.WORKSPACE_ID || getDefaultWorkspace(s.userId, s.userToken);
  const enabledEndpoints = preflight(s, workspaceId);

  console.log(`\n✔️  ${banner}`);
  console.log(`   API       : ${API_URL}`);
  console.log(`   Frontend  : ${FRONT_URL}`);
  console.log(`   Workspace : ${workspaceId}`);
  console.log(`   Endpoints : ${enabledEndpoints.join(", ")}\n`);

  return { workspaceId, enabledEndpoints, startTime: Date.now() };
}
