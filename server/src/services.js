'use strict';

const {
  NotFoundError, ValidationError, ConflictError,
  VersionConflictError, GoneError,
} = require('./errors');

/**
 * 服务层：章节树 + 路线关联
 *
 * 设计约束落实：
 *  1. 路线 ↔ 街区为独立关联表（多对多）：路线可跨多个街区，不强制唯一父节点；
 *  2. 只有章节是树 —— 移动章节时检查层级循环；路线关联无父子概念，不做循环检查；
 *  3. 街区边界修改后，关联进入复核队列（needs_review），不按旧中心点永远继承；
 *  4. 关联行落实主要展示入口（primary）/ 次要入口（secondary）/ 撤回后的替代指向（fallback）；
 *  5. 未公开章节不得通过路线关联接口泄漏（匿名视角过滤 + 计数同步过滤）。
 */

// ---------- 权限视角 ----------
function visibleStatuses(actor) {
  return actor && actor.role === 'editor'
    ? ['draft', 'published', 'withdrawn']
    : ['published'];
}

function assertVisible(entity, actor, goneFactory) {
  const allowed = visibleStatuses(actor);
  if (!entity) throw new NotFoundError();
  if (allowed.includes(entity.status)) return;
  if ((entity.status === 'withdrawn' || entity.status === 'split') && goneFactory) {
    throw goneFactory(entity);
  }
  // draft 对匿名 = 不存在（不泄漏其存在性）
  throw new NotFoundError();
}

// ---------- 章节树 ----------
/** 循环检查：仅章节需要。目标父链上不得出现被移动章节自身。 */
async function assertNoChapterCycle(store, chapterId, newParentId) {
  let cur = newParentId;
  const guard = new Set();
  while (cur) {
    if (cur === chapterId) {
      throw new ValidationError('目标父节点是该章节自身或其后代，会形成层级循环', { chapterId, newParentId });
    }
    if (guard.has(cur)) break; // 数据异常自保，避免死循环
    guard.add(cur);
    const node = await store.getChapter(cur);
    if (!node) throw new NotFoundError('目标父章节不存在', { newParentId: cur });
    cur = node.parentId;
  }
}

/**
 * 移动章节（乐观锁）。
 * 两个编辑同时移动：先提交者成功；后提交者 baseVersion 失配，
 * 收到 409 VERSION_CONFLICT 与当前最新状态，由客户端提示合并。
 */
async function moveChapter(store, cache, { id, newParentId, baseVersion, actor }) {
  if (!actor || actor.role !== 'editor') throw new ValidationError('需要编辑权限');
  const chapter = await store.getChapter(id);
  if (!chapter) throw new NotFoundError('章节不存在', { id });

  if (newParentId !== null) {
    const parent = await store.getChapter(newParentId);
    if (!parent) throw new NotFoundError('目标父章节不存在', { newParentId });
    if (parent.districtId !== chapter.districtId) {
      throw new ValidationError('章节只能在同一街区内移动；跨街区请使用迁移关系', {
        chapterDistrict: chapter.districtId, parentDistrict: parent.districtId,
      });
    }
    await assertNoChapterCycle(store, id, newParentId);
  }

  const moved = await store.moveChapter(id, newParentId, baseVersion);
  if (moved === 'VERSION_CONFLICT') {
    const current = await store.getChapter(id);
    throw new VersionConflictError('章节已被他人修改，请刷新后重试', current);
  }
  cache.invalidatePrefix(`district:${chapter.districtId}`);
  cache.invalidate(`chapter:${id}`);
  return moved;
}

/** 面包屑：由后端按调用者权限生成 —— 页面面包屑与后端权限一致 */
async function getBreadcrumb(store, chapterId, actor) {
  const allowed = visibleStatuses(actor);
  const trail = [];
  let cur = await store.getChapter(chapterId);
  if (!cur) throw new NotFoundError('章节不存在', { id: chapterId });
  const guard = new Set();
  while (cur) {
    if (guard.has(cur.id)) break;
    guard.add(cur.id);
    if (allowed.includes(cur.status)) {
      trail.unshift({ id: cur.id, title: cur.title, slug: cur.slug, status: cur.status });
    }
    // 未公开祖先不出现在面包屑，但继续向上找可公开的祖先，保证有确定入口
    cur = cur.parentId ? await store.getChapter(cur.parentId) : null;
  }
  if (trail.length === 0) throw new NotFoundError('章节不存在', { id: chapterId });
  const origin = await store.getChapter(chapterId);
  const district = origin ? await store.getDistrict(origin.districtId) : null;
  return {
    district: district && allowed.includes(district.status)
      ? { id: district.id, slug: district.slug, name: district.name }
      : null,
    trail,
  };
}

