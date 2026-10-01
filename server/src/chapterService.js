'use strict';

const { errors } = require('./errors');
const { canViewChapter, canEditChapter, canPublish } = require('./permissions');

// 章节树服务：层级循环只在章节自身检查；移动用乐观锁支持并发冲突检测。
class ChapterService {
  constructor(store) {
    this.store = store;
  }

  create(user, { kind, slug, title, parentId = null, summary, historyBody }) {
    if (parentId != null) {
      const parent = this.store.getChapter(parentId);
      if (!parent) throw errors.notFound('父章节不存在', { parentId });
      if (!canEditChapter(user, parent)) {
        throw errors.forbidden('无权在该章节下创建子章节');
      }
    } else if (!user || (user.role !== 'admin' && user.role !== 'editor')) {
      throw errors.forbidden('无权创建根章节');
    }
    if (this.store.findChapterBySlug(slug, parentId)) {
      throw errors.conflict('同级 slug 已存在', { slug, parentId });
    }
    return this.store.addChapter({ kind, slug, title, parentId, summary, historyBody, createdBy: user?.id });
  }

  // 沿 parent_id 向上检测目标父节点是否是自己的后代（循环只与章节树有关）
  assertNoCycle(chapterId, newParentId) {
    if (newParentId == null) return;
    if (newParentId === chapterId) {
      throw errors.cycle('章节不能成为自己的父节点', { chapterId, newParentId });
    }
    let cursor = this.store.getChapter(newParentId);
    const guard = new Set();
    while (cursor) {
      if (cursor.id === chapterId) {
        throw errors.cycle('移动章节会形成层级循环', { chapterId, newParentId });
      }
      if (guard.has(cursor.id)) {
        throw errors.cycle('现有章节树中已存在循环', { at: cursor.id });
      }
      guard.add(cursor.id);
      cursor = cursor.parentId == null ? null : this.store.getChapter(cursor.parentId);
    }
  }

  // 两个编辑同时移动：expectedVersion 与当前 treeVersion 不一致即冲突，要求重读重试
  move(user, chapterId, newParentId, expectedVersion) {
    const ch = this.store.getChapter(chapterId);
    if (!ch) throw errors.notFound('章节不存在', { chapterId });
    if (!canEditChapter(user, ch)) throw errors.forbidden('无权移动该章节');

    if (newParentId != null && !this.store.getChapter(newParentId)) {
      throw errors.notFound('目标父章节不存在', { newParentId });
    }
    if (expectedVersion != null && expectedVersion !== ch.treeVersion) {
      throw errors.conflict('章节树已被他人更新，请刷新后重试', {
        chapterId,
        currentVersion: ch.treeVersion,
        expectedVersion,
      });
    }
    if (ch.parentId === newParentId) return ch;

    this.assertNoCycle(chapterId, newParentId);

    const oldParentId = ch.parentId;
    ch.parentId = newParentId;
    ch.treeVersion += 1;
    this.store.addChapterMigration({
      kind: 'move',
      fromChapterId: chapterId,
      toChapterId: newParentId,
      reason: `parent ${oldParentId} -> ${newParentId}`,
    });
    return ch;
  }

  ancestors(chapterId) {
    const chain = [];
    const guard = new Set();
    let cursor = this.store.getChapter(chapterId);
    while (cursor) {
      chain.unshift(cursor);
      if (guard.has(cursor.id)) break;
      guard.add(cursor.id);
      cursor = cursor.parentId == null ? null : this.store.getChapter(cursor.parentId);
    }
    return chain;
  }

  // 面包屑：未公开章节按权限过滤，且不泄露“存在性”（整根链都不可见则返回 404）
  breadcrumb(user, chapterId) {
    const ch = this.store.getChapter(chapterId);
    if (!ch || !canViewChapter(user, ch)) {
      throw errors.notFound('章节不存在或未公开', { chapterId });
    }
    // 从最近一个可见祖先开始渲染，避免出现看不见的中间层
    const chain = this.ancestors(chapterId).filter((c) => canViewChapter(user, c));
    return chain.map((c) => ({ id: c.id, slug: c.slug, title: c.title, status: c.status }));
  }

  // 发布：生成不可变版本快照（树路径一并冻结）
  publish(user, chapterId) {
    if (!canPublish(user)) throw errors.forbidden('仅管理员可发布');
    const ch = this.store.getChapter(chapterId);
    if (!ch) throw errors.notFound('章节不存在', { chapterId });

    const last = this.store.revisionsOf(chapterId);
    const revisionNo = (last[last.length - 1]?.revisionNo || 0) + 1;
    const treePath = this.ancestors(chapterId).map((c) => c.id);

    const rev = this.store.addRevision({
      chapterId,
      revisionNo,
      title: ch.title,
      summary: ch.summary,
      historyBody: ch.historyBody,
      treePath,
      publishedBy: user.id,
    });
    ch.status = 'published';
    ch.currentRevisionId = rev.id;
    return rev;
  }

  withdraw(user, chapterId, fallbackChapterId = null) {
    if (!canPublish(user)) throw errors.forbidden('仅管理员可撤回');
    const ch = this.store.getChapter(chapterId);
    if (!ch) throw errors.notFound('章节不存在', { chapterId });
    if (fallbackChapterId != null) {
      const fb = this.store.getChapter(fallbackChapterId);
      if (!fb) throw errors.notFound('替代章节不存在', { fallbackChapterId });
      if (fb.status !== 'published') {
        throw errors.invalid('替代章节必须已发布', { fallbackChapterId });
      }
    }
    ch.status = 'withdrawn';
    return ch;
  }

