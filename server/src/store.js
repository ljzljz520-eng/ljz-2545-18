'use strict';

/**
 * 数据访问层（内存实现）。
 * 与 pg-store.js 实现同一组方法签名；服务层只依赖该接口。
 * 方法全部返回 Promise，便于无缝切换 PG 实现。
 */

function clone(v) {
  return v === undefined ? v : JSON.parse(JSON.stringify(v));
}

class MemoryStore {
  constructor() {
    this.districts = new Map();
    this.chapters = new Map();
    this.chapterPublications = [];
    this.chapterAliases = new Map();   // alias -> chapterId
    this.chapterMigrations = [];
    this.stops = new Map();
    this.routes = new Map();
    this.routeStops = [];              // {routeId, stopId, seq}
    this.routeDistricts = [];          // {routeId, districtId, role, entryNote, fallbackRouteId, needsReview}
    this.reviews = [];                 // 复核队列
    this.routeMigrations = [];
    this._reviewSeq = 0;
    this._pubSeq = 0;
    this._migSeq = 0;
  }

  // ---------- 街区 ----------
  async listDistricts() {
    return clone([...this.districts.values()]);
  }
  async getDistrict(id) {
    return clone(this.districts.get(id)) || null;
  }
  async getDistrictBySlug(slug) {
    return clone([...this.districts.values()].find((d) => d.slug === slug)) || null;
  }
  async updateDistrict(id, patch, baseVersion) {
    const d = this.districts.get(id);
    if (!d) return null;
    if (baseVersion !== undefined && d.version !== baseVersion) return false; // 乐观锁失败
    Object.assign(d, clone(patch));
    d.updatedAt = new Date().toISOString();
    return clone(d);
  }
  async deleteDistrict(id) {
    return this.districts.delete(id);
  }

  // ---------- 章节 ----------
  async getChapter(id) {
    return clone(this.chapters.get(id)) || null;
  }
  async getChapterBySlug(districtId, slug) {
    return clone(
      [...this.chapters.values()].find((c) => c.districtId === districtId && c.slug === slug)
    ) || null;
  }
  async findChapterBySlug(slug) {
    return clone([...this.chapters.values()].find((c) => c.slug === slug)) || null;
  }
  async listChaptersByDistrict(districtId) {
    return clone([...this.chapters.values()].filter((c) => c.districtId === districtId));
  }
  async listChildren(parentId) {
    return clone([...this.chapters.values()].filter((c) => c.parentId === parentId));
  }
  /** 乐观锁移动：baseVersion 不匹配返回 'VERSION_CONFLICT' */
  async moveChapter(id, newParentId, baseVersion) {
    const c = this.chapters.get(id);
    if (!c) return null;
    if (c.version !== baseVersion) return 'VERSION_CONFLICT';
    c.parentId = newParentId;
    c.version += 1;
    c.updatedAt = new Date().toISOString();
    return clone(c);
  }
  async updateChapter(id, patch, baseVersion) {
    const c = this.chapters.get(id);
    if (!c) return null;
    if (baseVersion !== undefined && c.version !== baseVersion) return 'VERSION_CONFLICT';
    Object.assign(c, clone(patch));
    c.version += 1;
    c.updatedAt = new Date().toISOString();
    return clone(c);
  }

  // ---------- 发布版 ----------
  async addPublication(chapterId, version, payload, publishedBy) {
    const pub = {
      id: ++this._pubSeq,
      chapterId,
      version,
      payload: clone(payload),
      publishedBy: publishedBy || 'system',
      publishedAt: new Date().toISOString(),
    };
    this.chapterPublications.push(pub);
    return clone(pub);
  }
  async listPublications(chapterId) {
    return clone(this.chapterPublications.filter((p) => p.chapterId === chapterId));
  }

  // ---------- 别名 ----------
  async addAlias(alias, chapterId) {
    this.chapterAliases.set(alias, chapterId);
  }
  async resolveAlias(alias) {
    const id = this.chapterAliases.get(alias);
    return id ? this.getChapter(id) : null;
  }

  // ---------- 章节迁移关系 ----------
  async addChapterMigration(fromId, toId, reason, note) {
    const m = { id: ++this._migSeq, fromChapterId: fromId, toChapterId: toId, reason, note: note || '', createdAt: new Date().toISOString() };
    this.chapterMigrations.push(m);
    return clone(m);
  }
  async findChapterMigration(fromId) {
    return clone(this.chapterMigrations.filter((m) => m.fromChapterId === fromId)) || [];
  }