/** 章节解析：支持 id / slug / 别名 / 迁移关系，深链接有确定入口 */
async function resolveChapter(store, idOrSlug, actor) {
  let chapter = await store.getChapter(idOrSlug);
  if (!chapter) chapter = await store.resolveAlias(idOrSlug);
  if (!chapter) chapter = await store.findChapterBySlug(idOrSlug);
  if (!chapter) {
    const migrations = await store.findChapterMigration(idOrSlug);
    if (migrations.length > 0) {
      const target = await store.getChapter(migrations[migrations.length - 1].toChapterId);
      if (target) return { redirected: true, from: idOrSlug, chapter: target };
    }
    throw new NotFoundError('章节不存在', { id: idOrSlug });
  }
  assertVisible(chapter, actor, (c) => new GoneError('章节已撤回', { chapterId: c.id }));
  return { redirected: false, chapter };
}

// ---------- 街区 ----------
async function getDistrictDetail(store, cache, slug, actor) {
  const cacheKey = `district:slug:${slug}:${actor && actor.role === 'editor' ? 'editor' : 'anon'}`;
  const hit = cache.get(cacheKey);
  if (hit) return { ...hit.value, cacheSeq: hit.seq };

  const district = await store.getDistrictBySlug(slug);
  assertVisible(district, actor, (d) => new GoneError('街区已撤回', { districtId: d.id }));

  const allowed = visibleStatuses(actor);
  const all = await store.listChaptersByDistrict(district.id);
  const chapters = all.filter((c) => allowed.includes(c.status));

  // 章节树（仅含可见章节；父不可见时提升为根展示，保证确定入口）
  const byParent = new Map();
  for (const c of chapters) {
    const key = c.parentId && chapters.some((p) => p.id === c.parentId) ? c.parentId : null;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(c);
  }
  const buildTree = (parentId) =>
    (byParent.get(parentId) || [])
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((c) => ({
        id: c.id, slug: c.slug, title: c.title, summary: c.summary,
        historyBackground: c.historyBackground, status: c.status, version: c.version,
        children: buildTree(c.id),
      }));

  // 停留点：仅可见章节下的停留点（未公开章节不泄漏）
  const stops = [];
  for (const c of chapters) {
    for (const s of await store.listStopsByChapter(c.id)) {
      stops.push({ ...s, chapterId: c.id, chapterTitle: c.title });
    }
  }

  // 路线入口：主要展示入口 / 次要入口；撤回路线的替代指向
  const links = await store.listRouteDistrictsByDistrict(district.id);
  const routeEntries = [];
  for (const link of links) {
    const route = await store.getRoute(link.routeId);
    if (!route) continue;
    if (!allowed.includes(route.status)) {
      // 已撤回路线：匿名可见"替代指向"，但正文不展开
      if (route.status === 'withdrawn' || route.status === 'split') {
        routeEntries.push({
          routeId: route.id, slug: route.slug, title: route.title,
          status: route.status, role: link.role,
          fallbackRouteId: link.fallbackRouteId || route.fallbackRouteId || null,
        });
      }
      continue;
    }
    routeEntries.push({
      routeId: route.id, slug: route.slug, title: route.title, summary: route.summary,
      status: route.status, role: link.role, entryNote: link.entryNote,
      needsReview: link.needsReview,
    });
  }

  const detail = {
    district,
    chapters: buildTree(null),
    stops,
    primaryEntries: routeEntries.filter((e) => e.role === 'primary'),
    secondaryEntries: routeEntries.filter((e) => e.role === 'secondary'),
  };
  cache.set(cacheKey, detail);
  return { ...detail, cacheSeq: cache.get(cacheKey).seq };
}

/** 修改街区边界：关联进入复核队列，而非按旧中心点永远继承 */
async function updateDistrictBoundary(store, cache, { id, boundary, center, baseVersion, actor }) {
  if (!actor || actor.role !== 'editor') throw new ValidationError('需要编辑权限');
  const district = await store.getDistrict(id);
  if (!district) throw new NotFoundError('街区不存在', { id });
  if (district.version !== baseVersion) {
    throw new VersionConflictError('街区已被他人修改，请刷新后重试', district);
  }
  const newBoundaryVersion = district.boundaryVersion + 1;
  const updated = await store.updateDistrict(id, {
    boundary, boundaryVersion: newBoundaryVersion,
    centerLng: center ? center.lng : district.centerLng,
    centerLat: center ? center.lat : district.centerLat,
    version: baseVersion + 1,
  }, baseVersion);
  if (updated === false) throw new VersionConflictError('街区已被他人修改，请刷新后重试', await store.getDistrict(id));

  // 对所有现存关联生成复核任务，并标记 needs_review
  const links = await store.listRouteDistrictsByDistrict(id);
  const reviews = [];
  for (const link of links) {
    reviews.push(await store.createReview({
      routeId: link.routeId, districtId: id,
      oldBoundaryVersion: district.boundaryVersion, newBoundaryVersion,
    }));
    await store.setRouteDistrictNeedsReview(link.routeId, id, true);
  }
  cache.invalidatePrefix(`district:${id}`);
  cache.invalidatePrefix(`district:slug:${district.slug}`);
  return { district: updated, reviews };
}

