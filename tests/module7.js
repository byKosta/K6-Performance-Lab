import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend, Gauge } from 'k6/metrics';
import { randomIntBetween } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';
import { htmlReport } from 'https://raw.githubusercontent.com/benc-uk/k6-reporter/main/dist/bundle.js';  // ← официальный HTML-генератор
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.1.0/index.js';  // ← для stdout

// === Кастомные метрики ===
const LoginSuccess = new Counter('custom_logins_success');
const LoginFails = new Counter('custom_logins_failed');
const LoginTime = new Trend('custom_login_duration_ms');
const ErrorRate = new Rate('custom_error_rate');
const ActiveUsers = new Gauge('custom_active_users');

export const options = {
  scenarios: {
    demo: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 100 },
        { duration: '1m', target: 100 },
        { duration: '30s', target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<400'],
    'custom_error_rate': ['rate<0.02'],
    'custom_login_duration_ms': ['p(95)<300'],
  },
};

export default function () {
  ActiveUsers.add(1);

  const start = Date.now();

  // Имитируем логин с 2% ошибок
  const shouldFail = randomIntBetween(1, 100) <= 2;
  const url = shouldFail 
    ? 'https://httpbin.org/status/500'
    : 'https://httpbin.org/status/200';

  const res = http.get(url);

  const duration = Date.now() - start;

  if (res.status === 200) {
    LoginSuccess.add(1);
    LoginTime.add(duration);
  } else {
    LoginFails.add(1);
    ErrorRate.add(1);
  }

  check(res, {
    'статус 200': (r) => r.status === 200,
  });

  ActiveUsers.add(-1);
  sleep(0.5);
}

// === handleSummary — генерит HTML автоматически ===
export function handleSummary(data) {
  return {
    'result.html': htmlReport(data),  // ← создаст result.html с графиками, таблицами и метриками
    stdout: textSummary(data, { indent: ' ', enableColors: true }),  // ← стандартный вывод в терминал
  };
}