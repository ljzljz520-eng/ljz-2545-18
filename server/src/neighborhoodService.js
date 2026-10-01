'use strict';

const { errors } = require('./errors');
const { canEditChapter, canViewChapter, canPublish } = require('./permissions');

// 街区服务：街区边界修改后，既有路线关联进入“待复核”，
// 绝不按旧中心点永久继承；删除在仍有引用时被阻止。
class NeighborhoodService {
  constructor(store) {
    this.store = store;
  }

  register(user, { chapterId, boundary, centerLng, centerLat }) {
    const ch = this.store.getChapter(chapterId);
    if (!ch) throw errors.notFound('章节不存在', { chapterId });
    if (ch.kind !== 'neighborhood') {
      throw errors.invalid('只有街区类型章节可注册街区资料', { chapterId });
    }
    if (!canEditChapter(user, ch)) throw errors.forbidden('无权注册该街区');
    if (this.store.neighborhoodByChapter(chapterId)) {
      throw errors.conflict('该章节已注册街区', { chapterId });
    }
    return this.store.addNeighborhood({ chapterId, boundary, centerLng, centerLat });
  }

  // 街区页数据：历史背景 + 停留点 + 路线入口（按权限过滤未公开内容）
  page(user, neighborhoodId) {
    const n = this.store.getNeighborhood(neighborhoodId);
    if (!n) throw errors.notFound('街区不存在', { neighborhoodId });
    const ch = this.store.getChapter(n.chapterId);
    if (!ch || !canViewChapter(user, ch)) {
      throw errors.notFound('街区不存在或未公开', { neighborhoodId });
    }
    const stops = this.store.stopsOf(neighborhoodId)
      .filter((s) => s.status === 'published' || (user && user.role === 'admin'))
      .map((s) => ({ id: s.id, slug: s.slug, title: s.title, description: s.description }));

    const routeEntries = this.store.associationsForNeighborhood(neighborhoodId)
      .map((rn) => {
        const route = this.store.getRoute(rn.routeId);
        return { rn, route };
      })
      .filter(({ rn, route }) => {
        if (!route || route.status !== 'published') return false;
        if (rn.state !== 'active') return false;
        // 关联对端街区也必须可见，防止未公开章节经路线关联接口泄漏
        const otherN = this.store.getNeighborhood(rn.neighborhoodId);
        const otherCh = otherN && this.store.getChapter(otherN.chapterId);
        return otherCh && canViewChapter(user, otherCh);
      })
      .map(({ rn, route }) => ({
        routeId: route.id,
        routeSlug: route.slug,
        title: route.title,
        role: rn.role,
        state: rn.state,
      }));

    return {
      neighborhood: {
        id: n.id,
        boundaryVersion: n.boundaryVersion,
        center: n.centerLng == null ? null : { lng: n.centerLng, lat: n.centerLat },
      },
      chapter: {
        id: ch.id, slug: ch.slug, title: ch.title,
        summary: ch.summary, historyBody: ch.historyBody, status: ch.status,
      },
      stops,
      routeEntries,
    };
  }

  addStop(user, neighborhoodId, data) {
    const n = this.store.getNeighborhood(neighborhoodId);
    if (!n) throw errors.notFound('街区不存在', { neighborhoodId });
    const ch = this.store.getChapter(n.chapterId);
    if (!canEditChapter(user, ch)) throw errors.forbidden('无权在该街区添加停留点');
    return this.store.addStop({ ...data, neighborhoodId });
  }

  // 边界变更：登记复核 + 关联置 review_pending。旧中心点不再自动决定归属。
  changeBoundary(user, neighborhoodId, newBoundary) {
    const n = this.store.getNeighborhood(neighborhoodId);
    if (!n) throw errors.notFound('街区不存在', { neighborhoodId });
    const ch = this.store.getChapter(n.chapterId);
    if (!canEditChapter(user, ch)) throw errors.forbidden('无权修改该街区边界');

    const oldBoundary = n.boundary;
    n.boundary = newBoundary;
    n.boundaryVersion += 1;

    const affected = this.store.associationsForNeighborhood(neighborhoodId)
      .filter((rn) => rn.state === 'active');

    for (const rn of affected) {
      rn.state = 'review_pending';
      this.store.addBoundaryReview({
        neighborhoodId,
        routeId: rn.routeId,
        associationId: rn.id,
        oldBoundary,
        newBoundary,
      });
    }
    return { neighborhood: n, reviewCount: affected.length };
  }

  // 复核结论：keep 恢复关联；reattach 改派到候选街区；detach 永久解除
  resolveReview(user, reviewId, decision, candidateNeighborhoodId = null) {
    const review = this.store.boundaryReviews.find((r) => r.id === reviewId);
    if (!review) throw errors.notFound('复核任务不存在', { reviewId });
    if (!canPublish(user)) throw errors.forbidden('仅管理员可作出复核结论');
    const rn = this.store.getAssociation(review.associationId);
    if (!rn) throw errors.notFound('关联已不存在', { associationId: review.associationId });

    if (decision === 'keep') {
      rn.state = 'active';
      rn.pendingNeighborhoodId = null;
    } else if (decision === 'detach') {
      rn.state = 'detached';
      rn.pendingNeighborhoodId = null;
    } else if (decision === 'reattach') {
      const target = this.store.getNeighborhood(candidateNeighborhoodId);
      if (!target) throw errors.notFound('候选街区不存在', { candidateNeighborhoodId });
      const dup = this.store.associationsOf(rn.routeId)
        .find((x) => x.neighborhoodId === target.id && x.state !== 'detached');
      if (dup) throw errors.conflict('该路线已关联目标街区', { neighborhoodId: target.id });
      rn.neighborhoodId = target.id;
      rn.state = 'active';
      rn.pendingNeighborhoodId = null;
    } else {
      throw errors.invalid('未知复核结论', { decision });
    }

    review.decision = decision;
    review.decidedBy = user.id;
    review.decidedAt = new Date().toISOString();
    return { review, association: rn };
  }

  // 删除仍被引用的街区：阻止；先 detach / 改派后才可删
  delete(user, neighborhoodId) {
    const n = this.store.getNeighborhood(neighborhoodId);
    if (!n) throw errors.notFound('街区不存在', { neighborhoodId });
    const ch = this.store.getChapter(n.chapterId);
    if (!canPublish(user)) throw errors.forbidden('仅管理员可删除街区');

    const referenced = this.store.routeNeighborhoods
      .filter((rn) => rn.neighborhoodId === neighborhoodId && rn.state !== 'detached');
    if (referenced.length > 0) {
      throw errors.referenced('街区仍被路线引用，不能删除', {
        neighborhoodId,
        routeIds: referenced.map((rn) => rn.routeId),
      });
    }
    const stops = this.store.stopsOf(neighborhoodId);
    if (stops.length > 0) {
      throw errors.referenced('街区下仍有停留点，不能删除', {
        neighborhoodId,
        stopIds: stops.map((s) => s.id),
      });
    }
    this.store.neighborhoods.delete(neighborhoodId);
    return { deleted: true, neighborhoodId };
  }
}

module.exports = { NeighborhoodService };