/** 复核结论：confirm 保留关联 / remove 解除关联 */
async function resolveReview(store, cache, { reviewId, action, actor }) {
  if (!actor || actor.role !== 'editor') throw new ValidationError('需要编辑权限');
  if (!['confirmed', 'removed'].includes(action)) throw new ValidationError('action 必须为 confirmed 或 removed');
  const review = await store.getReview(reviewId);
  if (!review) throw new NotFoundError('复核任务不存在', { reviewId });
  if (review.status !== 'pending') throw new ConflictError('复核任务已处理', { review });

  const resolved = await store.resolveReview(reviewId, action, actor.id || 'editor');
  if (action === 'confirmed') {
    await store.setRouteDistrictNeedsReview(review.routeId, review.districtId, false);
  } else {
    await store.removeRouteDistrict(review.routeId, review.districtId);
  }
  const district = await store.getDistrict(review.districtId);
  if (district) cache.invalidatePrefix(`district:slug:${district.slug}`);
  return resolved;
}

/** 删除街区：仍被路线引用时拒绝（409 + 引用清单），引导先撤回或解除关联 */
async function deleteDistrict(store, cache, { id, actor }) {
  if (!actor || actor.role !== 'editor') throw new ValidationError('需要编辑权限');
  const district = await store.getDistrict(id);
  if (!district) throw new NotFoundError('街区不存在', { id });
  const links = await store.listRouteDistrictsByDistrict(id);
  if (links.length > 0) {
    const references = [];
    for (const link of links) {
      const route = await store.getRoute(link.routeId);
      references.push({ routeId: link.routeId, routeTitle: route ? route.title : null, routeStatus: route ? route.status : null, role: link.role });
    }
    throw new ConflictError('街区仍被路线引用，无法删除。请先解除关联或撤回相关路线。', { references });
  }
  const chapters = await store.listChaptersByDistrict(id);
  if (chapters.length > 0) {
    throw new ConflictError('街区下仍存在章节，无法删除。请先迁移或删除章节。', {
      chapters: chapters.map((c) => ({ id: c.id, title: c.title })),
    });
  }
  await store.deleteDistrict(id);
  cache.invalidatePrefix(`district:slug:${district.slug}`);
  return { deleted: true, id };
}

// ---------- 路线 ----------
async function getRouteDetail(store, cache, slug, actor) {
  const cacheKey = `route:slug:${slug}:${actor && actor.role === 'editor' ? 'editor' : 'anon'}`;
  const hit = cache.get(cacheKey);
  if (hit) return { ...hit.value, cacheSeq: hit.seq };

  const route = await store.getRouteBySlug(slug);
  assertVisible(route, actor, (r) => new GoneError('路线已撤回或已拆分', {
    routeId: r.id, fallbackRouteId: r.fallbackRouteId || null,
  }));

  const allowed = visibleStatuses(actor);

  // 途经停留点：过滤未公开章节 —— 未公开章节不得通过路线关联接口泄漏
  const routeStops = await store.listRouteStops(route.id);
  const stops = [];
  for (const rs of routeStops) {
    const stop = await store.getStop(rs.stopId);
    if (!stop) continue;
    const chapter = await store.getChapter(stop.chapterId);
    if (!chapter || !allowed.includes(chapter.status)) continue; // 不泄漏
    stops.push({ seq: rs.seq, ...stop, chapterTitle: chapter.title, chapterStatus: chapter.status });
  }

  // 关联街区：主/次入口 + 复核标记；未公开街区同样过滤
  const links = await store.listRouteDistricts(route.id);
  const districts = [];
  for (const link of links) {
    const d = await store.getDistrict(link.districtId);
    if (!d || !allowed.includes(d.status)) continue;
    districts.push({
      id: d.id, slug: d.slug, name: d.name, role: link.role,
      entryNote: link.entryNote, needsReview: link.needsReview,
      fallbackRouteId: link.fallbackRouteId,
    });
  }

  const detail = {
    route,
    stops,
    districts,
    primaryDistrict: districts.find((d) => d.role === 'primary') || null,
    secondaryDistricts: districts.filter((d) => d.role === 'secondary'),
    // 计数基于过滤后的可见集合，避免通过计数泄漏未公开内容
    visibleStopCount: stops.length,
  };
  cache.set(cacheKey, detail);
  return { ...detail, cacheSeq: cache.get(cacheKey).seq };
}

