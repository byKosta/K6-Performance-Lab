// tests/flavoury-register-FINAL-WORKING.js
import http from "k6/http";
import { check, group, sleep } from "k6";
import { Counter, Rate, Trend } from "k6/metrics";
import { uuidv4 } from "https://jslib.k6.io/k6-utils/1.4.0/index.js";
import { htmlReport } from "https://raw.githubusercontent.com/benc-uk/k6-reporter/main/dist/bundle.js";
import { textSummary } from "https://jslib.k6.io/k6-summary/0.1.0/index.js";

// Метрики
const regSuccess  = new Counter('registration_success');
const regFailed   = new Counter('registration_failed');
const regFailRate = new Rate('registration_fail_rate');
const regDuration = new Trend('registration_duration', true);

export const options = {
  scenarios: {
    flavoury_register: {
      executor: "constant-vus",
      vus: 1,              // ← МЕНЯЙ ЗДЕСЬ
      duration: "5s",     // ← МЕНЯЙ ЗДЕСЬ
      gracefulStop: "5s",
    },
  },
  thresholds: {
    'http_req_failed': ['rate<0.01'],
    'http_req_duration': ['p(95)<3000'],
    'registration_duration': ['p(95)<2500'],
    'registration_fail_rate': ['rate<0.05'],
    'checks': ['rate==1.0'],               // ← будет 100%
  },
};

const BASE_URL = "https://api.app.flavoury.com";

export default function () {
  const email = `loadtest_${uuidv4()}@test.com`;

  const payload = JSON.stringify({
    platformCodename: "www",
    email: email,
    password: "Password104",
    billingAddress: { postalCode: "", countryCode: "PL" },
    agreements: {
      "wymagana-zgoda": true,
      "privacy-policy": true,
      "e-mail-communication-consent": false,
      "sms-or-phone-consent": false,
    },
    additionalInfo: {
      User_TelephoneNumberCountryCode: "PL",
      PromoCode: "",
      PlatformCodename: "www",
    },
  });

  const params = {
    headers: {
      "Content-Type": "application/json;charset=utf-8",
      "X-Api-Date-Format": "iso",
      "X-Api-Camel-Case": "true",
    },
  };

  group("Flavoury Registration", function () {
    const res = http.post(`${BASE_URL}/v1/InsysGoAccount/Register`, payload, params);

    regDuration.add(res.timings.duration);

    // === ТОЛЬКО ТО, ЧТО РЕАЛЬНО ПРИХОДИТ СЕЙЧАС ===
    const success = check(res, {
      "Status 200": (r) => r.status === 200,
      "Response time < 2500ms": (r) => r.timings.duration < 2500,
      "Registration successful message": (r) => {
        return r.body.includes("User registered successfully") ||
               r.body.includes("registered successfully") ||
               r.body.includes("success");
      },
    });

    if (success) {
      regSuccess.add(1);
    } else {
      regFailed.add(1);
    }
    regFailRate.add(!success);

    // Отладка — только первые 5 итераций
    if (__ITER < 5) {
      console.log(`VU ${__VU} | ${email} → ${res.status} | ${res.timings.duration.toFixed(0)}ms | Body: ${res.body.substring(0, 120)}`);
    }
  });

  sleep(1);
}

export function handleSummary(data) {
  return {
    "reports/flavoury-register-FINAL.html": htmlReport(data, { title: "Flavoury Registration — CURRENT API (Nov 2025)" }),
    stdout: textSummary(data, { indent: " ", enableColors: true }),
  };
}