'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createServices } = require('../src');
const { DomainError } = require('../src/errors');

const admin = { id: 1, role: 'admin' };
const editorA = { id: 2, role: 'editor', chapterIds: [] };
const visitor = null;

// 构造标准跨区场景：街区 A/B 章节 + 停留点 + 一条跨区路线
function seedCrossDistrict(svc) {
  const root = svc.chapters.create(admin, { kind: 'section', slug: 'city', title: '城市志' });
  const chA = svc.chapters.create(admin, { kind: 'neighborhood', slug: 'old-town', title: '老城厢', parentId: root.id, historyBody: '明清街巷' });
  const chB = svc.chapters.create(admin, { kind: 'neighborhood', slug: 'riverside', title: '河滨码头', parentId: root.id });
  [root, chA, chB].forEach((c) => svc.chapters.publish(admin, c.id));

  const nA = svc.neighborhoods.register(admin, { chapterId: chA.id, boundary: { v: 1 }, centerLng: 121.4, centerLat: 31.2 });
  const nB = svc.neighborhoods.register(admin, { chapterId: chB.id, boundary: { v: 1 } });
  svc.neighborhoods.addStop(admin, nA.id, { slug: 'arch', title: '石库门', status: 'published', sortOrder: 1 });

  const route = svc.routes.createRoute(admin, { slug: 'heritage-walk', title: '遗产漫步' });
  svc.routes.associate(admin, route.id, nA.id, { role: 'primary', sortOrder: 0 });
  svc.routes.associate(admin, route.id, nB.id, { role: 'secondary', sortOrder: 1 });
  svc.routes.publish(admin, route.id);

  return { root, chA, chB, nA, nB, route };
}

test('验收1：两个编辑同时移动同一章节，后写者乐观锁冲突', () => {
  const svc = createServices();
  const { root, chA, chB } = seedCrossDistrict(svc);

  // 两位编辑都基于 treeVersion=1 打开了编辑器
  const seenVersion = chA.treeVersion;
  const moved = svc.chapters.move(admin, chA.id, chB.id, seenVersion);
  assert.equal(moved.treeVersion, 2);

  // 第二位编辑的提交带着旧版本号 -> 冲突，必须重读后重试
  assert.throws(
    () => svc.chapters.move(admin, chA.id, root.id, seenVersion),
    (e) => e instanceof DomainError && e.code === 'CONFLICT',
  );

  // 刷新后用新版本号即可成功
  const again = svc.chapters.move(admin, chA.id, root.id, 2);
  assert.equal(again.treeVersion, 3);
});

test('章节树自身检查层级循环：挂到自己的后代下被拒绝', () => {
  const svc = createServices();
  const { root, chA, chB } = seedCrossDistrict(svc);

  // root -> chB -> chA 之后，再想把 root 移到 chA 下，形成环
  svc.chapters.move(admin, chA.id, chB.id, chA.treeVersion);
  assert.throws(
    () => svc.chapters.move(admin, root.id, chA.id, root.treeVersion),
    (e) => e instanceof DomainError && e.code === 'CYCLE_DETECTED',
  );
  // 直接把自己作为父节点也拒绝
  assert.throws(
    () => svc.chapters.move(admin, chB.id, chB.id, chB.treeVersion),
    (e) => e instanceof DomainError && e.code === 'CYCLE_DETECTED',
  );
});

test('验收2：删除仍被路线引用的街区被阻止，解除引用后可删', () => {
  const svc = createServices();
  const { nA, nB, route } = seedCrossDistrict(svc);

  const err = (() => {
    try { svc.neighborhoods.delete(admin, nA.id); return null; }
    catch (e) { return e; }
  })();
  assert.ok(err instanceof DomainError && err.code === 'REFERENCED');
  assert.deepEqual(err.details.routeIds, [route.id]);

  // 次要街区也被引用，同样阻止
  assert.throws(() => svc.neighborhoods.delete(admin, nB.id),
    (e) => e.code === 'REFERENCED');

  // 拆分迁移使旧路线不再引用后，街区才可删除（先删停留点场景：nA 有停留点）
  svc.routes.splitRoute(admin, route.id, [
    { slug: 'walk-a', title: '城厢线', neighborhoodIds: [nA.id] },
    { slug: 'walk-b', title: '河滨线', neighborhoodIds: [nB.id] },
  ]);
  // 旧路线关联还在（仅撤回），仍阻止删除——需要显式 detach
  assert.throws(() => svc.neighborhoods.delete(admin, nB.id),
    (e) => e.code === 'REFERENCED');
  const assocsB = svc.store.associationsForNeighborhood(nB.id)
    .filter((rn) => rn.state !== 'detached');
  assocsB.forEach((rn) => { rn.state = 'detached'; });
  // nB 无停留点，解除关联后删除成功
  assert.deepEqual(svc.neighborhoods.delete(admin, nB.id), { deleted: true, neighborhoodId: nB.id });
});

