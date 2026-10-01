'use strict';

/**
 * 验收测试（node:test）：
 *  1. 两个编辑同时移动章节 —— 后到者 409 且拿到最新状态
 *  2. 删除仍被引用的街区 —— 409 + 引用清单
 *  3. 跨区路线拆分 —— 新路线、迁移关系、替代指向
 *  4. 缓存回包乱序 —— 旧 seq 写入被拒绝
 *  5. 面包屑与后端权限一致
 *  6. 未公开章节不得通过路线关联接口泄漏
 *  7. 章节层级循环检查（路线关联无此限制）
 *  8. 边界修改 → 复核队列（不按旧中心点永远继承）
 *  9. 别名 / 迁移关系 / 撤回替代指向（深链接确定入口）
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { MemoryStore, seed } = require('../src/store');
const { VersionedCache } = require('../src/cache');
const services = require('../src/services');
const { createServer } = require('../src/server');
const { VersionConflictError, ConflictError, ValidationError, GoneError, NotFoundError } = require('../src/errors');

const editor = { id: 'editor-a', role: 'editor' };
const editorB = { id: 'editor-b', role: 'editor' };
const anon = null;

function ctx() {
  const store = seed(new MemoryStore());
  const cache = new VersionedCache();
  return { store, cache };
}

// ---------- 1. 两个编辑同时移动章节 ----------
test('两个编辑同时移动章节：先提交者成功，后到者 409 并获最新状态', async () => {
  const { store, cache } = ctx();
  const before = await store.getChapter('C1A');
  assert.equal(before.version, 1);
  assert.equal(before.parentId, 'C1');

  // 编辑 A、B 都基于 version=1 发起移动
  const moveA = services.moveChapter(store, cache, { id: 'C1A', newParentId: null, baseVersion: 1, actor: editor });
  const moveB = services.moveChapter(store, cache, { id: 'C1A', newParentId: 'C1', baseVersion: 1, actor: editorB });

  const [resultA, resultB] = await Promise.allSettled([moveA, moveB]);
  const fulfilled = [resultA, resultB].filter((r) => r.status === 'fulfilled');
  const rejected = [resultA, resultB].filter((r) => r.status === 'rejected');

  assert.equal(fulfilled.length, 1, '恰好一个移动成功');
  assert.equal(rejected.length, 1, '另一个必须冲突');
  const err = rejected[0].reason;
  assert.ok(err instanceof VersionConflictError, '冲突类型为 VERSION_CONFLICT');
  assert.equal(err.status, 409);
  assert.ok(err.details.current, '409 响应携带当前最新状态');
  assert.equal(err.details.current.version, 2, '最新版本已递增');

  const after = await store.getChapter('C1A');
  assert.equal(after.version, 2);
  assert.equal(after.parentId, null, '以先提交者（编辑 A）的结果为准');
});

test('章节移动：目标为自身或后代时拒绝（层级循环检查）', async () => {
  const { store, cache } = ctx();
  // 移动到自身
  await assert.rejects(
    services.moveChapter(store, cache, { id: 'C1', newParentId: 'C1', baseVersion: 1, actor: editor }),
    (e) => e instanceof ValidationError && /循环/.test(e.message)
  );
  // 移动到后代 C1A（C1 -> C1A 构成环）
  await assert.rejects(
    services.moveChapter(store, cache, { id: 'C1', newParentId: 'C1A', baseVersion: 1, actor: editor }),
    (e) => e instanceof ValidationError && /循环/.test(e.message)
  );
  // 跨街区移动被拒绝（章节树在街区内）
  await assert.rejects(
    services.moveChapter(store, cache, { id: 'C1', newParentId: 'C3', baseVersion: 1, actor: editor }),
    (e) => e instanceof ValidationError && /同一街区/.test(e.message)
  );
});

// ---------- 2. 删除仍被引用的街区 ----------
test('删除仍被引用的街区：409 并返回引用清单；解除引用后可删', async () => {
  const { store, cache } = ctx();
  await assert.rejects(
    services.deleteDistrict(store, cache, { id: 'D1', actor: editor }),
    (e) => {
      assert.ok(e instanceof ConflictError);
      assert.equal(e.status, 409);
      assert.ok(Array.isArray(e.details.references));
      assert.ok(e.details.references.some((r) => r.routeId === 'R1'));
      return true;
    }
  );

  // 新建一个无引用、无章节的街区，可以删除
  store.districts.set('D9', { id: 'D9', slug: 'temp', name: '临时区', theme: 'history', summary: '', history: '', status: 'published', boundaryVersion: 1, version: 1, createdAt: '', updatedAt: '' });
  const ok = await services.deleteDistrict(store, cache, { id: 'D9', actor: editor });
  assert.equal(ok.deleted, true);
  assert.equal(await store.getDistrict('D9'), null);
});

// ---------- 3. 跨区路线拆分 ----------
test('跨区路线拆分：生成单区新路线、迁移关系与替代指向', async () => {
  const { store, cache } = ctx();
  const result = await services.splitRoute(store, cache, { routeId: 'R1', actor: editor });

  assert.equal(result.original.status, 'split');
  assert.ok(result.original.fallbackRouteId, '原路线有替代指向');
  assert.equal(result.newRoutes.length, 2, 'R1 跨 D1/D2，拆成两条');

  for (const nr of result.newRoutes) {
    const links = await store.listRouteDistricts(nr.route.id);
    assert.equal(links.length, 1, '新路线只关联一个街区');
    assert.equal(links[0].role, 'primary', '新路线的关联即主要展示入口');
    const stops = await store.listRouteStops(nr.route.id);
    assert.ok(stops.length > 0, '新路线继承了停留点');
    // 停留点都属于对应街区
    for (const rs of stops) {
      const stop = await store.getStop(rs.stopId);
      const chapter = await store.getChapter(stop.chapterId);
      assert.equal(chapter.districtId, nr.districtId);
    }
  }

  // 迁移关系
  const migrations = await store.findRouteMigrations('R1');
  assert.equal(migrations.length, 2);
  assert.ok(migrations.every((m) => m.reason === 'split'));

  // 原路线对匿名返回 410 + 替代指向（深链接有确定入口）
  await assert.rejects(
    services.getRouteDetail(store, cache, 'city-memory-loop', anon),
    (e) => {
      assert.ok(e instanceof GoneError);
      assert.equal(e.status, 410);
      assert.ok(e.details.fallbackRouteId, '410 携带替代指向');
      return true;
    }
  );

  // 单区路线不可拆分
  await assert.rejects(
    services.splitRoute(store, cache, { routeId: 'R2', actor: editor }),
    (e) => e instanceof ValidationError
  );
});

// ---------- 4. 缓存回包乱序 ----------
test('缓存回包乱序：旧 seq 写入被拒绝，tombstone 防止复活', () => {
  const cache = new VersionedCache();
  const r1 = cache.set('k', { v: 1 });          // seq=1
  assert.ok(r1.accepted);
  const r2 = cache.set('k', { v: 2 });          // seq=2
  assert.ok(r2.accepted);

  // 迟到的旧回包（seq=1）不得覆盖
  const stale = cache.set('k', { v: 'stale' }, r1.seq);
  assert.equal(stale.accepted, false);
  assert.equal(cache.get('k').value.v, 2);

  // 失效后，迟到的旧包不得复活该键
  cache.invalidate('k');
  assert.equal(cache.get('k'), null);
  const zombie = cache.set('k', { v: 'zombie' }, r2.seq);
  assert.equal(zombie.accepted, false);
  assert.equal(cache.get('k'), null);

  // 新回源（更大 seq）可以写入
  const fresh = cache.set('k', { v: 3 });
  assert.ok(fresh.accepted);
  assert.equal(cache.get('k').value.v, 3);
});

test('HTTP 层：响应携带 X-Cache-Seq，编辑操作使缓存失效', async () => {
  const { store, cache } = ctx();
  const server = createServer({ store, cache });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  try {
    const res1 = await fetch(`${base}/api/districts/old-town`);
    assert.equal(res1.status, 200);
    const seq1 = Number(res1.headers.get('x-cache-seq'));
    assert.ok(seq1 > 0, '响应携带缓存序号');

    // 再读一次（命中缓存，seq 不变）
    const res2 = await fetch(`${base}/api/districts/old-town`);
    assert.equal(Number(res2.headers.get('x-cache-seq')), seq1);

    // 编辑修改边界 → 缓存失效 → 下次读取 seq 递增
    const d1 = await store.getDistrict('D1');
    const res3 = await fetch(`${base}/api/districts/D1/boundary`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Role': 'editor', 'X-Actor-Id': 'editor-a' },
      body: JSON.stringify({ boundary: [[116.39, 39.9], [116.4, 39.91]], baseVersion: d1.version }),
    });
    assert.equal(res3.status, 200);

    const res4 = await fetch(`${base}/api/districts/old-town`);
    const seq4 = Number(res4.headers.get('x-cache-seq'));
    assert.ok(seq4 > seq1, '失效后重新回源，缓存序号单调递增');
  } finally {
    server.close();
  }
});

// ---------- 5. 面包屑与后端权限一致 ----------
test('面包屑由后端按权限生成：匿名看不到未公开祖先', async () => {
  const { store, cache } = ctx();
  // 构造：公开章节 C1A 挂到未公开章节 C2 下
  await store.moveChapter('C1A', 'C2', (await store.getChapter('C1A')).version);

  const bcAnon = await services.getBreadcrumb(store, 'C1A', anon);
  assert.ok(bcAnon.trail.every((t) => t.status === 'published'), '匿名面包屑只含公开章节');
  assert.ok(!bcAnon.trail.some((t) => t.id === 'C2'), '未公开章节不出现在匿名面包屑');
  assert.ok(bcAnon.trail.length >= 1, '匿名也有确定入口（自身可见）');

  const bcEditor = await services.getBreadcrumb(store, 'C1A', editor);
  assert.ok(bcEditor.trail.some((t) => t.id === 'C2'), '编辑可见完整路径');
});

// ---------- 6. 未公开章节不得通过路线关联接口泄漏 ----------
test('未公开章节不得通过路线关联接口泄漏（含计数）', async () => {
  const { store, cache } = ctx();
  // R3 含未公开章节 C2 的停留点 S7；R3 本身已撤回 → 匿名 410
  await assert.rejects(services.getRouteDetail(store, cache, 'old-town-deep', anon), GoneError);

  // 把 R3 改回发布，验证匿名仍看不到 S7 与 C2
  await store.updateRoute('R3', { status: 'published' });
  cache.invalidatePrefix('route:slug:old-town-deep');

  const anonView = await services.getRouteDetail(store, cache, 'old-town-deep', anon);
  assert.ok(anonView.stops.every((s) => s.chapterStatus === 'published'), '匿名只见公开章节的停留点');
  assert.ok(!anonView.stops.some((s) => s.id === 'S7'), 'S7（未公开章节）对匿名不可见');
  assert.equal(anonView.visibleStopCount, anonView.stops.length, '计数与可见集合一致');
  assert.ok(!JSON.stringify(anonView).includes('巷弄记忆'), '未公开章节标题不泄漏');

  cache.invalidatePrefix('route:slug:old-town-deep');
  const editorView = await services.getRouteDetail(store, cache, 'old-town-deep', editor);
  assert.ok(editorView.stops.some((s) => s.id === 'S7'), '编辑可见未公开章节的停留点');
});

test('街区详情：匿名不返回 draft 章节与其停留点', async () => {
  const { store, cache } = ctx();
  const detail = await services.getDistrictDetail(store, cache, 'old-town', anon);
  const json = JSON.stringify(detail);
  assert.ok(!json.includes('巷弄记忆'), 'draft 章节不出现在匿名街区详情');
  assert.ok(!json.includes('S7'), 'draft 章节的停留点不出现');

  const editorDetail = await services.getDistrictDetail(store, cache, 'old-town', editor);
  assert.ok(JSON.stringify(editorDetail).includes('巷弄记忆'), '编辑可见 draft 章节');
});

// ---------- 7. 边界修改 → 复核 ----------
test('街区边界修改后：关联进入复核队列并标记 needs_review，复核后解除', async () => {
  const { store, cache } = ctx();
  const d1 = await store.getDistrict('D1');
  const { district, reviews } = await services.updateDistrictBoundary(store, cache, {
    id: 'D1', boundary: [[116.39, 39.9], [116.4, 39.91]], baseVersion: d1.version, actor: editor,
  });
  assert.equal(district.boundaryVersion, 2);
  assert.ok(reviews.length >= 2, 'D1 被 R1/R3 关联 → 生成复核任务');

  const links = await store.listRouteDistrictsByDistrict('D1');
  assert.ok(links.every((l) => l.needsReview === true), '关联标记 needs_review，不按旧中心点继承');

  // 复核确认
  const done = await services.resolveReview(store, cache, { reviewId: reviews[0].id, action: 'confirmed', actor: editor });
  assert.equal(done.status, 'confirmed');
  const linkAfter = (await store.listRouteDistrictsByDistrict('D1')).find((l) => l.routeId === reviews[0].routeId);
  assert.equal(linkAfter.needsReview, false);

  // 复核移除
  const removed = await services.resolveReview(store, cache, { reviewId: reviews[1].id, action: 'removed', actor: editor });
  assert.equal(removed.status, 'removed');
  const stillThere = (await store.listRouteDistrictsByDistrict('D1')).find((l) => l.routeId === reviews[1].routeId);
  assert.equal(stillThere, undefined, '移除后关联不存在');

  // 重复处理同一复核任务 → 409
  await assert.rejects(
    services.resolveReview(store, cache, { reviewId: reviews[0].id, action: 'confirmed', actor: editor }),
    ConflictError
  );

  // 边界修改的乐观锁
  await assert.rejects(
    services.updateDistrictBoundary(store, cache, { id: 'D1', boundary: [], baseVersion: 1, actor: editor }),
    VersionConflictError
  );
});

// ---------- 8. 别名 / 迁移 / 撤回替代 ----------
test('别名与迁移关系：旧标识可解析，撤回路线返回替代指向', async () => {
  const { store, cache } = ctx();
  // 别名解析
  const viaAlias = await services.resolveChapter(store, 'old-city-wall', anon);
  assert.equal(viaAlias.chapter.id, 'C1');

  // 迁移关系（C0 已合并入 C1）
  const viaMigration = await services.resolveChapter(store, 'C0', anon);
  assert.equal(viaMigration.redirected, true);
  assert.equal(viaMigration.chapter.id, 'C1');

  // 不存在 → 404
  await assert.rejects(services.resolveChapter(store, 'no-such', anon), NotFoundError);

  // 撤回路线 → 410 + 替代指向
  await assert.rejects(
    services.getRouteDetail(store, cache, 'old-town-deep', anon),
    (e) => e instanceof GoneError && e.details.fallbackRouteId === 'R1'
  );

  // 撤回操作落实替代指向到关联行
  await services.withdrawRoute(store, cache, { routeId: 'R2', fallbackRouteId: 'R1', actor: editor });
  const links = await store.listRouteDistricts('R2');
  assert.equal(links[0].fallbackRouteId, 'R1', '关联行记录替代指向');
});

// ---------- 9. HTTP 端到端：权限与错误码 ----------
test('HTTP 端到端：匿名/编辑视角、404/410/409 错误码', async () => {
  const { store, cache } = ctx();
  const server = createServer({ store, cache });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  try {
    // 匿名街区列表：不含 draft 计数泄漏
    const list = await (await fetch(`${base}/api/districts`)).json();
    const d1 = list.items.find((d) => d.id === 'D1');
    assert.equal(d1.chapterCount, 2, 'D1 对匿名只计 2 个公开章节（C1、C1A）');

    // 匿名访问 draft 章节 → 404（不泄漏存在性）
    const res404 = await fetch(`${base}/api/chapters/C2`);
    assert.equal(res404.status, 404);

    // 编辑访问 → 200
    const resDraft = await fetch(`${base}/api/chapters/C2`, { headers: { 'X-Role': 'editor' } });
    assert.equal(resDraft.status, 200);

    // 撤回路线 → 410 + 替代指向
    const res410 = await fetch(`${base}/api/routes/old-town-deep`);
    assert.equal(res410.status, 410);
    const body410 = await res410.json();
    assert.equal(body410.error.details.fallbackRouteId, 'R1');

    // 无权限的编辑操作 → 400
    const resNoAuth = await fetch(`${base}/api/chapters/C1A/move`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newParentId: null, baseVersion: 1 }),
    });
    assert.equal(resNoAuth.status, 400);

    // 并发移动端到端：两个请求，一个 200 一个 409
    const ver = (await store.getChapter('C1A')).version;
    const [r1, r2] = await Promise.all([
      fetch(`${base}/api/chapters/C1A/move`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Role': 'editor' }, body: JSON.stringify({ newParentId: null, baseVersion: ver }) }),
      fetch(`${base}/api/chapters/C1A/move`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Role': 'editor', 'X-Actor-Id': 'editor-b' }, body: JSON.stringify({ newParentId: 'C1', baseVersion: ver }) }),
    ]);
    const statuses = [r1.status, r2.status].sort();
    assert.deepEqual(statuses, [200, 409]);
  } finally {
    server.close();
  }
});
