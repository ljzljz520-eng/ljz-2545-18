'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const nb = require(path.join(__dirname, '..', '..', 'js', 'neighborhood.js'));

const { resolveInitialState, parseQuery, defaultState, CATALOG, ResponseGuard } = nb;

test('浏览者返回：恢复来源章节、筛选与滚动锚点', () => {
  const saved = {
    ...defaultState(),
    chapterRef: 'city/riverside',
    era: 'republic',
    stopOnly: true,
    anchor: 'anchor-wharf',
    scrollY: 420,
  };
  // 无显式查询参数 -> 走“返回恢复”分支
  const { state, notice } = resolveInitialState(parseQuery(''), saved, CATALOG);
  assert.equal(notice.kind, 'restored');
  assert.equal(state.chapterRef, 'city/riverside');
  assert.equal(state.era, 'republic');
  assert.equal(state.stopOnly, true);
  assert.equal(state.anchor, 'anchor-wharf');
  assert.equal(state.scrollY, 420);
});

test('深链接没有历史记录：显式章节参数给出确定入口，不依赖 saved', () => {
  const { state, notice } = resolveInitialState(
    parseQuery('?ch=city/old-town&era=ming-qing&anchor=anchor-arch'),
    null, CATALOG);
  assert.equal(notice.kind, 'entry');
  assert.equal(state.chapterRef, 'city/old-town');
  assert.equal(state.anchor, 'anchor-arch');
});

test('深链接走别名：redirect 到真实章节', () => {
  const { state, notice } = resolveInitialState(
    parseQuery('?alias=laochengxiang'), null, CATALOG);
  assert.equal(notice.kind, 'redirect');
  assert.equal(state.chapterRef, 'city/old-town');
});

test('深链接到草稿章节：not_found，不泄漏', () => {
  const { state, notice } = resolveInitialState(
    parseQuery('?ch=city/secret-yard'), null, CATALOG);
  assert.equal(notice.kind, 'not_found');
  assert.equal(state.chapterRef, null);
});

test('路线入口：正常取主要入口；主要入口复核时回落次要入口', () => {
  const main = resolveInitialState(parseQuery('?route=heritage-walk'), null, CATALOG);
  assert.equal(main.notice.kind, 'primary');
  assert.equal(main.state.chapterRef, 'city/old-town');

  const fallback = resolveInitialState(parseQuery('?route=boundary-walk'), null, CATALOG);
  assert.equal(fallback.notice.kind, 'secondary');
  assert.equal(fallback.state.chapterRef, 'city/riverside');
});

test('撤回路线：深链接给出替代指向（接续路线）；无替代则 gone', () => {
  const r = resolveInitialState(parseQuery('?route=old-canals'), null, CATALOG);
  assert.equal(r.notice.kind, 'route_redirect');
  assert.equal(r.notice.target, 'heritage-walk');

  // 草稿路线公开不可见
  const d = resolveInitialState(parseQuery('?route=draft-survey'), null, CATALOG);
  assert.equal(d.notice.kind, 'gone');
});

test('前端乱序防护：先领的旧序号提交时被判过期', () => {
  const g = new ResponseGuard();
  const s1 = g.begin('chapter');
  const s2 = g.begin('chapter');
  assert.equal(g.isCurrent('chapter', s2), true);
  assert.equal(g.isCurrent('chapter', s1), false);
});
