// One iteration = one typical Cypress test:
// login → visit pages → lists → search → create item → open it → archive (PATCH) → delete.
// 1–3 s pause between steps, like a real test run.
import { group, sleep } from "k6";
import { uuidv4 } from "https://jslib.k6.io/k6-utils/1.4.0/index.js";
import { API_URL, ENTITY_PREFIX, ITEM_ARCHIVE_BODY, LISTS, PAGES, SEARCHES, SEARCH_TERMS } from "./config.js";
import { request, ensureSession, invalidateSession, apiHeaders, visitPage } from "./client.js";

const think = () => sleep(1 + Math.random() * 2);
const pick  = (arr) => arr[Math.floor(Math.random() * arr.length)];

function apiGet(name, path, headers) {
  const res = request("GET", `${API_URL}${path}`, null, { name, target: "api", headers });
  if (res.status === 401) invalidateSession();
  return res;
}

// Each frontend page is followed by the API lists that page loads
const PAGE_FLOW = {
  fe_items:       ["items_list", "item_profiles_list"],
  fe_collections: ["collections_list"],
  fe_locations:   ["locations_list"],
  fe_reports:     ["reports_list"],
  fe_bookings:    ["bookings_pending_list", "reminders_list"],
};

export function runJourney(data, { loginMode }) {
  const enabled = new Set(data.enabledEndpoints);
  const lists   = Object.fromEntries(LISTS.map((l) => [l.name, l]));

  let session;
  group("01 login", () => {
    session = ensureSession(loginMode);
  });
  if (!session) {
    sleep(5); // login failed (429/5xx/timeout already recorded) — back off and retry next iteration
    return;
  }
  const headers = apiHeaders(session, data.workspaceId);
  think();

  // ── Pages + their lists ────────────────────────────────────────────────────
  PAGES.forEach((page, idx) => {
    group(`02 page ${page.name}`, () => {
      visitPage(page, idx === 0);
      for (const listName of PAGE_FLOW[page.name] || []) {
        if (enabled.has(listName)) apiGet(listName, lists[listName].path, headers);
      }
    });
    think();

    // Search right after the related page, like a user typing in the search box
    const search = SEARCHES.find((s) => s.name.split("_")[0] === page.name.replace("fe_", ""));
    if (search && enabled.has(search.name)) {
      group(`03 search ${search.name}`, () => {
        apiGet(search.name, search.path.replace("{q}", encodeURIComponent(pick(SEARCH_TERMS))), headers);
      });
      think();
    }
  });

  // ── Create → open → archive → delete (always cleans up after itself) ───────
  const itemId = uuidv4();
  let created  = false;

  group("04 item create", () => {
    const res = request("POST", `${API_URL}/v1/items`, JSON.stringify([{
      id:          itemId,
      name:        `${ENTITY_PREFIX}${itemId.substring(0, 8)}`,
      serial:      `K6S-${Date.now()}`,
      description: "k6 stability test — safe to delete",
    }]), { name: "item_create", target: "api", headers });
    created = res.status === 200;
  });
  if (!created) return;
  think();

  group("05 item open", () => {
    apiGet("item_profile", `/v1/item-profiles/${itemId}`, headers);
  });
  think();

  group("06 item archive", () => {
    const body = ITEM_ARCHIVE_BODY || { description: `k6 stability update ${Date.now()}` };
    request("PATCH", `${API_URL}/v1/items/${itemId}`, JSON.stringify(body),
      { name: "item_archive", target: "api", headers });
  });
  think();

  group("07 item delete", () => {
    request("DELETE", `${API_URL}/v1/items/${itemId}`, null,
      { name: "item_delete", target: "api", headers, expected: [200, 204] });
  });
  think();
}