test('验收3：跨区路线拆分——新路线各自有主要入口，旧路线撤回并给替代', () => {
  const svc = createServices();
  const { nA, nB, route } = seedCrossDistrict(svc);

  const result = svc.routes.splitRoute(admin, route.id, [
    { slug: 'walk-a', title: '城厢线', neighborhoodIds: [nA.id] },
    { slug: 'walk-b', title: '河滨线', neighborhoodIds: [nB.id] },
  ]);

  assert.equal(result.newRoutes.length, 2);
  for (const nr of result.newRoutes) {
    const primaries = svc.store.associationsOf(nr.id).filter((rn) => rn.role === 'primary');
    assert.equal(primaries.length, 1);
  }
  assert.equal(route.status, 'withdrawn');
  assert.equal(route.fallbackRouteId, result.newRoutes[0].id);

  // 深链接旧路线：公开解析得到 redirect -> 第一条拆分结果
  const entry = svc.routes.resolveEntry(visitor, 'heritage-walk');
  assert.equal(entry.kind, 'redirect');
  assert.equal(entry.targetRoute.slug, 'walk-a');

  // 拆分必须覆盖全部分组，遗漏被拒绝
  const svc2 = createServices();
  const s2 = seedCrossDistrict(svc2);
  assert.throws(
    () => svc2.routes.splitRoute(admin, s2.route.id, [
      { slug: 'only-a', title: '仅A', neighborhoodIds: [s2.nA.id] },
    ]),
    (e) => e instanceof DomainError && e.code === 'INVALID',
  );
});

test('验收4：缓存回包乱序——旧面包屑后到不得覆盖新树', () => {
  const svc = createServices();
  const { root, chA, chB } = seedCrossDistrict(svc);

  // 用户停留在 chA 页面时发起面包屑请求 #1；随后移动章节触发 #2
  const seq1 = svc.guard.begin(`breadcrumb:${chA.id}`);
  svc.chapters.move(admin, chA.id, chB.id, chA.treeVersion);
  svc.treeCache.bust();
  const seq2 = svc.guard.begin(`breadcrumb:${chA.id}`);

  // #2 先回（新结构 城市志/河滨码头/老城厢）
  const crumbs2 = svc.chapters.breadcrumb(visitor, chA.id).map((c) => c.slug);
  assert.deepEqual(crumbs2, ['city', 'riverside', 'old-town']);
  const apply2 = svc.guard.commit(`breadcrumb:${chA.id}`, seq2, crumbs2);
  assert.equal(apply2.stale, false);

  // #1 后到（旧结构），必须被判为过期并丢弃
  const staleCrumbs = ['city', 'old-town'];
  const apply1 = svc.guard.commit(`breadcrumb:${chA.id}`, seq1, staleCrumbs);
  assert.equal(apply1.stale, true);
  assert.equal(apply1.payload, null);

  // TreeCache 同样按版本号拒绝旧值
  svc.treeCache.set('tree', 2, { moved: true });
  const hit = svc.treeCache.get('tree', 3);
  assert.equal(hit.hit, false);
  assert.equal(hit.stale, true);

  // 移动不影响 root 序号隔离
  const rootSeq = svc.guard.begin(`breadcrumb:${root.id}`);
  assert.notEqual(rootSeq, seq2);
});