  addAlias(user, chapterId, aliasSlug) {
    const ch = this.store.getChapter(chapterId);
    if (!ch) throw errors.notFound('章节不存在', { chapterId });
    if (!canEditChapter(user, ch)) throw errors.forbidden('无权为该章节添加别名');
    if (this.store.findAlias(aliasSlug)) {
      throw errors.conflict('别名已被占用', { aliasSlug });
    }
    return this.store.addAlias(chapterId, aliasSlug);
  }

  recordMerge(user, fromChapterId, toChapterId) {
    if (!canPublish(user)) throw errors.forbidden('仅管理员可记录合并');
    const from = this.store.getChapter(fromChapterId);
    const to = this.store.getChapter(toChapterId);
    if (!from || !to) throw errors.notFound('合并目标章节不存在');
    if (to.status !== 'published') throw errors.invalid('合并目标必须已发布');
    if (from.status === 'draft') {
      throw errors.invalid('草稿章节不能合并：直接删除即可，避免旧 slug 泄漏其存在');
    }
    const mig = this.store.addChapterMigration({
      kind: 'merge', fromChapterId, toChapterId, reason: 'manual merge',
    });
    from.status = 'withdrawn'; // 源章节撤回，但别名/旧链接经迁移关系仍有确定指向
    return mig;
  }

  // 深链接解析：别名 / slug -> 确定入口；命中合并/拆分迁移给 redirect；纯撤回给 410+替代
  // 深链接支持裸 slug（别名）与完整路径 slug（city/old-town）两种形式
  _findChapterByRef(ref) {
    if (ref.includes('/')) {
      const parts = ref.split('/').filter(Boolean);
      let parentId = null;
      let current = null;
      for (const part of parts) {
        current = this.store.findChapterBySlug(part, parentId);
        if (!current) return null;
        parentId = current.id;
      }
      return current;
    }
    // 裸 slug：全树唯一匹配；多个同名草稿/已发布并存时优先已发布
    const matches = [...this.store.chapters.values()].filter((c) => c.slug === ref);
    if (matches.length <= 1) return matches[0] || null;
    return matches.find((c) => c.status === 'published') || matches[0];
  }

  resolveRef(user, ref) {
    let ch = this._findChapterByRef(ref);
    let viaAlias = null;

    if (!ch) {
      const alias = this.store.findAlias(ref);
      if (alias) {
        ch = this.store.getChapter(alias.chapterId);
        viaAlias = alias;
      }
    }

    if (!ch) {
      // 章节已物理移除时，靠迁移关系给出确定重定向
      const mig = this._findStructuralMigration(ref, null);
      if (mig) return this._redirectOr404(user, ref, mig.toChapterId);
      throw errors.notFound('章节不存在', { ref });
    }

    if (!canViewChapter(user, ch)) {
      // 结构性合并/拆分迁移优先：旧链接需要确定指向，目标可见时给重定向
      const hiddenMig = this.store.chapterMigrations
        .filter((m) => m.kind !== 'move' && m.fromChapterId === ch.id
          && m.toChapterId && this._refMatchesChapter(ref, ch.id))
        .at(-1);
      if (hiddenMig) {
        const target = this.store.getChapter(hiddenMig.toChapterId);
        if (target && canViewChapter(user, target)) {
          return { kind: 'redirect', from: ref, target, viaAlias };
        }
      }
      // 撤回是公开的生命周期事实（旧链接持有人本来就知道它）：给 410 + 替代
      if (ch.status === 'withdrawn') {
        return { kind: 'gone', chapter: ch, viaAlias, fallback: null };
      }
      // 草稿及无权章节：一律 404，不暴露存在性
      throw errors.notFound('章节不存在', { ref });
    }

    // 章节仍在但已被合并/拆分：仅当本次引用的就是源章节的旧 slug/别名时
    // 才永久重定向到目标（301）。当前章节若是别的迁移的“目标”，不得自我重定向。
    const structural = this.store.chapterMigrations
      .filter((m) => m.kind !== 'move' && m.fromChapterId === ch.id && m.toChapterId)
      .at(-1);
    if (structural && this._refMatchesChapter(ref, ch.id)) {
      return this._redirectOr404(user, ref, structural.toChapterId);
    }

    if (ch.status === 'withdrawn') {
      // 单纯撤回：410，附替代指向（仅当引用确实是源章节自身的旧标识），不静默改派。
      // 注意：若本章节是别的迁移的“目标”，那条迁移不能当作本章节的替代。
      const mig = [...this.store.chapterMigrations]
        .reverse()
        .find((m) => m.kind !== 'move'
          && m.fromChapterId === ch.id
          && m.toChapterId
          && this._refMatchesChapter(ref, ch.id));
      const target = mig ? this.store.getChapter(mig.toChapterId) : null;
      return { kind: 'gone', chapter: ch, viaAlias, fallback: target || null };
    }

    return { kind: 'entry', chapter: ch, viaAlias };
  }

  _refMatchesChapter(ref, chapterId) {
    const ch = chapterId == null ? null : this.store.getChapter(chapterId);
    if (!ch) return false;
    if (ch.slug === ref) return true;
    return this.store.aliases.some((a) => a.chapterId === ch.id && a.aliasSlug === ref);
  }

  _findStructuralMigration(ref, excludeChapterId) {
    return [...this.store.chapterMigrations]
      .reverse()
      .find((m) => m.kind !== 'move'
        && m.fromChapterId !== excludeChapterId
        && m.toChapterId
        && this._refMatchesChapter(ref, m.fromChapterId));
  }

  _redirectOr404(user, ref, targetChapterId) {
    const target = this.store.getChapter(targetChapterId);
    if (target && canViewChapter(user, target)) {
      return { kind: 'redirect', from: ref, target };
    }
    // 目标不可见时不暴露迁移关系
    throw errors.notFound('章节不存在', { ref });
  }
}

module.exports = { ChapterService };
