import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE_URL = 'https://test-api.k6.io/public/crocodiles/';  // ← простой публичный эндпоинт, без auth

export const options = {
  scenarios: {
    public_load: {
      executor: 'per-vu-iterations',
      vus: 50,
      iterations: 20,      // 1000 запросов всего
      maxDuration: '2m',
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<500'],  // для публичного API
    http_req_failed: ['rate<0.01'],
  },
};

export default function () {
  // 1. GET список крокодилов (публичный, без токена)
  const res = http.get(BASE_URL);
  check(res, { 
    'список крокодилов 200': (r) => r.status === 200,
    'массив в ответе': (r) => Array.isArray(r.json()),
  });

  // 2. POST новый крокодил (публичный, без auth)
  const payload = JSON.stringify({
    name: `Croc from VU ${__VU} iter ${__ITER}`,
    sex: __ITER % 2 === 0 ? 'm' : 'f',
    date_of_birth: '2010-01-01',
  });

  const postRes = http.post(`${BASE_URL}1/`, payload, {  // /1/ — ID для простоты
    headers: { 'Content-Type': 'application/json' },
  });
  check(postRes, { 
    'крокодил создан 201': (r) => r.status === 201,
  });

  sleep(0.5);  // короче пауза для скорости
}