test('边界修改：关联进入待复核，主要入口回落到次要入口而不是按旧中心点继承', () => {
  const svc = createServices();
  const { root: seededRoot, nA, nB, route } = seedCrossDistrict(svc);

  const res = svc.neighborhoods.changeBoundary(admin, nA.id, { v: 2 });
  assert.equal(res.reviewCount, 1);

  // 主要入口处于 review_pending：公开入口确定性回落到次要入口 nB
  const entry = svc.routes.resolveEntry(visitor, route.slug);
  assert.equal(entry.kind, 'secondary');
  assert.equal(entry.neighborhood.id, nB.id);
  assert.equal(entry.chapter.status, 'published');

  // 待复核期间不能把它重新设为主要入口
  const pending = svc.store.associationsOf(route.id).find((rn) => rn.neighborhoodId === nA.id);
  assert.equal(pending.state, 'review_pending');
  assert.throws(
    () => svc.routes.setRole(admin, route.id, nA.id, 'primary'),
    (e) => e.code === 'CONFLICT',
  );

  // 人工复核 keep 后恢复主要入口
  const review = svc.store.boundaryReviews.find((r) => r.neighborhoodId === nA.id);
  svc.neighborhoods.resolveReview(admin, review.id, 'keep');
  const back = svc.routes.resolveEntry(visitor, route.slug);
  assert.equal(back.kind, 'primary');
  assert.equal(back.neighborhood.id, nA.id);

  // 改派到已有关联的街区被唯一性保护拒绝
  svc.neighborhoods.changeBoundary(admin, nA.id, { v: 3 });
  let review2 = svc.store.boundaryReviews.filter((r) => r.neighborhoodId === nA.id).at(-1);
  assert.throws(
    () => svc.neighborhoods.resolveReview(admin, review2.id, 'reattach', nB.id),
    (e) => e.code === 'CONFLICT',
  );

  // 改派到全新街区：关联的 neighborhoodId 真正改写，旧中心点不再被继承
  const chC = svc.chapters.create(admin, {
    kind: 'neighborhood', slug: 'new-bund', title: '新北岸', parentId: seededRoot.id,
  });
  const nC = svc.neighborhoods.register(admin, { chapterId: chC.id });
  review2 = svc.store.boundaryReviews.filter((r) => r.neighborhoodId === nA.id).at(-1);
  const decided = svc.neighborhoods.resolveReview(admin, review2.id, 'reattach', nC.id);
  assert.equal(decided.association.neighborhoodId, nC.id);
  assert.equal(decided.association.state, 'active');
});

test('面包屑与后端权限一致；未公开章节不得经路线关联接口泄漏', () => {
  const svc = createServices();
  const seeded = seedCrossDistrict(svc);

  // 新建一个草稿街区，关联到已发布路线的尝试在发布校验阶段失败
  const draftCh = svc.chapters.create(admin, {
    kind: 'neighborhood', slug: 'secret-yard', title: '未公开弄堂', parentId: seeded.root.id,
  });
  const nD = svc.neighborhoods.register(admin, { chapterId: draftCh.id });
  const draftRoute = svc.routes.createRoute(admin, { slug: 'secret-route', title: '内部踏勘' });
  svc.routes.associate(admin, draftRoute.id, nD.id, { role: 'primary' });

  // 访客视角：草稿路线解析为 404，草稿章节面包屑 404，街区页 404
  assert.throws(() => svc.routes.resolveEntry(visitor, 'secret-route'),
    (e) => e.code === 'NOT_FOUND');
  assert.throws(() => svc.chapters.breadcrumb(visitor, draftCh.id),
    (e) => e.code === 'NOT_FOUND');
  assert.throws(() => svc.neighborhoods.page(visitor, nD.id),
    (e) => e.code === 'NOT_FOUND');

  // 已发布街区页不出现草稿街区的路线关联（跨区关联中对端草稿被过滤）
  svc.routes.associate(admin, draftRoute.id, seeded.nA.id, { role: 'secondary' });
  const pageA = svc.neighborhoods.page(visitor, seeded.nA.id);
  assert.equal(pageA.routeEntries.some((e) => e.routeId === draftRoute.id), false);

  // 未发布路线即使包含已发布街区也不能发布（主要入口对端是草稿）
  assert.throws(() => svc.routes.publish(admin, draftRoute.id),
    (e) => e.code === 'INVALID');

  // 编辑（非负责人）同样不可见；面包屑结果只含可见层
  const outsider = { id: 9, role: 'editor', chapterIds: [] };
  assert.throws(() => svc.chapters.breadcrumb(outsider, draftCh.id),
    (e) => e.code === 'NOT_FOUND');
  const crumbs = svc.chapters.breadcrumb(admin, seeded.chA.id).map((c) => c.slug);
  assert.deepEqual(crumbs, ['city', 'old-town']);
});

