import { sleep, check } from 'k6';
import { browser } from 'k6/x/browser';
import ws from 'k6/experimental/websockets';

export const options = {
  scenarios: {
    ui: {
      executor: 'shared-iterations',
      vus: 20,
      iterations: 60,
      maxDuration: '2m',
      exec: 'browserTest',
    },
    ws: {
      executor: 'constant-vus',
      vus: 30,
      duration: '1m',
      exec: 'websocketTest',
    },
  },
};

export function browserTest() {
  const page = browser.newPage();
  try {
    page.goto('https://test.k6.io');
    check(page, { 'заголовок k6': p => p.title().includes('k6') });

    page.locator('a[href="/my_messages.php"]').click();
    sleep(1);

    page.locator('input[name="message"]').type(`Привет от VU ${__VU}!`);
    page.screenshot({ path: `screenshots/vu${__VU}-iter${__ITER}.png` });
    page.locator('button[type="submit"]').click();
    sleep(2);
  } finally {
    page.close();
  }
}

export function websocketTest() {
  const socket = ws.connect('wss://echo.websocket.org');
  socket.then(s => {
    s.send(`VU ${__VU} iter ${__ITER}`);
    s.setTimeout(() => s.close(), 3000);
  });
}
