import http from "k6/http";
import encoding from "k6/encoding";

export const BASE_URL = __ENV.BASE_URL || "https://test-api.itemit.com";
// Secret — never hardcode. Pass via `-e API_KEY=...` or `set -a; source .env; set +a` (see .env.example)
export const API_KEY = __ENV.API_KEY;

if (!API_KEY) {
  throw new Error("API_KEY env var required. Copy .env.example to .env, fill it in, then: set -a; source .env; set +a");
}

// POST /login with BasicAuth → returns userId, userToken, tokenExpiry
export function login(email, password) {
  const credentials = encoding.b64encode(`${email}:${password}`);

  const res = http.post(`${BASE_URL}/v1/login`, null, {
    headers: {
      Authorization: `Basic ${credentials}`,
      "x-api-key": API_KEY,
      accept: "application/json",
    },
  });

  if (res.status === 429) {
    const body = res.json();
    throw new Error(`Login rate-limited (429). Retry after: ${body?.message || res.body}`);
  }

  if (res.status !== 200) {
    throw new Error(`Login failed [${res.status}]: ${res.body}`);
  }

  const body = res.json();

  if (!body.token?.id || !body.user?.id) {
    throw new Error(`Login response missing token or user: ${res.body}`);
  }

  return {
    userId: body.user.id,
    userToken: body.token.id,
    tokenExpiry: body.token.expiry,
  };
}

// GET /workspaces → returns the ID of the first (default) workspace
export function getDefaultWorkspace(userId, userToken) {
  const res = http.get(`${BASE_URL}/v1/workspaces`, {
    headers: buildAuthHeaders(userId, userToken),
  });

  if (res.status !== 200) {
    throw new Error(`Workspaces fetch failed [${res.status}]: ${res.body}`);
  }

  const body = res.json();

  if (!body.results?.length) {
    throw new Error("No workspaces found for this account");
  }

  return body.results[0].id;
}

// Build standard auth headers for all authenticated requests
export function buildAuthHeaders(userId, userToken, workspaceId = null) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json",
    "x-api-key": API_KEY,
    "x-user-id": userId,
    "x-user-token": userToken,
  };

  if (workspaceId) {
    headers["x-workspace-id"] = workspaceId;
  }

  return headers;
}
