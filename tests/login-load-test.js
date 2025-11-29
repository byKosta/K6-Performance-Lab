import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { SharedArray } from 'k6/data';
import { randomIntBetween } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';

// Загружаем переменные окружения
const env = __ENV.ENV ? JSON.parse(open(`../env/${__ENV.ENV}.json`)) : { BASE_URL: 'https://httpbin.org' };

// Загружаем пользователей один раз в память (очень быстро)
const users = new SharedArray('users', function () {
  const data = open('../data/users.csv');
  return data.split('\n').slice(1).map(line => {
    const [email, password] = line.split(',');
    return { email: email.trim(), password: password.trim() };
  });
});

export const options = {
  scenarios: {
    login_load: {
      executor: 'shared-iterations',
      vus: 50,
      iterations: 1000,
      maxDuration: '5m',
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<2000'],
    http_req_failed: ['rate<0.01'],
  },
};

export default function () {
  const user = users[randomIntBetween(0, users.length - 1)];

  group('Авторизация пользователя', () => {
    const url = `${env.BASE_URL}/post`;
    const payload = JSON.stringify({
      email: user.email,
      password: user.password,
    });

    const params = {
      headers: { 'Content-Type': 'application/json' },
      tags: { flow: 'login', env: __ENV.ENV || 'local' },
    };

    const res = http.post(url, payload, params);

    check(res, {
      'статус 200': (r) => r.status === 200,
      'в ответе есть наш email': (r) => r.json().data.includes(user.email),
    });
  });

  sleep(1);
}