'use strict';

/**
 * 前端共享客户端（js/district-api.js）逻辑验证：
 * 在 node 中模拟 window/fetch/sessionStorage，验证乱序回包被丢弃。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadDistrictAPI({ fetchImpl }) {
  const sessionData = new Map();
  const sandbox = {
    console,
    location: { origin: 'http://localhost', hash: '', pathname: '/districts.html', search: '' },
    document: { referrer: '', querySelector: () => null },
    history: { length: 1, back() {}, replaceState() {} },
    sessionStorage: {
      getItem: (k) => (sessionData.has(k) ? sessionData.get(k) : null),
      setItem: (k, v) => sessionData.set(k, String(v)),
      removeItem: (k) => sessionData.delete(k),
    },
    fetch: fetchImpl,
    requestAnimationFrame: (fn) => fn(),
    URL,
    URLSearchParams,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const code = fs.readFileSync(path.join(__dirname, '..', '..', 'js', 'district-api.js'), 'utf8');
  vm.runInContext(code, sandbox);
  return sandbox.DistrictAPI;
}

test('前端防乱序：同一资源键的迟到旧响应被丢弃', async () => {
  // 构造可控 fetch：第一次请求慢、第二次快，模拟回包乱序
  let call = 0;
  const fetchImpl = (url) => {
    call += 1;
    const myCall = call;
    return new Promise((resolve) => {
      const latency = myCall === 1 ? 50 : 5; // 旧请求后到
      setTimeout(() => resolve({
        ok: true,
        status: 200,
        json: async () => ({ items: [`response-${myCall}`] }),
        headers: { get: () => String(myCall) },
      }), latency);
    });
  };

  const api = loadDistrictAPI({ fetchImpl });
  const slow = api.fetchJSON('districts:list', '/api/districts?theme=all');   // 先发出，后到
  const fast = api.fetchJSON('districts:list', '/api/districts?theme=food');  // 后发出，先到
  const [r1, r2] = await Promise.all([slow, fast]);

  assert.equal(r1, null, '先发出的旧请求回包迟到 → 丢弃');
  assert.ok(r2 && r2.ok, '最新请求的响应被接受');
  assert.deepEqual(r2.data.items, ['response-2']);
});

test('前端防乱序：不同资源键互不影响', async () => {
  const fetchImpl = (url) => Promise.resolve({
    ok: true, status: 200,
    json: async () => ({ url }),
    headers: { get: () => '1' },
  });
  const api = loadDistrictAPI({ fetchImpl });
  const [a, b] = await Promise.all([
    api.fetchJSON('district:old-town', '/api/districts/old-town'),
    api.fetchJSON('route:loop', '/api/routes/loop'),
  ]);
  assert.ok(a.ok && b.ok, '不同键的响应都被接受');
});

test('状态存取：来源/筛选/滚动锚点可保存与恢复', () => {
  const api = loadDistrictAPI({ fetchImpl: () => Promise.reject(new Error('no fetch')) });
  api.store.save(api.KEYS.listState, { theme: 'food', q: '夜市', scrollY: 320 });
  // 跨 VM 上下文的对象原型不同，序列化后比较
  const restored = JSON.parse(JSON.stringify(api.store.load(api.KEYS.listState)));
  assert.deepEqual(restored, { theme: 'food', q: '夜市', scrollY: 320 });
});

test('深链接：无同站来源时 goBack 回退到确定入口', () => {
  const sessionData = new Map();
  const sandbox = {
    console,
    location: { origin: 'http://localhost', hash: '', pathname: '/route.html', search: '?r=x', href: '' },
    document: { referrer: '', querySelector: () => null },
    history: { length: 1, back() { throw new Error('不应调用 history.back'); }, replaceState() {} },
    sessionStorage: {
      getItem: (k) => (sessionData.has(k) ? sessionData.get(k) : null),
      setItem: (k, v) => sessionData.set(k, String(v)),
      removeItem: (k) => sessionData.delete(k),
    },
    fetch: () => Promise.reject(new Error('no fetch')),
    requestAnimationFrame: (fn) => fn(),
    URL, URLSearchParams,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  const code = fs.readFileSync(path.join(__dirname, '..', '..', 'js', 'district-api.js'), 'utf8');
  vm.runInContext(code, sandbox);
  const api = sandbox.DistrictAPI;

  assert.equal(api.hasSameOriginReferrer(), false, '空 referrer 判定为深链接');
  api.goBack('districts.html');
  assert.equal(sandbox.location.href, 'districts.html', '无历史时跳转确定入口');
});