  // ---------- 停留点 ----------
  async getStop(id) {
    return clone(this.stops.get(id)) || null;
  }
  async listStopsByChapter(chapterId) {
    return clone(
      [...this.stops.values()]
        .filter((s) => s.chapterId === chapterId)
        .sort((a, b) => a.sortOrder - b.sortOrder)
    );
  }

  // ---------- 路线 ----------
  async getRoute(id) {
    return clone(this.routes.get(id)) || null;
  }
  async getRouteBySlug(slug) {
    return clone([...this.routes.values()].find((r) => r.slug === slug)) || null;
  }
  async createRoute(data) {
    const r = {
      id: data.id,
      slug: data.slug,
      title: data.title,
      summary: data.summary || '',
      status: data.status || 'published',
      fallbackRouteId: data.fallbackRouteId || null,
      version: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.routes.set(r.id, r);
    return clone(r);
  }
  async updateRoute(id, patch, baseVersion) {
    const r = this.routes.get(id);
    if (!r) return null;
    if (baseVersion !== undefined && r.version !== baseVersion) return 'VERSION_CONFLICT';
    Object.assign(r, clone(patch));
    r.version += 1;
    r.updatedAt = new Date().toISOString();
    return clone(r);
  }

  // ---------- 路线-停留点 ----------
  async listRouteStops(routeId) {
    return clone(
      this.routeStops.filter((rs) => rs.routeId === routeId).sort((a, b) => a.seq - b.seq)
    );
  }
  async addRouteStop(routeId, stopId, seq) {
    this.routeStops.push({ routeId, stopId, seq });
  }
  async clearRouteStops(routeId) {
    this.routeStops = this.routeStops.filter((rs) => rs.routeId !== routeId);
  }

  // ---------- 路线 ↔ 街区 关联表 ----------
  async listRouteDistricts(routeId) {
    return clone(this.routeDistricts.filter((rd) => rd.routeId === routeId));
  }
  async listRouteDistrictsByDistrict(districtId) {
    return clone(this.routeDistricts.filter((rd) => rd.districtId === districtId));
  }
  async addRouteDistrict(routeId, districtId, role, entryNote, fallbackRouteId) {
    if (role === 'primary') {
      // 每条路线至多一个主要展示入口
      for (const rd of this.routeDistricts) {
        if (rd.routeId === routeId && rd.role === 'primary') rd.role = 'secondary';
      }
    }
    const existing = this.routeDistricts.find((rd) => rd.routeId === routeId && rd.districtId === districtId);
    if (existing) {
      existing.role = role;
      if (entryNote !== undefined) existing.entryNote = entryNote;
      return clone(existing);
    }
    const rd = {
      routeId, districtId, role: role || 'secondary',
      entryNote: entryNote || '', fallbackRouteId: fallbackRouteId || null,
      needsReview: false, createdAt: new Date().toISOString(),
    };
    this.routeDistricts.push(rd);
    return clone(rd);
  }
  async setRouteDistrictNeedsReview(routeId, districtId, needsReview) {
    const rd = this.routeDistricts.find((x) => x.routeId === routeId && x.districtId === districtId);
    if (rd) rd.needsReview = needsReview;
    return clone(rd) || null;
  }
  async removeRouteDistrict(routeId, districtId) {
    const before = this.routeDistricts.length;
    this.routeDistricts = this.routeDistricts.filter((x) => !(x.routeId === routeId && x.districtId === districtId));
    return this.routeDistricts.length < before;
  }
  async setRouteDistrictFallback(routeId, districtId, fallbackRouteId) {
    const rd = this.routeDistricts.find((x) => x.routeId === routeId && x.districtId === districtId);
    if (rd) rd.fallbackRouteId = fallbackRouteId;
    return clone(rd) || null;
  }

  // ---------- 复核队列 ----------
  async createReview(data) {
    const r = {
      id: ++this._reviewSeq,
      routeId: data.routeId,
      districtId: data.districtId,
      oldBoundaryVersion: data.oldBoundaryVersion,
      newBoundaryVersion: data.newBoundaryVersion,
      status: 'pending',
      decidedBy: null,
      decidedAt: null,
      createdAt: new Date().toISOString(),
    };
    this.reviews.push(r);
    return clone(r);
  }
  async getReview(id) {
    return clone(this.reviews.find((r) => r.id === id)) || null;
  }
  async listReviews(status) {
    return clone(this.reviews.filter((r) => !status || r.status === status));
  }
  async resolveReview(id, action, actor) {
    const r = this.reviews.find((x) => x.id === id);
    if (!r) return null;
    r.status = action; // confirmed | removed
    r.decidedBy = actor || 'system';
    r.decidedAt = new Date().toISOString();
    return clone(r);
  }

  // ---------- 路线迁移关系 ----------
  async addRouteMigration(fromRouteId, toRouteId, reason, note) {
    const m = { id: ++this._migSeq, fromRouteId, toRouteId, reason, note: note || '', createdAt: new Date().toISOString() };
    this.routeMigrations.push(m);
    return clone(m);
  }
  async findRouteMigrations(fromRouteId) {
    return clone(this.routeMigrations.filter((m) => m.fromRouteId === fromRouteId)) || [];
  }
}

/**
 * 种子数据：覆盖演示与验收场景
 *  - D1 老城区（含未公开章节 C2，用于"未公开不得泄漏"验收）
 *  - D2 滨河新区、D3 工业遗存
 *  - R1 跨区路线（D1 主入口 + D2 次入口）、R2 单区路线、R3 已撤回路线（替代指向 R1）
 */
function seed(store) {
  const now = new Date().toISOString();

  // 街区
  const districts = [
    { id: 'D1', slug: 'old-town', name: '老城区', theme: 'history', summary: '城墙根下的百年街巷，城市记忆的起点。', history: '老城区始建于明代，现存城墙遗址 2.3 公里。清末民初商铺林立，是城市商业文明的发源地。', status: 'published', boundaryVersion: 1, centerLng: 116.397, centerLat: 39.908 },
    { id: 'D2', slug: 'riverside', name: '滨河新区', theme: 'culture', summary: '码头文化与近代工业文明的交汇带。', history: '滨河新区依托漕运码头兴起，1920 年代建成近代第一批仓储建筑群。', status: 'published', boundaryVersion: 1, centerLng: 116.421, centerLat: 39.915 },
    { id: 'D3', slug: 'factory', name: '工业遗存区', theme: 'industry', summary: '老厂房变身文创园区，工业记忆活态传承。', history: '工业遗存区前身为 1958 年建成的国营机械厂，2009 年停产改造为文创园。', status: 'published', boundaryVersion: 1, centerLng: 116.388, centerLat: 39.929 },
    { id: 'D4', slug: 'back-street', name: '后街市集', theme: 'food', summary: '市井烟火气最浓的小吃街巷。', history: '后街市集形成于民国时期，以夜市小吃闻名。', status: 'published', boundaryVersion: 1, centerLng: 116.401, centerLat: 39.902 },
  ];
  for (const d of districts) store.districts.set(d.id, { ...d, version: 1, createdAt: now, updatedAt: now });

  // 章节（树）
  const chapters = [
    { id: 'C1', districtId: 'D1', parentId: null, slug: 'city-wall', title: '城墙根', summary: '明城墙遗址沿线的街巷故事。', historyBackground: '现存城墙建于明永乐年间，原为夯土包砖结构。', sortOrder: 1, status: 'published' },
    { id: 'C1A', districtId: 'D1', parentId: 'C1', slug: 'south-gate', title: '南门城楼', summary: '南门瓮城与城楼的前世今生。', historyBackground: '南门又称"正阳门"，1950 年代城楼修缮后保留至今。', sortOrder: 1, status: 'published' },
    { id: 'C2', districtId: 'D1', parentId: null, slug: 'alley-memory', title: '巷弄记忆', summary: '尚未整理完成的巷弄口述史。', historyBackground: '（编辑中）巷弄口述史采集中。', sortOrder: 2, status: 'draft' },
    { id: 'C3', districtId: 'D2', parentId: null, slug: 'dock-stories', title: '码头往事', summary: '漕运码头的兴衰与重生。', historyBackground: '码头始建于清光绪年间，曾是北方最大的内河码头之一。', sortOrder: 1, status: 'published' },
    { id: 'C4', districtId: 'D3', parentId: null, slug: 'factory-reborn', title: '厂房改造', summary: '从机械厂到文创园的蜕变。', historyBackground: '主厂房为 1958 年苏式风格建筑，钢屋架保存完好。', sortOrder: 1, status: 'published' },
    { id: 'C5', districtId: 'D4', parentId: null, slug: 'night-market', title: '夜市烟火', summary: '后街夜市的百年味道。', historyBackground: '后街夜市始于民国初年，鼎盛时摊位逾百。', sortOrder: 1, status: 'published' },
  ];
  for (const c of chapters) store.chapters.set(c.id, { ...c, version: 1, createdAt: now, updatedAt: now });

  // 发布版快照（PG 储存发布版）
  for (const c of chapters.filter((x) => x.status === 'published')) {
    store.chapterPublications.push({ id: ++store._pubSeq, chapterId: c.id, version: 1, payload: { title: c.title, summary: c.summary, historyBackground: c.historyBackground }, publishedBy: 'seed', publishedAt: now });
  }

  // 别名与迁移关系
  store.chapterAliases.set('old-city-wall', 'C1');        // 旧 slug 仍可解析
  store.chapterMigrations.push({ id: ++store._migSeq, fromChapterId: 'C0', toChapterId: 'C1', reason: 'merge', note: '旧章节"城墙旧事"已合并入"城墙根"', createdAt: now });

  // 停留点
  const stops = [
    { id: 'S1', chapterId: 'C1A', name: '南门城楼', description: '登城楼俯瞰老城中轴线。', lng: 116.3971, lat: 39.9075, sortOrder: 1 },
    { id: 'S2', chapterId: 'C1', name: '古井亭', description: '清代古井，至今仍有泉水渗出。', lng: 116.3965, lat: 39.9082, sortOrder: 2 },
    { id: 'S3', chapterId: 'C3', name: '老码头台阶', description: '青石台阶上留有百年纤绳磨痕。', lng: 116.4208, lat: 39.9151, sortOrder: 1 },
    { id: 'S4', chapterId: 'C3', name: '航标灯塔', description: '1932 年建成的内河航标塔。', lng: 116.4215, lat: 39.9158, sortOrder: 2 },
    { id: 'S5', chapterId: 'C4', name: '一号厂房', description: '苏式钢屋架厂房，现为展览空间。', lng: 116.3882, lat: 39.9287, sortOrder: 1 },
    { id: 'S6', chapterId: 'C5', name: '老字号牌坊', description: '后街入口的百年牌坊。', lng: 116.4008, lat: 39.9018, sortOrder: 1 },
    { id: 'S7', chapterId: 'C2', name: '未公开巷口', description: '（编辑中）尚未核实的巷弄点位。', lng: 116.396, lat: 39.909, sortOrder: 1 },
  ];
  for (const s of stops) store.stops.set(s.id, s);

  // 路线
  const routes = [
    { id: 'R1', slug: 'city-memory-loop', title: '城市记忆环线', summary: '从城墙根到滨河码头，串起六百年城市记忆。', status: 'published' },
    { id: 'R2', slug: 'industry-walk', title: '工业风漫步', summary: '半日走完工业遗存区的硬核浪漫。', status: 'published' },
    { id: 'R3', slug: 'old-town-deep', title: '旧城深度线', summary: '（已撤回）深入老城巷弄的一日路线。', status: 'withdrawn', fallbackRouteId: 'R1' },
  ];
  for (const r of routes) store.routes.set(r.id, { fallbackRouteId: null, ...r, version: 1, createdAt: now, updatedAt: now });

  // 路线-停留点
  store.routeStops.push(
    { routeId: 'R1', stopId: 'S1', seq: 1 },
    { routeId: 'R1', stopId: 'S2', seq: 2 },
    { routeId: 'R1', stopId: 'S3', seq: 3 },
    { routeId: 'R1', stopId: 'S4', seq: 4 },
    { routeId: 'R2', stopId: 'S5', seq: 1 },
    { routeId: 'R3', stopId: 'S1', seq: 1 },
    { routeId: 'R3', stopId: 'S7', seq: 2 } // 含未公开章节的停留点 —— 匿名访问不得泄漏
  );

  // 路线 ↔ 街区 关联（主/次入口）
  store.routeDistricts.push(
    { routeId: 'R1', districtId: 'D1', role: 'primary', entryNote: '南门城楼为环线起点', fallbackRouteId: null, needsReview: false, createdAt: now },
    { routeId: 'R1', districtId: 'D2', role: 'secondary', entryNote: '码头段可单独游览', fallbackRouteId: null, needsReview: false, createdAt: now },
    { routeId: 'R2', districtId: 'D3', role: 'primary', entryNote: '一号厂房集合出发', fallbackRouteId: null, needsReview: false, createdAt: now },
    { routeId: 'R3', districtId: 'D1', role: 'primary', entryNote: '已撤回，请改走城市记忆环线', fallbackRouteId: 'R1', needsReview: false, createdAt: now }
  );

  // 路线迁移演示数据：无（拆分会动态产生）
  return store;
}

module.exports = { MemoryStore, seed };
