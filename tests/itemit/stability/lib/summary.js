// End-of-test output: HTML report + raw JSON + text summary + a trend table
// (p95/p99 and errors per time window / phase). The table is the quick answer to
// "is p95 in hour 3 higher than in hour 1?" without opening Grafana.
import { htmlReport } from "https://raw.githubusercontent.com/benc-uk/k6-reporter/main/dist/bundle.js";
import { textSummary } from "https://jslib.k6.io/k6-summary/0.1.0/index.js";
import { displaySubmetrics } from "./config.js";

export const ERROR_TYPES = ["timeout", "network", "429", "5xx", "401", "4xx"];

// Thresholds needed so k6 computes per-window (or per-phase) submetrics
export function trendSubmetrics(tagKey, values) {
  return {
    ...displaySubmetrics("http_req_duration", values.map((v) => ({ target: "api", [tagKey]: v }))),
    ...displaySubmetrics("http_req_duration", values.map((v) => ({ target: "frontend", [tagKey]: v }))),
    ...displaySubmetrics("errors", values.map((v) => ({ [tagKey]: v }))),
    ...displaySubmetrics("errors", ERROR_TYPES.map((t) => ({ type: t }))),
    ...displaySubmetrics("errors", [{ target: "api" }, { target: "frontend" }]),
  };
}

const val = (data, key, stat) => data.metrics[key]?.values?.[stat];
const ms  = (v) => (v === undefined ? "     —" : `${Math.round(v)}`.padStart(6));

export function trendTable(data, tagKey, values) {
  const lines = [
    `\n  Trend by ${tagKey}`,
    `  ${tagKey.padEnd(14)} | API p95 | API p99 |  FE p95 |  FE p99 | errors`,
    `  ${"-".repeat(14)}-+---------+---------+---------+---------+-------`,
  ];
  const rows = [];
  for (const v of values) {
    const api = `http_req_duration{target:api,${tagKey}:${v}}`;
    const fe  = `http_req_duration{target:frontend,${tagKey}:${v}}`;
    const row = {
      v,
      apiP95: val(data, api, "p(95)"), apiP99: val(data, api, "p(99)"),
      feP95:  val(data, fe,  "p(95)"), feP99:  val(data, fe,  "p(99)"),
      errs:   val(data, `errors{${tagKey}:${v}}`, "count") || 0,
    };
    if (row.apiP95 === undefined && row.feP95 === undefined) continue; // window had no traffic
    rows.push(row);
    lines.push(`  ${v.padEnd(14)} |  ${ms(row.apiP95)} |  ${ms(row.apiP99)} |  ${ms(row.feP95)} |  ${ms(row.feP99)} | ${row.errs}`);
  }

  const types = ERROR_TYPES.map((t) => `${t}=${val(data, `errors{type:${t}}`, "count") || 0}`).join("  ");
  lines.push(`\n  Errors by type : ${types}`);
  lines.push(`  Errors by host : api=${val(data, "errors{target:api}", "count") || 0}  ` +
    `frontend=${val(data, "errors{target:frontend}", "count") || 0}`);

  if (rows.length >= 2) {
    const first = rows[0];
    const last  = rows[rows.length - 1];
    const ratio = (a, b) => (a && b ? (b / a).toFixed(2) : "n/a");
    lines.push(`\n  ${first.v} → ${last.v}: API p95 ×${ratio(first.apiP95, last.apiP95)}, ` +
      `FE p95 ×${ratio(first.feP95, last.feP95)}  (×1.5+ = degradation worth reporting)`);
  }
  return lines.join("\n") + "\n";
}

export function buildSummary(data, reportName, tagKey, values) {
  return {
    [`reports/${reportName}.html`]: htmlReport(data),
    [`reports/${reportName}.json`]: JSON.stringify(data, null, 2),
    stdout: textSummary(data, { indent: " ", enableColors: true }) + trendTable(data, tagKey, values),
  };
}
