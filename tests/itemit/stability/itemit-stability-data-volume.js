// Scenario 2 — DATA VOLUME: identical list/search requests against a "dirty" workspace
// (Team: 14 000+ items, ~2125 collections, ~360 "test name…" locations) and a clean/empty one.
// Read-only, 1 VU, requests are paired and interleaved (random order) so both workspaces see
// the same server state at the same moment. If dirty ≫ clean, the data volume is to blame, not load.
import http from "k6/http";
import { sleep } from "k6";
import { textSummary } from "https://jslib.k6.io/k6-summary/0.1.0/index.js";
import { htmlReport } from "https://raw.githubusercontent.com/benc-uk/k6-reporter/main/dist/bundle.js";
import { request, loginTagged, apiHeaders, preflight } from "./lib/client.js";
import { ERROR_TYPES } from "./lib/summary.js";
import { assertTestEnvironment, API_URL, LISTS, SEARCHES, SEARCH_TERMS, SUMMARY_TREND_STATS, displaySubmetrics } from "./lib/config.js";

assertTestEnvironment();

const DURATION   = __ENV.DURATION || "20m";
const WORKSPACES = ["dirty", "clean"];
// Each search term becomes its own request name, so "test name" (matches junk) is visible separately
const REQUESTS = [
  ...LISTS.map((l) => ({ name: l.name, base: l.name, path: l.path })),
  ...SEARCHES.flatMap((s) => SEARCH_TERMS.map((q) => ({
    name: `${s.name}_${q.replace(/\W+/g, "_")}`, base: s.name, path: s.path.replace("{q}", encodeURIComponent(q)),
  }))),
];

const perPair = (metric) => displaySubmetrics(metric,
  REQUESTS.flatMap((r) => WORKSPACES.map((workspace) => ({ name: r.name, workspace }))));

export const options = {
  scenarios: {
    compare: { executor: "constant-vus", vus: 1, duration: DURATION },
  },
  summaryTrendStats: SUMMARY_TREND_STATS,
  thresholds: {
    ...perPair("http_req_duration"),
    ...perPair("resp_body_bytes"),
    ...displaySubmetrics("errors", WORKSPACES.map((workspace) => ({ workspace }))),
    "http_req_failed": ["rate<0.01"],
  },
};

function connect(label, email, password, workspaceId) {
  if (!email || !password || !workspaceId) {
    throw new Error(`${label}: credentials and workspace ID required.\n` +
      "Run: k6 run -e EMAIL=... -e PASSWORD=... -e DIRTY_WORKSPACE_ID=... -e CLEAN_WORKSPACE_ID=... " +
      "[-e CLEAN_EMAIL=... -e CLEAN_PASSWORD=...] tests/itemit/stability/itemit-stability-data-volume.js");
  }
  const s = loginTagged(email, password, { phase: "setup" });
  if (!s) throw new Error(`${label}: login failed`);
  return { ...s, workspaceId, enabled: preflight(s, workspaceId) };
}

export function setup() {
  const dirty = connect("dirty", __ENV.EMAIL, __ENV.PASSWORD, __ENV.DIRTY_WORKSPACE_ID);
  const clean = connect("clean", __ENV.CLEAN_EMAIL || __ENV.EMAIL, __ENV.CLEAN_PASSWORD || __ENV.PASSWORD,
    __ENV.CLEAN_WORKSPACE_ID);

  // Compare only endpoints that exist in both workspaces
  const enabled = dirty.enabled.filter((n) => clean.enabled.includes(n));
  console.log(`\n✔️  Data volume comparison | ${DURATION} | endpoints: ${enabled.join(", ")}\n`);
  return { dirty, clean, enabled };
}

export default function (data) {
  for (const r of REQUESTS) {
    if (!data.enabled.includes(r.base)) continue;
    const order = Math.random() < 0.5 ? WORKSPACES : [...WORKSPACES].reverse();
    for (const ws of order) {
      const target = data[ws];
      request("GET", `${API_URL}${r.path}`, null, {
        name: r.name, target: "api", tags: { workspace: ws },
        headers: apiHeaders(target, target.workspaceId),
      });
      sleep(0.5);
    }
    sleep(1);
  }
}

export function handleSummary(data) {
  const v = (key, stat) => data.metrics[key]?.values?.[stat];
  const lines = [
    "\n  Dirty vs clean workspace (ms / KB)",
    `  ${"request".padEnd(38)} | dirty p95 | clean p95 | ratio | dirty KB | clean KB`,
    `  ${"-".repeat(38)}-+-----------+-----------+-------+----------+---------`,
  ];
  for (const r of REQUESTS) {
    const d  = v(`http_req_duration{name:${r.name},workspace:dirty}`, "p(95)");
    const c  = v(`http_req_duration{name:${r.name},workspace:clean}`, "p(95)");
    if (d === undefined || c === undefined) continue;
    const dk = (v(`resp_body_bytes{name:${r.name},workspace:dirty}`, "avg") || 0) / 1024;
    const ck = (v(`resp_body_bytes{name:${r.name},workspace:clean}`, "avg") || 0) / 1024;
    lines.push(`  ${r.name.padEnd(38)} | ${String(Math.round(d)).padStart(9)} | ${String(Math.round(c)).padStart(9)} | ` +
      `${(d / Math.max(c, 1)).toFixed(1).padStart(5)} | ${dk.toFixed(1).padStart(8)} | ${ck.toFixed(1).padStart(8)}`);
  }
  lines.push(`\n  Errors: dirty=${v("errors{workspace:dirty}", "count") || 0}  clean=${v("errors{workspace:clean}", "count") || 0}` +
    `  (types: ${ERROR_TYPES.join("/")} — see errors{type:...} in Grafana / JSON)`);
  lines.push("  ratio ≥ 3 on the same request → slowness is caused by data volume, not load\n");

  return {
    "reports/itemit-stability-data-volume.html": htmlReport(data),
    "reports/itemit-stability-data-volume.json": JSON.stringify(data, null, 2),
    stdout: textSummary(data, { indent: " ", enableColors: true }) + lines.join("\n") + "\n",
  };
}
