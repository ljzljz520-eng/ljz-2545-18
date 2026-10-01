'use strict';

// 内存仓库：集合与 server/db/migrations 中的 PG 表一一对应。
// 服务层逻辑基于本接口编写，接 PG 时换成等价 SQL（同一事务内完成）。
// 注意：自增 id 必须是“实例级”，多个 Store（多测试/多租户场景）绝不能共享序列，
// 否则旧实例数据会按 id 串到新实例——与“缓存回包乱序”同类的状态污染。

class Store {
  constructor() {
    this._nextId = 1;
    this.chapters = new Map();      // id -> chapter
    this.revisions = [];
    this.aliases = [];             // { id, chapterId, aliasSlug }
    this.chapterMigrations = [];  // { id, kind, fromChapterId, toChapterId, reason }
    this.neighborhoods = new Map();
    this.stops = [];
    this.routes = new Map();
    this.routeNeighborhoods = []; // { id, routeId, neighborhoodId, role, state, pendingNeighborhoodId, sortOrder }
    this.boundaryReviews = [];
    this.routeMigrations = [];
  }

  id() { return this._nextId++; }

  // ---- 章节 ---------------------------------------------------------------
  addChapter(data) {
    const ch = {
      id: this.id(),
      kind: data.kind || 'section',
      slug: data.slug,
      parentId: data.parentId ?? null,
      title: data.title,
      status: 'draft',
      summary: data.summary || null,
      historyBody: data.historyBody || null,
      treeVersion: 1,
      currentRevisionId: null,
      createdBy: data.createdBy ?? null,
    };
    this.chapters.set(ch.id, ch);
    return ch;
  }

  getChapter(id) { return this.chapters.get(id) || null; }
  findChapterBySlug(slug, parentId = null) {
    for (const c of this.chapters.values()) {
      if (c.slug === slug && (c.parentId ?? null) === (parentId ?? null)) return c;
    }
    return null;
  }
  childrenOf(id) {
    return [...this.chapters.values()].filter((c) => c.parentId === id);
  }

  // ---- 发布版本 -----------------------------------------------------------
  addRevision(rec) {
    const row = { id: this.id(), ...rec };
    this.revisions.push(row);
    return row;
  }
  revisionsOf(chapterId) {
    return this.revisions
      .filter((r) => r.chapterId === chapterId)
      .sort((a, b) => a.revisionNo - b.revisionNo);
  }

  // ---- 别名 / 迁移 --------------------------------------------------------
  addAlias(chapterId, aliasSlug) {
    const row = { id: this.id(), chapterId, aliasSlug };
    this.aliases.push(row);
    return row;
  }
  findAlias(slug) { return this.aliases.find((a) => a.aliasSlug === slug) || null; }

  addChapterMigration(rec) {
    const row = { id: this.id(), ...rec };
    this.chapterMigrations.push(row);
    return row;
  }

  // ---- 街区 / 停留点 ------------------------------------------------------
  addNeighborhood(data) {
    const n = {
      id: this.id(),
      chapterId: data.chapterId,
      boundary: data.boundary || null,
      centerLng: data.centerLng ?? null,
      centerLat: data.centerLat ?? null,
      boundaryVersion: 1,
    };
    this.neighborhoods.set(n.id, n);
    return n;
  }
  getNeighborhood(id) { return this.neighborhoods.get(id) || null; }
  neighborhoodByChapter(chapterId) {
    for (const n of this.neighborhoods.values()) if (n.chapterId === chapterId) return n;
    return null;
  }

  addStop(data) {
    const s = {
      id: this.id(),
      neighborhoodId: data.neighborhoodId,
      slug: data.slug,
      title: data.title,
      description: data.description || '',
      lng: data.lng ?? null,
      lat: data.lat ?? null,
      sortOrder: data.sortOrder ?? 0,
      status: data.status || 'draft',
    };
    this.stops.push(s);
    return s;
  }
  stopsOf(neighborhoodId) {
    return this.stops
      .filter((s) => s.neighborhoodId === neighborhoodId)
      .sort((a, b) => a.sortOrder - b.sortOrder);
  }

  // ---- 路线 ---------------------------------------------------------------
  addRoute(data) {
    const r = {
      id: this.id(),
      slug: data.slug,
      title: data.title,
      status: data.status || 'draft',
      fallbackRouteId: null,
      fallbackChapterId: null,
      withdrawnAt: null,
      createdBy: data.createdBy ?? null,
    };
    this.routes.set(r.id, r);
    return r;
  }
  getRoute(id) { return this.routes.get(id) || null; }
  findRouteBySlug(slug) {
    for (const r of this.routes.values()) if (r.slug === slug) return r;
    return null;
  }

  addRouteNeighborhood(data) {
    const row = {
      id: this.id(),
      routeId: data.routeId,
      neighborhoodId: data.neighborhoodId,
      role: data.role || 'secondary',
      state: data.state || 'active',
      pendingNeighborhoodId: data.pendingNeighborhoodId ?? null,
      sortOrder: data.sortOrder ?? 0,
    };
    this.routeNeighborhoods.push(row);
    return row;
  }
  associationsOf(routeId) {
    return this.routeNeighborhoods.filter((rn) => rn.routeId === routeId);
  }
  associationsForNeighborhood(neighborhoodId) {
    return this.routeNeighborhoods.filter((rn) => rn.neighborhoodId === neighborhoodId);
  }
  getAssociation(id) { return this.routeNeighborhoods.find((rn) => rn.id === id) || null; }

  addBoundaryReview(data) {
    const row = {
      id: this.id(),
      neighborhoodId: data.neighborhoodId,
      routeId: data.routeId,
      associationId: data.associationId,
      oldBoundary: data.oldBoundary || null,
      newBoundary: data.newBoundary || null,
      decision: null,
      decidedBy: null,
      decidedAt: null,
    };
    this.boundaryReviews.push(row);
    return row;
  }

  addRouteMigration(rec) {
    const row = { id: this.id(), kind: 'split', ...rec };
    this.routeMigrations.push(row);
    return row;
  }

  reset() {
    this.chapters.clear();
    this.revisions.length = 0;
    this.aliases.length = 0;
    this.chapterMigrations.length = 0;
    this.neighborhoods.clear();
    this.stops.length = 0;
    this.routes.clear();
    this.routeNeighborhoods.length = 0;
    this.boundaryReviews.length = 0;
    this.routeMigrations.length = 0;
    this._nextId = 1;
  }
}

module.exports = { Store };
