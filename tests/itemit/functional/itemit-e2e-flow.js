// Full user journey: login → browse → view profile → create item → annotate → cleanup
import http from "k6/http";
import { check, group, sleep } from "k6";
import { Trend } from "k6/metrics";
import { uuidv4 } from "https://jslib.k6.io/k6-utils/1.4.0/index.js";
import { htmlReport } from "https://raw.githubusercontent.com/benc-uk/k6-reporter/main/dist/bundle.js";
import { textSummary } from "https://jslib.k6.io/k6-summary/0.1.0/index.js";
import { login, getDefaultWorkspace, buildAuthHeaders } from "../../../src/auth/login.js";

const sessionDuration = new Trend("e2e_session_duration_ms", true);
const stepTime        = new Trend("e2e_step_time_ms",        true);

export const options = {
  vus:      __ENV.VUS      ? parseInt(__ENV.VUS) : 2,
  duration: __ENV.DURATION || "2m",
  thresholds: {
    http_req_failed:       ["rate<0.05"],
    e2e_session_duration_ms: ["p(95)<30000"],  // full session under 30s
    e2e_step_time_ms:        ["p(95)<5000"],
  },
};

const BASE_URL = __ENV.BASE_URL || "https://test-api.itemit.com";

export function setup() {
  const email    = __ENV.EMAIL;
  const password = __ENV.PASSWORD;

  if (!email || !password) {
    throw new Error(
      "EMAIL and PASSWORD env vars required.\n" +
      "Run: k6 run -e EMAIL=you@example.com -e PASSWORD=pass tests/itemit/functional/itemit-e2e-flow.js"
    );
  }

  const { userId, userToken } = login(email, password);
  const workspaceId = __ENV.WORKSPACE_ID || getDefaultWorkspace(userId, userToken);

  console.log(`\n✔️  E2E flow ready | Workspace: ${workspaceId}\n`);
  return { userId, userToken, workspaceId };
}

export default function (data) {
  const headers      = buildAuthHeaders(data.userId, data.userToken, data.workspaceId);
  const sessionStart = Date.now();
  let createdItemId  = null;
  let createdInfoId  = null;
  let createdCommentId = null;

  // ── Step 1: Browse item list ──────────────────────────────────────────────
  group("Step 1: Browse items list", () => {
    const t   = Date.now();
    const res = http.get(`${BASE_URL}/v1/items?limit=25&skip=0`, { headers });
    stepTime.add(Date.now() - t);

    check(res, {
      "S1 Items list — 200":       () => res.status === 200,
      "S1 Items list — has results": () => res.json()?.results !== undefined,
    });

    sleep(1);
  });

  // ── Step 2: Search items ──────────────────────────────────────────────────
  group("Step 2: Search items", () => {
    const t   = Date.now();
    const res = http.get(`${BASE_URL}/v1/item-profiles?search=a&limit=10`, { headers });
    stepTime.add(Date.now() - t);

    check(res, {
      "S2 Search — 200": () => res.status === 200,
    });

    sleep(0.8);
  });

  // ── Step 3: View item profile (the known slow step) ──────────────────────
  group("Step 3: View item profile", () => {
    const listRes = http.get(`${BASE_URL}/v1/item-profiles?limit=1`, { headers });
    const firstId = listRes.json()?.results?.[0]?.id;

    if (firstId) {
      const t   = Date.now();
      const res = http.get(`${BASE_URL}/v1/item-profiles/${firstId}`, { headers });
      stepTime.add(Date.now() - t);

      check(res, {
        "S3 Item profile — 200":          () => res.status === 200,
        "S3 Item profile — has bookings": () => res.json()?.bookings !== undefined,
        "S3 Item profile — has info":     () => res.json()?.information !== undefined,
        "S3 Item profile — under 5s":     () => res.timings.duration < 5000,
      });
    }

    sleep(2);
  });

  // ── Step 4: Create new item ───────────────────────────────────────────────
  group("Step 4: Create item", () => {
    const itemId = uuidv4();
    const t      = Date.now();
    const res    = http.post(
      `${BASE_URL}/v1/items`,
      JSON.stringify([{
        id:          itemId,
        name:        `k6-e2e-${uuidv4().substring(0, 8)}`,
        description: "Created during k6 e2e flow test",
      }]),
      { headers }
    );
    stepTime.add(Date.now() - t);

    check(res, {
      "S4 Create item — 200": () => res.status === 200,
      "S4 Create item — id":  () => Array.isArray(res.json()) && !!res.json()[0]?.id,
    });

    if (res.status === 200) createdItemId = itemId;

    sleep(0.5);
  });

  if (createdItemId) {

    // ── Step 5: View created item profile ──────────────────────────────────
    group("Step 5: View created item profile", () => {
      const t   = Date.now();
      const res = http.get(`${BASE_URL}/v1/item-profiles/${createdItemId}`, { headers });
      stepTime.add(Date.now() - t);

      check(res, {
        "S5 Created profile — 200":  () => res.status === 200,
        "S5 Created profile — name": () => !!res.json()?.name,
      });

      sleep(1);
    });

    // ── Step 6: Add information to item ────────────────────────────────────
    group("Step 6: Add information field", () => {
      createdInfoId  = uuidv4();
      const t   = Date.now();
      const res = http.put(
        `${BASE_URL}/v1/items/${createdItemId}/information/${createdInfoId}`,
        JSON.stringify({ name: "Colour", text: "Blue", type: "TEXT" }),
        { headers }
      );
      stepTime.add(Date.now() - t);

      check(res, {
        "S6 Add information — 200": () => res.status === 200,
      });

      sleep(0.5);
    });

    // ── Step 7: Add comment to item ────────────────────────────────────────
    group("Step 7: Add comment", () => {
      createdCommentId = uuidv4();
      const t   = Date.now();
      const res = http.put(
        `${BASE_URL}/v1/items/${createdItemId}/comments/${createdCommentId}`,
        JSON.stringify({ text: "k6 e2e test comment — safe to delete" }),
        { headers }
      );
      stepTime.add(Date.now() - t);

      check(res, {
        "S7 Add comment — 200": () => res.status === 200,
      });

      sleep(0.5);
    });

    // ── Step 8: Update item ────────────────────────────────────────────────
    group("Step 8: Update item", () => {
      const t   = Date.now();
      const res = http.patch(
        `${BASE_URL}/v1/items/${createdItemId}`,
        JSON.stringify({ name: `k6-e2e-updated-${uuidv4().substring(0, 6)}`, description: "Updated in e2e flow" }),
        { headers }
      );
      stepTime.add(Date.now() - t);

      check(res, {
        "S8 Update item — 200": () => res.status === 200,
      });

      sleep(0.5);
    });

    // ── Step 9: Cleanup — delete created item (also removes info + comment) ─
    group("Step 9: Cleanup", () => {
      const res = http.del(`${BASE_URL}/v1/items/${createdItemId}`, null, { headers });
      check(res, { "S9 Delete item — 204": () => res.status === 204 });
    });
  }

  sessionDuration.add(Date.now() - sessionStart);
  sleep(1);
}

export function handleSummary(data) {
  return {
    "reports/itemit-e2e-flow-report.html": htmlReport(data),
    stdout: textSummary(data, { indent: " ", enableColors: true }),
  };
}