test('撤回后的替代指向：路线 -> 新路线 / 章节 / 410', () => {
  const svc = createServices();
  const { chA, route } = seedCrossDistrict(svc);

  // 有替代章节 -> redirect 到章节
  svc.routes.withdraw(admin, route.id, { fallbackChapterId: chA.id });
  let entry = svc.routes.resolveEntry(visitor, route.slug);
  assert.equal(entry.kind, 'redirect');
  assert.equal(entry.targetChapter.id, chA.id);

  // 无替代 -> gone(410)
  const svc2 = createServices();
  const s2 = seedCrossDistrict(svc2);
  svc2.routes.withdraw(admin, s2.route.id, {});
  entry = svc2.routes.resolveEntry(visitor, s2.route.slug);
  assert.equal(entry.kind, 'gone');

  // 不能配置无效替代
  const svc3 = createServices();
  const s3 = seedCrossDistrict(svc3);
  assert.throws(
    () => svc3.routes.withdraw(admin, s3.route.id, { fallbackRouteId: s3.route.id }),
    (e) => e.code === 'INVALID',
  );
});

test('深链接：别名与迁移关系给出确定入口；无历史记录也可恢复来源章节', () => {
  const svc = createServices();
  const { chA, chB } = seedCrossDistrict(svc);

  svc.chapters.addAlias(admin, chA.id, 'laochengxiang');
  const viaAlias = svc.chapters.resolveRef(visitor, 'laochengxiang');
  assert.equal(viaAlias.kind, 'entry');
  assert.equal(viaAlias.chapter.id, chA.id);
  assert.ok(viaAlias.viaAlias);

  // 合并后旧名解析为 redirect
  svc.chapters.recordMerge(admin, chA.id, chB.id);
  const merged = svc.chapters.resolveRef(visitor, 'old-town');
  assert.equal(merged.kind, 'redirect');
  assert.equal(merged.target.id, chB.id);

  // 撤回章节命中 -> gone + 替代指向，不静默改派
  svc.chapters.withdraw(admin, chB.id);
  const gone = svc.chapters.resolveRef(visitor, 'riverside');
  assert.equal(gone.kind, 'gone');

  // 未知引用 -> 404
  assert.throws(() => svc.chapters.resolveRef(visitor, 'nope'),
    (e) => e.code === 'NOT_FOUND');
});

test('发布版本不可变：发布后改动草稿不影响已发布版本快照', () => {
  const svc = createServices();
  const { chA } = seedCrossDistrict(svc);
  const rev1 = svc.store.revisions.find((r) => r.chapterId === chA.id);
  assert.deepEqual(rev1.treePath.length > 0, true);
  assert.equal(rev1.title, '老城厢');

  chA.title = '老城厢历史风貌区';
  const rev2 = svc.chapters.publish(admin, chA.id);
  assert.equal(rev2.revisionNo, rev1.revisionNo + 1);
  assert.notEqual(rev2.id, rev1.id);
  assert.equal(rev1.title, '老城厢'); // 旧快照保持不变
});

test('单一街区外键方案被独立关联表取代：一条路线可跨多个街区', () => {
  const svc = createServices();
  const { root, nA, nB, route } = seedCrossDistrict(svc);
  const assocs = svc.store.associationsOf(route.id);
  assert.equal(assocs.length, 2);
  const roles = assocs.map((rn) => rn.role).sort();
  assert.deepEqual(roles, ['primary', 'secondary']);

  // 同一路线创建第二条“主要入口”关联被拒绝（DB 层还有部分唯一索引兜底）
  const chC = svc.chapters.create(admin, {
    kind: 'neighborhood', slug: 'north-gate', title: '北关', parentId: root.id,
  });
  svc.chapters.publish(admin, chC.id);
  const nC = svc.neighborhoods.register(admin, { chapterId: chC.id });
  assert.throws(
    () => svc.routes.associate(admin, route.id, nC.id, { role: 'primary' }),
    (e) => e instanceof DomainError && e.code === 'CONFLICT',
  );

  // 主次切换：旧 primary 被降为 secondary，始终保持唯一主入口
  const switched = svc.routes.setRole(admin, route.id, nB.id, 'primary');
  assert.equal(switched.role, 'primary');
  const primaries = svc.store.associationsOf(route.id)
    .filter((rn) => rn.state === 'active' && rn.role === 'primary');
  assert.equal(primaries.length, 1);
  assert.equal(primaries[0].neighborhoodId, nB.id);
});

test('深链接路径形式 city/old-town 与裸 slug 都可解析；深链接无历史记录有确定入口', () => {
  const svc = createServices();
  const { chA } = seedCrossDistrict(svc);
  const byPath = svc.chapters.resolveRef(visitor, 'city/old-town');
  assert.equal(byPath.kind, 'entry');
  assert.equal(byPath.chapter.id, chA.id);
  const bySlug = svc.chapters.resolveRef(visitor, 'old-town');
  assert.equal(bySlug.chapter.id, chA.id);
});
