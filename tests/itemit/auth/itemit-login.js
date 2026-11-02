import http from "k6/http";
import { check } from "k6";
import { htmlReport } from "https://raw.githubusercontent.com/benc-uk/k6-reporter/main/dist/bundle.js";
import { textSummary } from "https://jslib.k6.io/k6-summary/0.1.0/index.js";
import { login, getDefaultWorkspace, buildAuthHeaders } from "../../../src/auth/login.js";

export const options = {
  vus: 1,
  iterations: 1,
  thresholds: {
    http_req_failed: ["rate<0.05"],
    http_req_duration: ["p(95)<3000"],
  },
};

const BASE_URL = __ENV.BASE_URL || "https://test-api.itemit.com";

// Runs once before the test — performs login and fetches workspace
export function setup() {
  const email = __ENV.EMAIL;
  const password = __ENV.PASSWORD;

  if (!email || !password) {
    throw new Error(
      "EMAIL and PASSWORD env vars required.\n" +
      "Run: k6 run -e EMAIL=you@example.com -e PASSWORD=yourpass tests/itemit/auth/itemit-login.js"
    );
  }

  const { userId, userToken, tokenExpiry } = login(email, password);
  const workspaceId = getDefaultWorkspace(userId, userToken);

  console.log("\n========== AUTH CREDENTIALS (copy for other tests) ==========");
  console.log(`  USER_ID=${userId}`);
  console.log(`  USER_TOKEN=${userToken}`);
  console.log(`  WORKSPACE_ID=${workspaceId}`);
  console.log(`  TOKEN_EXPIRY=${tokenExpiry}`);
  console.log("==============================================================\n");

  return { userId, userToken, workspaceId };
}

// Validates the obtained token actually works against GET /account
export default function (data) {
  const res = http.get(`${BASE_URL}/v1/account`, {
    headers: buildAuthHeaders(data.userId, data.userToken),
  });

  const json = res.json();

  check(res, {
    "GET /account — status 200": () => res.status === 200,
    "Account has id": () => json && !!json.id,
    "Account has email": () => json && !!json.email,
    "Account is active": () => json && json.active === true,
    "Account is confirmed": () => json && json.confirmed === true,
    "Response time < 2000ms": () => res.timings.duration < 2000,
  });

  if (res.status === 200) {
    console.log(`✔️  Authenticated as: ${json.firstName} ${json.lastName} <${json.email}>`);
  } else {
    console.error(`❌ Auth validation failed: ${res.status} - ${res.body}`);
  }
}

export function handleSummary(data) {
  return {
    "reports/itemit-login-report.html": htmlReport(data),
    stdout: textSummary(data, { indent: " ", enableColors: true }),
  };
}
