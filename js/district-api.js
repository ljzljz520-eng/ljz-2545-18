/**
 * 街区章节 · 共享 API 客户端
 *  - 防乱序回包：同一资源键只接受最新一次请求的响应，迟到的旧响应被丢弃；
 *  - 状态存取：来源章节、筛选、滚动锚点存 sessionStorage，返回时恢复；
 *  - 深链接：无历史记录时提供确定入口。
 */
(function (global) {
  'use strict';

  const API_BASE = global.DISTRICT_API_BASE || '/api';

  // ---------- 防乱序：每个资源键记录最新请求序号 ----------
  let reqSeq = 0;
  const latestByKey = new Map();

  /**
   * 请求 JSON。若同一 key 已有更新的请求发出，本响应视为乱序回包，返回 null。
   * @param {string} key 资源键（如 'district:old-town'）
   * @param {string} url 请求地址
   */
  async function fetchJSON(key, url) {
    const my = ++reqSeq;
    latestByKey.set(key, my);
    let res;
    try {
      res = await fetch(url, { headers: { Accept: 'application/json' } });
    } catch (e) {
      if (latestByKey.get(key) !== my) return null;
      return { ok: false, status: 0, data: null, networkError: true };
    }
    const data = await res.json().catch(() => null);
    if (latestByKey.get(key) !== my) return null; // 乱序回包，丢弃
    return { ok: res.ok, status: res.status, data, cacheSeq: res.headers.get('X-Cache-Seq') };
  }

  // ---------- 状态存取（来源章节 / 筛选 / 滚动锚点） ----------
  const store = {
    save(key, value) {
      try { sessionStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* 隐私模式降级 */ }
    },
    load(key) {
      try {
        const raw = sessionStorage.getItem(key);
        return raw ? JSON.parse(raw) : null;
      } catch (e) { return null; }
    },
    remove(key) {
      try { sessionStorage.removeItem(key); } catch (e) { /* ignore */ }
    },
  };

  const KEYS = {
    listState: 'districts.listState.v1',   // 列表页：筛选 + 搜索 + 滚动位置
    routeFrom: 'districts.routeFrom.v1',   // 路线页来源（来源章节/街区）
    districtFrom: 'districts.districtFrom.v1', // 街区页来源
  };

  /** 判断是否同站来源（用于决定 back 行为） */
  function hasSameOriginReferrer() {
    try {
      return Boolean(document.referrer) && new URL(document.referrer).origin === location.origin;
    } catch (e) {
      return false;
    }
  }

  /**
   * 返回逻辑：
   *  - 有同站历史 → history.back()（浏览器自动恢复滚动与筛选页状态）；
   *  - 深链接无历史 → 跳转确定入口（fallbackUrl）。
   */
  function goBack(fallbackUrl) {
    if (hasSameOriginReferrer() && window.history.length > 1) {
      window.history.back();
    } else {
      window.location.href = fallbackUrl;
    }
  }

  /** 滚动锚点恢复：优先 URL hash，其次存储的 scrollY */
  function restoreScroll(savedScrollY) {
    if (location.hash) {
      const el = document.querySelector(location.hash);
      if (el) {
        requestAnimationFrame(() => el.scrollIntoView({ block: 'start' }));
        return;
      }
    }
    if (typeof savedScrollY === 'number' && savedScrollY > 0) {
      requestAnimationFrame(() => window.scrollTo(0, savedScrollY));
    }
  }

  function escapeHTML(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  global.DistrictAPI = {
    fetchJSON,
    store,
    KEYS,
    goBack,
    restoreScroll,
    hasSameOriginReferrer,
    escapeHTML,
    API_BASE,
  };
})(window);
