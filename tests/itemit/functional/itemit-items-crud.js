import http from "k6/http";
import { check, group, sleep } from "k6";
import { Trend } from "k6/metrics";
import { uuidv4 } from "https://jslib.k6.io/k6-utils/1.4.0/index.js";
import { htmlReport } from "https://raw.githubusercontent.com/benc-uk/k6-reporter/main/dist/bundle.js";
import { textSummary } from "https://jslib.k6.io/k6-summary/0.1.0/index.js";
import { login, getDefaultWorkspace, buildAuthHeaders } from "../../../src/auth/login.js";

const createTime  = new Trend("item_crud_create_ms",  true);
const readTime    = new Trend("item_crud_read_ms",    true);
const updateTime  = new Trend("item_crud_update_ms",  true);
const deleteTime  = new Trend("item_crud_delete_ms",  true);

export const options = {
  vus:      __ENV.VUS      ? parseInt(__ENV.VUS)      : 3,
  duration: __ENV.DURATION || "30s",
  thresholds: {
    http_req_failed:     ["rate<0.05"],
    http_req_duration:   ["p(95)<3000"],
    item_crud_create_ms: ["p(95)<2000"],
    item_crud_read_ms:   ["p(95)<3000"],
    item_crud_update_ms: ["p(95)<2000"],
    item_crud_delete_ms: ["p(95)<2000"],
  },
};

const BASE_URL = __ENV.BASE_URL || "https://test-api.itemit.com";

export function setup() {
  const email    = __ENV.EMAIL;
  const password = __ENV.PASSWORD;

  if (!email || !password) {
    throw new Error(
      "EMAIL and PASSWORD env vars required.\n" +
      "Run: k6 run -e EMAIL=you@example.com -e PASSWORD=pass tests/itemit/functional/itemit-items-crud.js"
    );
  }

  const { userId, userToken } = login(email, password);
  const workspaceId = __ENV.WORKSPACE_ID || getDefaultWorkspace(userId, userToken);

  console.log(`\n✔️  Auth OK | Workspace: ${workspaceId}\n`);

  return { userId, userToken, workspaceId };
}

export default function (data) {
  const headers = buildAuthHeaders(data.userId, data.userToken, data.workspaceId);
  let itemId;

  // ── CREATE ──────────────────────────────────────────────────────────────────
  group("CREATE /items", () => {
    itemId = uuidv4();
    const name   = `k6-crud-${uuidv4().substring(0, 8)}`;
    const serial = `K6-${Date.now()}`;

    const res = http.post(
      `${BASE_URL}/v1/items`,
      JSON.stringify([{ id: itemId, name, serial, description: "k6 CRUD test item" }]),
      { headers }
    );

    createTime.add(res.timings.duration);

    const json = res.json();
    const created = Array.isArray(json) ? json[0] : null;

    check(res, {
      "CREATE — status 200":        () => res.status === 200,
      "CREATE — returns array":     () => Array.isArray(json),
      "CREATE — item id matches":   () => created?.id === itemId,
      "CREATE — item has name":     () => !!created?.name,
      "CREATE — time < 2000ms":     () => res.timings.duration < 2000,
    });

    if (res.status !== 200) {
      console.error(`❌ CREATE failed [${res.status}]: ${res.body?.substring(0, 300)}`);
      itemId = null;
    }
  });

  if (!itemId) return; // skip remaining steps if creation failed

  sleep(0.3);

  // ── READ (full item profile) ─────────────────────────────────────────────
  group("READ /item-profiles/{id}", () => {
    const res = http.get(`${BASE_URL}/v1/item-profiles/${itemId}`, { headers });

    readTime.add(res.timings.duration);

    const json = res.json();

    check(res, {
      "READ — status 200":          () => res.status === 200,
      "READ — id matches":          () => json?.id === itemId,
      "READ — has photos field":    () => json && "photos" in json,
      "READ — has bookings field":  () => json && "bookings" in json,
      "READ — time < 3000ms":       () => res.timings.duration < 3000,
    });

    if (res.status !== 200) {
      console.error(`❌ READ failed [${res.status}]: ${res.body?.substring(0, 300)}`);
    }
  });

  sleep(0.3);

  // ── UPDATE ───────────────────────────────────────────────────────────────
  group("UPDATE PATCH /items/{id}", () => {
    const res = http.patch(
      `${BASE_URL}/v1/items/${itemId}`,
      JSON.stringify({
        name:        `k6-crud-updated-${uuidv4().substring(0, 8)}`,
        description: "Updated by k6 CRUD test",
      }),
      { headers }
    );

    updateTime.add(res.timings.duration);

    const json = res.json();

    check(res, {
      "UPDATE — status 200":              () => res.status === 200,
      "UPDATE — description updated":     () => json?.description === "Updated by k6 CRUD test",
      "UPDATE — time < 2000ms":           () => res.timings.duration < 2000,
    });

    if (res.status !== 200) {
      console.error(`❌ UPDATE failed [${res.status}]: ${res.body?.substring(0, 300)}`);
    }
  });

  sleep(0.3);

  // ── DELETE ───────────────────────────────────────────────────────────────
  group("DELETE /items/{id}", () => {
    const res = http.del(`${BASE_URL}/v1/items/${itemId}`, null, { headers });

    deleteTime.add(res.timings.duration);

    check(res, {
      "DELETE — status 204":   () => res.status === 204,
      "DELETE — time < 2000ms": () => res.timings.duration < 2000,
    });

    if (res.status !== 204) {
      console.error(`❌ DELETE failed [${res.status}]: ${res.body?.substring(0, 300)}`);
    }
  });

  sleep(1);
}

export function handleSummary(data) {
  return {
    "reports/itemit-items-crud-report.html": htmlReport(data),
    stdout: textSummary(data, { indent: " ", enableColors: true }),
  };
}
