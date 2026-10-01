/* =====================================================================
 * 街区志前端：
 *  - 来源章节 / 筛选 / 滚动锚点的记忆与恢复（浏览者返回）
 *  - 深链接（无历史记录）也有确定入口：别名/迁移/撤回替代
 *  - 回包乱序防护：过期响应不得覆盖新章节
 *  - 面包屑与后端权限同构（未公开章节不出现）
 *
 * 本文件同时可被 Node 引用（纯函数部分），用于验收测试。
 * ===================================================================== */
(function (global) {
  'use strict';

  const STATE_KEY = 'neighborhood:browse-state:v1';

  /* ---------------- 回包乱序防护（与 server/src/cache.js 同算法） -------- */
  class ResponseGuard {
    constructor() { this.serial = new Map(); }
    begin(key) {
      const seq = (this.serial.get(key) || 0) + 1;
      this.serial.set(key, seq);
      return seq;
    }
    isCurrent(key, seq) { return this.serial.get(key) === seq; }
  }

  /* ---------------- 浏览状态：恢复来源章节 / 筛选 / 锚点 ---------------- */
  function defaultState() {
    return { chapterRef: null, era: '', stopOnly: false, anchor: null, scrollY: 0, sourceRoute: null };
  }

  function saveState(state, storage) {
    try { (storage || sessionStorage).setItem(STATE_KEY, JSON.stringify(state)); }
    catch (_) { /* 隐私模式等：静默降级，不影响导航 */ }
  }

  function loadState(storage) {
    try {
      const raw = (storage || sessionStorage).getItem(STATE_KEY);
      return raw ? { ...defaultState(), ...JSON.parse(raw) } : null;
    } catch (_) { return null; }
  }

  function parseQuery(search) {
    const out = {};
    new URLSearchParams(search || '').forEach((v, k) => { out[k] = v; });
    return out;
  }

  /**
   * 决定页面初始状态（纯函数，便于测试）
   * @param params  URL 查询参数（ch / era / stopOnly / anchor / route / ref / alias）
   * @param saved   sessionStorage 中上次离开时的状态（浏览者返回时存在）
   * @param catalog 章节/路线目录（已按权限过滤）
   * @returns {{ state, notice }} notice 描述深链接来源（redirect/gone/entry）
   */
  function resolveInitialState(params, saved, catalog) {
    const hasExplicit = !!(params.ch || params.ref || params.alias || params.route);

    // 1) 深链接：没有历史记录也要给出确定入口，不依赖 saved
    if (params.ch || params.ref || params.alias) {
      const ref = params.ch || params.ref || params.alias;
      const resolved = catalog.resolveChapter(ref);
      if (resolved.kind === 'entry' || resolved.kind === 'redirect') {
        const target = resolved.chapter || resolved.target;
        return {
          state: {
            ...defaultState(),
            chapterRef: target.ref,
            era: params.era || '',
            stopOnly: params.stopOnly === '1',
            anchor: params.anchor || null,
            sourceRoute: params.route || null,
          },
          notice: { kind: resolved.kind, from: ref, target },
        };
      }
      if (resolved.kind === 'gone') {
        return {
          state: { ...defaultState(), era: params.era || '' },
          notice: { kind: 'gone', from: ref, fallback: resolved.fallback || null },
        };
      }
      return { state: { ...defaultState() }, notice: { kind: 'not_found', from: ref } };
    }

    if (params.route) {
      const entry = catalog.resolveRouteEntry(params.route);
      if (entry.kind === 'primary' || entry.kind === 'secondary') {
        return {
          state: { ...defaultState(), chapterRef: entry.chapter.ref, sourceRoute: params.route },
          notice: { kind: entry.kind, route: params.route },
        };
      }
      if (entry.kind === 'redirect' && entry.targetRoute) {
        return { state: { ...defaultState() }, notice: { kind: 'route_redirect', route: params.route, target: entry.targetRoute.slug } };
      }
      return { state: { ...defaultState() }, notice: { kind: 'gone', from: params.route, fallback: null } };
    }

    // 2) 浏览者返回（无显式参数）：恢复来源章节、筛选、滚动锚点
    if (!hasExplicit && saved && saved.chapterRef) {
      return { state: { ...defaultState(), ...saved }, notice: { kind: 'restored' } };
    }

    // 3) 首次访问：目录默认入口（确定性）
    const fallback = catalog.defaultChapter();
    return {
      state: { ...defaultState(), chapterRef: fallback ? fallback.ref : null },
      notice: { kind: 'default' },
    };
  }

  /* ---------------- 模拟目录（发布版；结构与后端 API 对应） ------------- */
  const CATALOG = {
    chapters: [
      { ref: 'city/old-town', slug: 'old-town', title: '老城厢', era: 'ming-qing',
        path: ['city'], breadcrumb: ['城市志', '老城厢'], status: 'published',
        summary: '明清街巷格局保存完整的历史街区。',
        history: '老城厢成形于明嘉靖年间，环绕县治筑城，街巷呈鱼骨状分布，石库门里弄与商号并存。',
        stops: [{ id: 'arch', title: '石库门里弄', anchor: 'anchor-arch' },
                { id: 'temple', title: '城惶庙市', anchor: 'anchor-temple' }] },
      { ref: 'city/riverside', slug: 'riverside', title: '河滨码头', era: 'republic',
        path: ['city'], breadcrumb: ['城市志', '河滨码头'], status: 'published',
        summary: '近代航运与工业文明登陆的街区。',
        history: '清末开埠后码头林立，仓储、纱厂与工人新村次第兴建，是跨区遗产路线的枢纽。',
        stops: [{ id: 'wharf', title: '河滨码头', anchor: 'anchor-wharf' }] },
      // 草稿章节：不会出现在树、面包屑与路线入口中
      { ref: 'city/secret-yard', slug: 'secret-yard', title: '未公开弄堂', era: 'modern',
        path: ['city'], breadcrumb: ['城市志', '未公开弄堂'], status: 'draft',
        summary: '', history: '', stops: [] },
    ],
    aliases: { 'laochengxiang': 'city/old-town' },
    // 路线关联（独立关联表的前端投影）：role primary/secondary，state active/review_pending
    routes: [
      { slug: 'heritage-walk', title: '遗产漫步', status: 'published',
        entries: [
          { chapterRef: 'city/old-town', role: 'primary', state: 'active' },
          { chapterRef: 'city/riverside', role: 'secondary', state: 'active' },
        ] },
      { slug: 'industry-line', title: '工业遗存线', status: 'published',
        entries: [
          { chapterRef: 'city/riverside', role: 'primary', state: 'active' },
        ] },
      // 边界修改后主要入口待复核：回落到次要入口
      { slug: 'boundary-walk', title: '城垣寻迹', status: 'published',
        entries: [
          { chapterRef: 'city/old-town', role: 'primary', state: 'review_pending' },
          { chapterRef: 'city/riverside', role: 'secondary', state: 'active' },
        ] },
      // 撤回路线：给确定替代
      { slug: 'old-canals', title: '旧水巷线', status: 'withdrawn',
        fallbackRoute: 'heritage-walk', entries: [] },
      // 草稿路线：公开目录中不可见
      { slug: 'draft-survey', title: '内部踏勘', status: 'draft',
        entries: [{ chapterRef: 'city/secret-yard', role: 'primary', state: 'active' }] },
    ],

    resolveChapter(ref) {
      const viaAlias = this.aliases[ref];
      const realRef = viaAlias || ref;
      const ch = this.chapters.find((c) => c.ref === realRef || c.slug === realRef);
      if (!ch || ch.status !== 'published') {
        return { kind: 'not_found' };
      }
      return viaAlias ? { kind: 'redirect', target: ch } : { kind: 'entry', chapter: ch };
    },
    resolveRouteEntry(slug) {
      const route = this.routes.find((r) => r.slug === slug);
      if (!route || route.status === 'draft') return { kind: 'not_found' };
      if (route.status === 'withdrawn') {
        if (route.fallbackRoute) {
          const target = this.routes.find((r) => r.slug === route.fallbackRoute && r.status === 'published');
          if (target) return { kind: 'redirect', targetRoute: target };
        }
        return { kind: 'gone' };
      }
      const rank = (e) => (e.role === 'primary' ? 0 : 1);
      const active = route.entries
        .filter((e) => e.state === 'active')
        .filter((e) => {
          const c = this.chapters.find((x) => x.ref === e.chapterRef);
          return c && c.status === 'published';
        })
        .sort((a, b) => rank(a) - rank(b));
      if (active.length === 0) return { kind: 'gone', reason: 'no-active-entry' };
      const e = active[0];
      const chapter = this.chapters.find((c) => c.ref === e.chapterRef);
      return { kind: e.role === 'primary' ? 'primary' : 'secondary', chapter };
    },
    defaultChapter() {
      return this.chapters.find((c) => c.status === 'published') || null;
    },
    visibleChapters() {
      return this.chapters.filter((c) => c.status === 'published');
    },
  };

  /* ---------------- 浏览器装配 ---------------- */
  function bootBrowser() {
    const guard = new ResponseGuard();
    let current = defaultState();

    const $ = (id) => document.getElementById(id);
    const treeEl = $('chapterTree');
    const titleEl = $('nbTitle');
    const summaryEl = $('nbSummary');
    const historyPanel = $('historyPanel');
    const stopsPanel = $('stopsPanel');
    const routesPanel = $('routesPanel');
    const anchorDemo = $('anchorDemo');

    function renderTree(activeRef) {
      treeEl.innerHTML = '';
      CATALOG.visibleChapters().forEach((c) => {
        const a = document.createElement('a');
        a.href = `neighborhood.html?ch=${encodeURIComponent(c.ref)}`;
        a.textContent = c.title;
        if (c.ref === activeRef) a.className = 'active';
        a.addEventListener('click', (ev) => {
          ev.preventDefault();
          current.chapterRef = c.ref;
          current.anchor = null;
          history.replaceState(null, '', `neighborhood.html?ch=${encodeURIComponent(c.ref)}`);
          saveState(current);
          loadChapter(c.ref);
        });
        treeEl.appendChild(a);
      });
    }

    function routeEntriesFor(ref) {
      const primary = [];
      const secondary = [];
      let hasReview = false;
      CATALOG.routes
        .filter((r) => r.status === 'published')
        .forEach((r) => {
          r.entries.forEach((e) => {
            if (e.chapterRef !== ref) return;
            if (e.state === 'review_pending') { hasReview = true; return; }
            const item = { slug: r.slug, title: r.title, role: e.role };
            if (e.role === 'primary') primary.push(item); else secondary.push(item);
          });
        });
      return { primary, secondary, hasReview };
    }

    function renderRouteList(el, items) {
      el.innerHTML = '';
      if (items.length === 0) {
        el.innerHTML = '<span class="nb-empty">暂无</span>';
        return;
      }
      items.forEach((it) => {
        const a = document.createElement('a');
        a.className = 'nb-route-item';
        // 进入路线前记住来源章节 / 筛选 / 锚点，返回时恢复
        a.href = `neighborhood.html?route=${encodeURIComponent(it.slug)}`;
        a.textContent = `${it.title}（${it.slug}）`;
        a.addEventListener('click', () => saveState(current));
        el.appendChild(a);
      });
    }

    // 模拟异步取章节；延迟随机化以复现回包乱序
    function fetchChapter(ref) {
      return new Promise((resolve) => {
        const delay = 30 + Math.random() * 80;
        setTimeout(() => resolve(CATALOG.resolveChapter(ref)), delay);
      });
    }

    async function loadChapter(ref, options = {}) {
      const seq = guard.begin('chapter');
      const result = await fetchChapter(ref);
      // 乱序防护：用户已切换到别的章节时，旧响应必须被丢弃
      if (!guard.isCurrent('chapter', seq)) return;

      if (result.kind !== 'entry' && result.kind !== 'redirect') {
        titleEl.textContent = '章节不存在或未公开';
        summaryEl.textContent = '';
        [historyPanel, stopsPanel, routesPanel, anchorDemo].forEach((p) => { p.hidden = true; });
        return;
      }
      const ch = result.chapter || result.target;
      current.chapterRef = ch.ref;
      renderTree(ch.ref);
      renderBreadcrumb(ch);
      titleEl.textContent = ch.title;
      summaryEl.textContent = ch.summary;

      historyPanel.hidden = false;
      $('nbHistory').textContent = ch.history;

      const eraMatch = (c) => !current.era || c.era === current.era;
      const stops = ch.stops.filter(() => eraMatch(ch) || !current.stopOnly);
      stopsPanel.hidden = stops.length === 0;
      const list = $('stopList');
      list.innerHTML = '';
      stops.forEach((s) => {
        const li = document.createElement('li');
        const a = document.createElement('a');
        a.href = `#${s.anchor}`;
        a.textContent = s.title;
        a.addEventListener('click', () => {
          current.anchor = s.anchor;
          saveState(current);
        });
        li.appendChild(a);
        list.appendChild(li);
      });

      const entries = routeEntriesFor(ch.ref);
      routesPanel.hidden = false;
      renderRouteList($('primaryEntries'), entries.primary);
      renderRouteList($('secondaryEntries'), entries.secondary);
      $('reviewHint').hidden = !entries.hasReview;

      anchorDemo.hidden = false;
      if (!options.skipAnchor && current.anchor) {
        const target = document.getElementById(current.anchor);
        if (target) target.scrollIntoView();
      }
      if (!options.skipAnchor && current.scrollY) {
        window.scrollTo(0, current.scrollY);
      }
      saveState(current);
    }

    function renderBreadcrumb(ch) {
      const bc = $('breadcrumb');
      bc.innerHTML = '<a href="neighborhood.html">街区志</a>';
      ch.breadcrumb.forEach((label, i) => {
        const sep = document.createElement('span');
        sep.className = 'nb-sep';
        sep.textContent = '/';
        bc.appendChild(sep);
        const span = document.createElement('span');
        span.textContent = label;
        if (i === ch.breadcrumb.length - 1) span.className = 'nb-current';
        bc.appendChild(span);
      });
    }

    function showNotice(notice) {
      const banner = $('deeplinkBanner');
      const text = $('deeplinkText');
      const fb = $('deeplinkFallback');
      if (!notice || notice.kind === 'default' || notice.kind === 'restored') {
        banner.hidden = true;
        if (notice && notice.kind === 'restored') {
          text.textContent = '已恢复你上次浏览的街区、筛选与位置。';
          banner.hidden = false;
          fb.hidden = true;
        }
        return;
      }
      banner.hidden = false;
      if (notice.kind === 'redirect') {
        text.textContent = `该链接已迁移，已为你打开「${notice.target.title}」。`;
        fb.hidden = true;
      } else if (notice.kind === 'primary' || notice.kind === 'secondary') {
        text.textContent = notice.kind === 'primary' ? '已从路线主要入口进入该街区。'
          : '主要入口正在复核，已从次要入口进入。';
        fb.hidden = true;
      } else if (notice.kind === 'route_redirect') {
        text.textContent = '原路线已撤回并拆分。';
        fb.href = `neighborhood.html?route=${encodeURIComponent(notice.target)}`;
        fb.textContent = '前往接续路线';
        fb.hidden = false;
      } else if (notice.kind === 'gone') {
        text.textContent = '该内容已撤回，没有可用入口。';
        fb.hidden = true;
      } else if (notice.kind === 'not_found') {
        text.textContent = '找不到对应章节或路线。';
        fb.hidden = true;
      }
    }

    // 初始化
    function init() {
      const params = parseQuery(window.location.search);
      const saved = loadState();
      const { state, notice } = resolveInitialState(params, saved, CATALOG);
      current = state;

      // 恢复筛选控件
      $('eraFilter').value = current.era || '';
      $('stopOnly').checked = !!current.stopOnly;

      $('eraFilter').addEventListener('change', (e) => {
        current.era = e.target.value;
        saveState(current);
        loadChapter(current.chapterRef, { skipAnchor: true });
      });
      $('stopOnly').addEventListener('change', (e) => {
        current.stopOnly = e.target.checked;
        saveState(current);
        loadChapter(current.chapterRef, { skipAnchor: true });
      });
      $('deeplinkDismiss').addEventListener('click', () => { $('deeplinkBanner').hidden = true; });

      // 离开/滚动时记忆位置
      let scrollTimer = null;
      window.addEventListener('scroll', () => {
        clearTimeout(scrollTimer);
        scrollTimer = setTimeout(() => {
          current.scrollY = window.scrollY;
          saveState(current);
        }, 100);
      });

      renderTree(current.chapterRef);
      if (current.chapterRef) loadChapter(current.chapterRef);
      showNotice(notice);
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  }

  const api = { ResponseGuard, resolveInitialState, parseQuery, defaultState, CATALOG };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    global.Neighborhood = api;
    bootBrowser();
  }
})(typeof window !== 'undefined' ? window : globalThis);
