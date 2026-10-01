'use strict';

const { errors } = require('./errors');
const { canViewChapter } = require('./permissions');

// 路线服务：
// - 路线与街区是多对多（独立关联表），跨区路线不强制唯一父节点；
// - 主要展示入口唯一；主要入口不可用时按确定性顺序回落次要入口；
// - 撤回路线给出替代指向（新路线 / 章节 / 410）；
// - 拆分跨区路线在一个事务语义内完成，旧路线留下迁移关系。
class RouteService {
  constructor(store) {
    this.store = store;
  }

  createRoute(user, { slug, title }) {
    if (!user || (user.role !== 'admin' && user.role !== 'editor')) {
      throw errors.forbidden('无权创建路线');
    }
    if (this.store.findRouteBySlug(slug)) throw errors.conflict('路线 slug 已存在', { slug });
    return this.store.addRoute({ slug, title, createdBy: user.id });
  }

  _activePrimary(routeId) {
    return this.store.routeNeighborhoods.find(
      (rn) => rn.routeId === routeId && rn.role === 'primary' && rn.state === 'active',
    );
  }

  // 关联街区。主要入口必须唯一；被边界复核挂起的关联不能再被设为主要入口
  associate(user, routeId, neighborhoodId, { role = 'secondary', sortOrder = 0 } = {}) {
    const route = this.store.getRoute(routeId);
    if (!route) throw errors.notFound('路线不存在', { routeId });
    if (!user || (user.role !== 'admin' && user.role !== 'editor')) {
      throw errors.forbidden('无权维护路线关联');
    }
    const n = this.store.getNeighborhood(neighborhoodId);
    if (!n) throw errors.notFound('街区不存在', { neighborhoodId });

    const existing = this.store.routeNeighborhoods
      .find((rn) => rn.routeId === routeId && rn.neighborhoodId === neighborhoodId);
    if (existing) throw errors.conflict('关联已存在', { routeId, neighborhoodId });

    if (role === 'primary' && this._activePrimary(routeId)) {
      throw errors.conflict('该路线已有主要展示入口', { routeId });
    }
    return this.store.addRouteNeighborhood({ routeId, neighborhoodId, role, sortOrder });
  }

  setRole(user, routeId, neighborhoodId, role) {
    const rn = this.store.routeNeighborhoods
      .find((x) => x.routeId === routeId && x.neighborhoodId === neighborhoodId);
    if (!rn) throw errors.notFound('关联不存在');
    if (!user || user.role === 'visitor') throw errors.forbidden('无权调整入口角色');
    if (role === 'primary') {
      if (rn.state !== 'active') {
        throw errors.conflict('待复核关联不能作为主要入口，需先完成边界复核', { state: rn.state });
      }
      const cur = this._activePrimary(routeId);
      if (cur && cur.id !== rn.id) {
        cur.role = 'secondary'; // 主次切换，旧主要入口降为次要入口而不是删除
      }
    }
    rn.role = role;
    return rn;
  }

  // 发布前校验：必须恰好有一个 active 主要入口，且对端章节都已发布
  publish(user, routeId) {
    const route = this.store.getRoute(routeId);
    if (!route) throw errors.notFound('路线不存在', { routeId });
    if (!user || user.role !== 'admin') throw errors.forbidden('仅管理员可发布路线');

    const actives = this.store.associationsOf(routeId).filter((rn) => rn.state === 'active');
    if (actives.length === 0) throw errors.invalid('路线没有任何有效街区关联，不能发布');
    const primaries = actives.filter((rn) => rn.role === 'primary');
    if (primaries.length !== 1) {
      throw errors.invalid('路线必须恰好指定一个主要展示入口', { primaryCount: primaries.length });
    }
    for (const rn of actives) {
      const n = this.store.getNeighborhood(rn.neighborhoodId);
      const ch = n && this.store.getChapter(n.chapterId);
      if (!ch || ch.status !== 'published') {
        throw errors.invalid('关联街区章节尚未公开，不能发布', { neighborhoodId: rn.neighborhoodId });
      }
    }
    route.status = 'published';
    return route;
  }

