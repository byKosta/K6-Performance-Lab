# itemit k6 Performance Lab

Performance, functional, and security tests for the **itemit** API (`test-api.itemit.com`).

---

## Project Structure

```
tests/itemit/
├── auth/
│   └── itemit-login.js              # Login + get credentials for other tests
├── functional/
│   ├── itemit-items-crud.js         # Full item lifecycle (Create → Read → Update → Delete)
│   └── itemit-e2e-flow.js           # Complete user journey (9 steps)
├── performance/
│   ├── itemit-item-profile-load.js  # Load test — GET /item-profiles/{id} (known bottleneck)
│   ├── itemit-stress.js             # Stress test — find the breaking point
│   └── itemit-soak.js               # Soak test — detect leaks/degradation over time
├── stability/                       # Why Cypress fails after 1–2 h — see stability/README.md
│   ├── itemit-stability-soak.js     # 1–3 VUs × 3 h, Cypress-like journey, p95 per 30-min window
│   ├── itemit-stability-data-volume.js # Same lists/search: dirty (14k items) vs clean workspace
│   ├── itemit-stability-ramp.js     # 1 → 5 → 10 → 20 VUs, 10 min per step
│   ├── itemit-stability-spike.js    # 1 → 25 → 1 VU, does the server recover?
│   └── lib/                         # config (endpoints, prod guard), client (tags, error types), journey, summary
└── security/
    ├── itemit-idor.js               # OWASP A1 — BOLA/IDOR cross-workspace access
    ├── itemit-auth-bypass.js        # OWASP A2 — Brute force, token bypass, enumeration
    ├── itemit-input-validation.js   # OWASP A3 — Injections, oversized inputs, type mismatches
    ├── itemit-rate-limit.js         # OWASP A4 — Rate limiting (100 req/min limit)
    └── itemit-headers.js            # OWASP A8 — CORS, security headers, info disclosure

src/auth/
└── login.js                         # Shared: login(), getDefaultWorkspace(), buildAuthHeaders()
```

---

## Prerequisites

```bash
brew install k6
```

---

## Common env vars

Secrets are not stored in the repo. Copy `.env.example` → `.env` (gitignored), fill it in and load it once per shell:

```bash
set -a; source .env; set +a   # k6 picks shell env vars up as __ENV
```

| Variable | Description | Default |
|---|---|---|
| `EMAIL` | Test account email | required |
| `PASSWORD` | Test account password | required |
| `BASE_URL` | API base URL | `https://test-api.itemit.com` |
| `API_KEY` | itemit API key (secret, never commit) | required |
| `WORKSPACE_ID` | Skip workspace fetch, use this ID | auto-fetched |
| `VUS` | Number of virtual users | per-test default |
| `DURATION` | Test duration | per-test default |

---

## Auth

Get credentials for use in other tests:

```bash
k6 run \
  -e EMAIL=you@example.com \
  -e PASSWORD=yourpass \
  tests/itemit/auth/itemit-login.js
```

Outputs `USER_ID`, `USER_TOKEN`, `WORKSPACE_ID` — copy into env vars for other tests.

---

## Functional Tests

### CRUD
```bash
k6 run \
  -e EMAIL=you@example.com \
  -e PASSWORD=yourpass \
  tests/itemit/functional/itemit-items-crud.js
```

### E2E User Journey
```bash
k6 run \
  -e EMAIL=you@example.com \
  -e PASSWORD=yourpass \
  tests/itemit/functional/itemit-e2e-flow.js
```

---

## Performance Tests

### Load test — item profile (primary bottleneck)
```bash
# Default: 20 VUs, 2 min steady
k6 run \
  -e EMAIL=you@example.com \
  -e PASSWORD=yourpass \
  tests/itemit/performance/itemit-item-profile-load.js

# Custom
k6 run \
  -e EMAIL=you@example.com \
  -e PASSWORD=yourpass \
  -e VUS=50 \
  -e STEADY=5m \
  tests/itemit/performance/itemit-item-profile-load.js
```

### Stress test — find breaking point
```bash
# Default peak: 60 VUs, scales up to 90 VUs (1.5×)
k6 run \
  -e EMAIL=you@example.com \
  -e PASSWORD=yourpass \
  -e MAX_VUS=60 \
  tests/itemit/performance/itemit-stress.js
```

### Soak test — memory leaks / degradation (long-running)
```bash
# Quick smoke (5 min)
k6 run \
  -e EMAIL=you@example.com \
  -e PASSWORD=yourpass \
  -e DURATION=5m \
  -e VUS=3 \
  tests/itemit/performance/itemit-soak.js

# Full soak (1 hour)
k6 run \
  -e EMAIL=you@example.com \
  -e PASSWORD=yourpass \
  -e DURATION=1h \
  -e VUS=10 \
  tests/itemit/performance/itemit-soak.js
```

---

## Security Tests

> ⚠️ Only run against `test-api.itemit.com`. Never run against production.

### IDOR / BOLA (requires 2 accounts in different workspaces)
```bash
k6 run \
  -e EMAIL_A=attacker@test.com -e PASSWORD_A=passA \
  -e EMAIL_B=victim@test.com   -e PASSWORD_B=passB \
  tests/itemit/security/itemit-idor.js
```

### Auth bypass / brute force
```bash
k6 run \
  -e EMAIL=you@example.com \
  -e PASSWORD=yourpass \
  tests/itemit/security/itemit-auth-bypass.js
```

### Input validation (injection, oversized payloads)
```bash
k6 run \
  -e EMAIL=you@example.com \
  -e PASSWORD=yourpass \
  tests/itemit/security/itemit-input-validation.js
```

### Rate limiting
```bash
k6 run \
  -e EMAIL=you@example.com \
  -e PASSWORD=yourpass \
  tests/itemit/security/itemit-rate-limit.js
```

### Security headers / CORS
```bash
k6 run \
  -e EMAIL=you@example.com \
  -e PASSWORD=yourpass \
  tests/itemit/security/itemit-headers.js
```

---

## With Grafana Monitoring

### Running k6 Tests via Docker

1. Start monitoring stack:
```bash
docker-compose up -d influxdb grafana
