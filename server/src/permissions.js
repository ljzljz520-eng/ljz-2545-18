'use strict';

// 角色：visitor 仅见 published；editor 可见草稿但不能发布；admin 全权
const ROLES = ['visitor', 'editor', 'admin'];

function canViewChapter(user, chapter) {
  if (chapter.status === 'published') return true;
  if (!user) return false;
  if (user.role === 'admin') return true;
  // 编辑只能看到自己负责的章节树（responsibility 存章节 id 集合）
  if (user.role === 'editor') {
    return user.chapterIds ? user.chapterIds.includes(chapter.id) : false;
  }
  return false;
}

function canEditChapter(user, chapter) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (user.role === 'editor') {
    return user.chapterIds ? user.chapterIds.includes(chapter.id) : false;
  }
  return false;
}

function canPublish(user) {
  return !!user && user.role === 'admin';
}

// 路线关联接口与面包屑共用同一套可见性判定，杜绝“未公开章节经路线泄漏”
function visibleChapters(user, chapters) {
  return chapters.filter((c) => canViewChapter(user, c));
}

module.exports = { ROLES, canViewChapter, canEditChapter, canPublish, visibleChapters };