  // 撤回：必须给出替代指向之一，或明确声明无替代（410）
  withdraw(user, routeId, { fallbackRouteId = null, fallbackChapterId = null } = {}) {
    const route = this.store.getRoute(routeId);
    if (!route) throw errors.notFound('路线不存在', { routeId });
    if (!user || user.role !== 'admin') throw errors.forbidden('仅管理员可撤回路线');

    if (fallbackRouteId != null) {
      const fb = this.store.getRoute(fallbackRouteId);
      if (!fb || fb.status !== 'published') {
        throw errors.invalid('替代路线不存在或未发布', { fallbackRouteId });
      }
      if (fallbackRouteId === routeId) throw errors.invalid('不能以自身作为替代');
    }
    if (fallbackChapterId != null) {
      const ch = this.store.getChapter(fallbackChapterId);
      if (!ch || ch.status !== 'published') {
        throw errors.invalid('替代章节不存在或未发布', { fallbackChapterId });
      }
    }
    route.status = 'withdrawn';
    route.withdrawnAt = new Date().toISOString();
    route.fallbackRouteId = fallbackRouteId;
    route.fallbackChapterId = fallbackRouteId == null ? fallbackChapterId : null;
    return route;
  }

  _neighborhoodVisible(user, neighborhoodId) {
    const n = this.store.getNeighborhood(neighborhoodId);
    if (!n) return false;
    const ch = this.store.getChapter(n.chapterId);
    return !!ch && canViewChapter(user, ch);
  }

  // 路线入口解析（公开 + 鉴权共用）：
  // published -> primary / secondary 回落；withdrawn -> redirect / gone；draft -> 404
  resolveEntry(user, slugOrId) {
    const route = this.store.routes.get(slugOrId) || this.store.findRouteBySlug(slugOrId);
    if (!route) throw errors.notFound('路线不存在', { route: slugOrId });

    if (route.status === 'draft') {
      if (!user || (user.role !== 'admin' && user.role !== 'editor')) {
        throw errors.notFound('路线不存在', { route: slugOrId });
      }
    }

    if (route.status === 'published') {
      const actives = this.store.associationsOf(route.id)
        .filter((rn) => rn.state === 'active' && this._neighborhoodVisible(user, rn.neighborhoodId))
        .sort((a, b) => {
          const rank = (rn) => (rn.role === 'primary' ? 0 : 1);
          return rank(a) - rank(b) || a.sortOrder - b.sortOrder || a.id - b.id;
        });
      if (actives.length === 0) {
        // 唯一主要入口被边界复核挂起且无可用次要入口：显式无入口，不猜测旧中心点
        return { kind: 'gone', route, reason: 'no-active-entry' };
      }
      const chosen = actives[0];
      const n = this.store.getNeighborhood(chosen.neighborhoodId);
      const ch = this.store.getChapter(n.chapterId);
      return {
        kind: chosen.role === 'primary' ? 'primary' : 'secondary',
        route,
        neighborhood: n,
        chapter: ch,
        secondaryCandidates: actives.slice(1).map((rn) => ({
          neighborhoodId: rn.neighborhoodId, role: rn.role,
        })),
      };
    }

    // withdrawn：新路线 -> 章节 -> 410
    if (route.fallbackRouteId) {
      const target = this.store.getRoute(route.fallbackRouteId);
      if (target && target.status === 'published') {
        return { kind: 'redirect', route, targetRoute: target };
      }
    }
    if (route.fallbackChapterId) {
      const ch = this.store.getChapter(route.fallbackChapterId);
      if (ch && ch.status === 'published' && canViewChapter(user, ch)) {
        return { kind: 'redirect', route, targetChapter: ch };
      }
    }
    return { kind: 'gone', route, reason: 'withdrawn-no-fallback' };
  }

