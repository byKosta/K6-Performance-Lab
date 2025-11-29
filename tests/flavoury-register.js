// Custom metrics
const registrationSuccess = new Counter('registration_success');
const registrationFailRate = new Rate('registration_fail_rate');
const registrationDuration = new Trend('registration_duration');
const registrationStatus = new Gauge('registration_status');
// tests/flavoury-register-full-report.js
import http from "k6/http";
import { Counter, Rate, Trend, Gauge } from "k6/metrics";
import { check, sleep } from "k6";

import { uuidv4 } from "https://jslib.k6.io/k6-utils/1.4.0/index.js";
import { htmlReport } from "https://raw.githubusercontent.com/benc-uk/k6-reporter/main/dist/bundle.js";
import { textSummary } from "https://jslib.k6.io/k6-summary/0.1.0/index.js";

export const options = {
  scenarios: {
    flavoury_register: {
      executor: "constant-vus",
      vus: 1,                       // ← ИЗМЕНИ ЗДЕСЬ: 1 → 100 → 1000 → 5000
      duration: "10s",               // ← ИЗМЕНИ ЗДЕСЬ: 1m → 5m → 10m
      // Пример на 1000 VU × 5 минут:
      // vus: 1000,
      // duration: "5m",
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.05"],     // < 5% ошибок
    http_req_duration: ["p(95)<2500"],  // p95 < 2.5 сек (даём запас)
    checks: ["rate>0.95"],
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

  const res = http.post(`${BASE_URL}/v1/InsysGoAccount/Register`, payload, params);


  const success = check(res, {
    "Registration successful (200)": (r) => r.status === 200,
    "Response contains email or success": (r) =>
      r.body.includes(email) || r.body.toLowerCase().includes("success"),
  });

  // Custom metrics usage
  registrationSuccess.add(success ? 1 : 0);
  registrationFailRate.add(!success);
  registrationDuration.add(res.timings.duration);
  registrationStatus.add(res.status);

  // Pretty log (only for VU 1–10 to avoid spamming)
  if (__VU <= 10) {
    console.log(
      `${success ? "Success" : "Error"} VU ${__VU} | ${email} → ${res.status} | ${(
        res.timings.duration
      ).toFixed(0)}ms`
    );
  }

  sleep(1);
}

  // Report generation
  export function handleSummary(data) {
    return {
      "reports/flavoury-report.html": htmlReport(data, { title: "Flavoury.com — Registration" }),
      "reports/flavoury-summary.json": JSON.stringify(data, null, 2),
      stdout: textSummary(data, { indent: " ", enableColors: true }),
    };
  }