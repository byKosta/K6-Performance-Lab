// Shared config for the stability suite (soak / data-volume / ramp / spike).
// Endpoints marked verified:false are best guesses — confirm them in the browser Network tab
// on test-web and fix the paths here. Unverified endpoints are probed in setup() and
// skipped automatically if they return 404/405, so a wrong guess won't pollute error stats.
import { BASE_URL } from "../../../../src/auth/login.js";

export const API_URL   = BASE_URL.replace(/\/$/, "");
export const FRONT_URL = (__ENV.FRONT_URL || "https://test-web.itemit.com").replace(/\/$/, "");

// Cypress default responseTimeout is 30s — use the same so "timeout" means the same thing
export const HTTP_TIMEOUT = __ENV.HTTP_TIMEOUT || "30s";

// Every entity created by this suite starts with this prefix — teardown sweeps leftovers by it
export const ENTITY_PREFIX = __ENV.ENTITY_PREFIX || "k6-stab-";

// ── Production guard ─────────────────────────────────────────────────────────
// Links in emails point to web.itemit.com (prod). Refuse anything that isn't a test-* host.
export function assertTestEnvironment() {
  for (const url of [API_URL, FRONT_URL]) {
    const host = url.replace(/^https?:\/\//, "").split(/[/:]/)[0];
    if (host.endsWith("itemit.com") && !host.startsWith("test-")) {
      throw new Error(`❌ Refusing to run against non-test host "${host}". Use test-web / test-api only.`);
    }
  }
}

// ── API lists (GET) ──────────────────────────────────────────────────────────
export const LISTS = [
  { name: "items_list",            path: "/v1/items?limit=25&skip=0",                    verified: true  },
  { name: "item_profiles_list",    path: "/v1/item-profiles?limit=25&skip=0",            verified: true  },
  { name: "collections_list",      path: "/v1/collections?limit=25&skip=0",              verified: false },
  { name: "locations_list",        path: "/v1/locations?limit=25&skip=0",                verified: false },
  { name: "reports_list",          path: "/v1/reports",                                  verified: false },
  { name: "bookings_pending_list", path: "/v1/bookings/bookings-requests?pending=true",  verified: false },
  { name: "reminders_list",        path: "/v1/reminders?limit=25&skip=0",                verified: false },
];

// ── API search ({q} is replaced with the search term) ────────────────────────
export const SEARCHES = [
  { name: "items_search",       path: "/v1/item-profiles?search={q}&limit=25&skip=0", verified: true  },
  { name: "collections_search", path: "/v1/collections?search={q}&limit=25&skip=0",   verified: false },
  { name: "locations_search",   path: "/v1/locations?search={q}&limit=25&skip=0",     verified: false },
];

// "test name" matches the ~360 junk locations left by Cypress — worst case for search
export const SEARCH_TERMS = (__ENV.SEARCH_TERMS || "test name,a,k6").split(",");

// ── Frontend pages (cy.visit targets) ────────────────────────────────────────
export const PAGES = [
  { name: "fe_items",       path: "/items"       },
  { name: "fe_reports",     path: "/reports"     },
  { name: "fe_collections", path: "/collections" },
  { name: "fe_locations",   path: "/locations"   },
  { name: "fe_bookings",    path: "/bookings"    },
];

// Item archive body for PATCH /v1/items/{id}. Default is a plain update (verified to work).
// Once the Cypress archive payload is confirmed in Network, pass it via ITEM_ARCHIVE_BODY,
// e.g. -e ITEM_ARCHIVE_BODY='{"archived":true}'
export const ITEM_ARCHIVE_BODY = __ENV.ITEM_ARCHIVE_BODY ? JSON.parse(__ENV.ITEM_ARCHIVE_BODY) : null;

// Summary trend stats — p99 is required by the task, not shown by default
export const SUMMARY_TREND_STATS = ["avg", "med", "p(90)", "p(95)", "p(99)", "max"];

// Base thresholds from the task description
export const BASE_THRESHOLDS = {
  http_req_failed:                       ["rate<0.01"],
  "http_req_duration{name:items_list}":  ["p(95)<2000"],
  "http_req_duration{name:login}":       ["p(95)<1000"],
};

// Thresholds that always pass — used only to make k6 compute and print a submetric
// (e.g. p95 per time window or per endpoint) in the end-of-test summary.
export function displaySubmetrics(metric, tagSets) {
  const out = {};
  for (const tags of tagSets) {
    const sel = Object.entries(tags).map(([k, v]) => `${k}:${v}`).join(",");
    out[`${metric}{${sel}}`] = metric === "errors" ? ["count>=0"] : ["max>=0"];
  }
  return out;
}

export function allRequestNames() {
  return ["login", ...LISTS.map((l) => l.name), ...SEARCHES.map((s) => s.name),
    ...PAGES.map((p) => p.name), "fe_asset", "item_create", "item_profile", "item_archive", "item_delete"];
}