/**
 * 跨区路线拆分：按街区把一条跨区路线拆成多条单区路线。
 *  - 途经停留点按所属章节的街区分组；
 *  - 每组生成新路线（关联对应街区为 primary）；
 *  - 原路线状态置为 split，替代指向主街区新路线；
 *  - 写入路线迁移关系，深链接可重定向。
 */
async function splitRoute(store, cache, { routeId, actor }) {
  if (!actor || actor.role !== 'editor') throw new ValidationError('需要编辑权限');
  const route = await store.getRoute(routeId);
  if (!route) throw new NotFoundError('路线不存在', { routeId });
  if (route.status !== 'published' && route.status !== 'draft') {
    throw new ConflictError('仅发布中或草稿路线可拆分', { status: route.status });
  }
  const links = await store.listRouteDistricts(routeId);
  if (links.length < 2) throw new ValidationError('单街区路线无需拆分', { districts: links.length });

  const routeStops = await store.listRouteStops(routeId);
  const groups = new Map(); // districtId -> stops[]
  for (const rs of routeStops) {
    const stop = await store.getStop(rs.stopId);
    if (!stop) continue;
    const chapter = await store.getChapter(stop.chapterId);
    if (!chapter) continue;
    if (!groups.has(chapter.districtId)) groups.set(chapter.districtId, []);
    groups.get(chapter.districtId).push({ ...rs, stop });
  }

  const primaryLink = links.find((l) => l.role === 'primary');
  const newRoutes = [];
  let seq = 0;
  for (const [districtId, items] of groups) {
    seq += 1;
    const district = await store.getDistrict(districtId);
    const created = await store.createRoute({
      id: `${routeId}-S${seq}`,
      slug: `${route.slug}--${district ? district.slug : districtId.toLowerCase()}`,
      title: `${route.title}·${district ? district.name : districtId}段`,
      summary: `由「${route.title}」拆分而来（${district ? district.name : districtId}段）。`,
      status: 'published',
    });
    await store.addRouteDistrict(created.id, districtId, 'primary', `拆分自 ${route.title}`);
    let stopSeq = 0;
    for (const item of items.sort((a, b) => a.seq - b.seq)) {
      stopSeq += 1;
      await store.addRouteStop(created.id, item.stopId, stopSeq);
    }
    await store.addRouteMigration(routeId, created.id, 'split', `跨区拆分：${district ? district.name : districtId}段`);
    newRoutes.push({ route: created, districtId, stopCount: items.length, wasPrimaryDistrict: primaryLink && primaryLink.districtId === districtId });
  }

  // 原路线：状态 split + 替代指向（主街区对应的新路线）
  const primaryNew = newRoutes.find((r) => r.wasPrimaryDistrict) || newRoutes[0];
  await store.updateRoute(routeId, { status: 'split', fallbackRouteId: primaryNew ? primaryNew.route.id : null });
  cache.invalidatePrefix(`route:slug:${route.slug}`);
  for (const link of links) {
    const d = await store.getDistrict(link.districtId);
    if (d) cache.invalidatePrefix(`district:slug:${d.slug}`);
  }
  return { original: { id: routeId, status: 'split', fallbackRouteId: primaryNew ? primaryNew.route.id : null }, newRoutes };
}

/** 撤回路线：落实替代指向（fallback），关联行同步记录 */
async function withdrawRoute(store, cache, { routeId, fallbackRouteId, actor }) {
  if (!actor || actor.role !== 'editor') throw new ValidationError('需要编辑权限');
  const route = await store.getRoute(routeId);
  if (!route) throw new NotFoundError('路线不存在', { routeId });
  if (fallbackRouteId) {
    const fb = await store.getRoute(fallbackRouteId);
    if (!fb) throw new NotFoundError('替代路线不存在', { fallbackRouteId });
    if (fb.id === route.id) throw new ValidationError('替代路线不能是自身');
  }
  await store.updateRoute(routeId, { status: 'withdrawn', fallbackRouteId: fallbackRouteId || null });
  const links = await store.listRouteDistricts(routeId);
  for (const link of links) {
    await store.setRouteDistrictFallback(routeId, link.districtId, fallbackRouteId || null);
  }
  await store.addRouteMigration(routeId, fallbackRouteId || routeId, 'withdraw', fallbackRouteId ? `撤回，替代指向 ${fallbackRouteId}` : '撤回，无替代');
  cache.invalidatePrefix(`route:slug:${route.slug}`);
  return { id: routeId, status: 'withdrawn', fallbackRouteId: fallbackRouteId || null };
}

module.exports = {
  visibleStatuses,
  moveChapter,
  getBreadcrumb,
  resolveChapter,
  getDistrictDetail,
  updateDistrictBoundary,
  resolveReview,
  deleteDistrict,
  getRouteDetail,
  splitRoute,
  withdrawRoute,
};