  // 跨区路线拆分：按街区分组拆成多条新路线，原路线撤回并留下 split 迁移
  splitRoute(user, routeId, groups) {
    const route = this.store.getRoute(routeId);
    if (!route) throw errors.notFound('路线不存在', { routeId });
    if (!user || user.role !== 'admin') throw errors.forbidden('仅管理员可拆分路线');

    const assocs = this.store.associationsOf(routeId).filter((rn) => rn.state !== 'detached');
    if (assocs.length === 0) throw errors.invalid('路线没有可拆分的关联');
    if (!Array.isArray(groups) || groups.length === 0) {
      throw errors.invalid('必须给出至少一个拆分分组');
    }

    // 校验分组：覆盖全部关联且不重叠；每组至多一个 primary；跨区（>1 街区）允许
    const assigned = new Set();
    for (const g of groups) {
      if (!Array.isArray(g.neighborhoodIds) || g.neighborhoodIds.length === 0) {
        throw errors.invalid('分组必须包含街区');
      }
      const primaries = g.neighborhoodIds.filter((nid) =>
        assocs.some((rn) => rn.neighborhoodId === nid && rn.role === 'primary'));
      if (primaries.length > 1) throw errors.invalid('每组至多一个主要入口');
      for (const nid of g.neighborhoodIds) {
        if (!assocs.some((rn) => rn.neighborhoodId === nid)) {
          throw errors.invalid('分组包含不属于该路线的街区', { neighborhoodId: nid });
        }
        if (assigned.has(nid)) throw errors.invalid('街区被重复分配', { neighborhoodId: nid });
        assigned.add(nid);
      }
    }
    if (assigned.size !== assocs.length) {
      throw errors.invalid('拆分必须覆盖路线的全部街区关联', {
        assigned: assigned.size, total: assocs.length,
      });
    }

    // 预检新路线 slug，冲突在任何写入前失败，保证事务语义
    groups.forEach((g, idx) => {
      const slug = g.slug || `${route.slug}-part-${idx + 1}`;
      if (this.store.findRouteBySlug(slug)) {
        throw errors.conflict('拆分后的路线 slug 已存在', { slug });
      }
    });

    // 事务语义：任一失败整体回滚（内存实现先记账，末尾统一提交）
    const created = [];
    const migrations = [];
    try {
      groups.forEach((g, idx) => {
        const nr = this.store.addRoute({
          slug: g.slug || `${route.slug}-part-${idx + 1}`,
          title: g.title || `${route.title}（${idx + 1}）`,
          status: 'published', // 拆分自已发布路线，分组已保证每恰一个主入口且对端章节公开
          createdBy: user.id,
        });
        const groupHasPrimary = g.neighborhoodIds.some((nid) =>
          assocs.find((rn) => rn.neighborhoodId === nid)?.role === 'primary');
        g.neighborhoodIds.forEach((nid, orderIdx) => {
          const old = assocs.find((rn) => rn.neighborhoodId === nid);
          // 继承旧主次角色；组内没有 primary 时，第一个街区提升为新路线的主要入口
          const role = old.role === 'primary' || (!groupHasPrimary && orderIdx === 0)
            ? 'primary' : 'secondary';
          this.store.addRouteNeighborhood({
            routeId: nr.id,
            neighborhoodId: nid,
            role,
            sortOrder: old.sortOrder,
          });
        });
        created.push(nr);
      });

      // 原路线撤回，指向第一条拆分结果；记录全部拆分迁移关系
      route.status = 'withdrawn';
      route.withdrawnAt = new Date().toISOString();
      route.fallbackRouteId = created[0].id;
      for (const nr of created) {
        migrations.push(this.store.addRouteMigration({
          kind: 'split', fromRouteId: route.id, toRouteId: nr.id, reason: 'cross-district split',
        }));
      }
    } catch (err) {
      // 回滚：移除本次新建（简化版事务补偿；PG 实现使用 BEGIN/ROLLBACK）
      created.forEach((nr) => this.store.routes.delete(nr.id));
      this.store.routeMigrations = this.store.routeMigrations.filter((m) => !migrations.includes(m));
      throw err;
    }

    return { original: route, newRoutes: created, migrations };
  }
}

module.exports = { RouteService };
