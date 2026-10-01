/**
 * 路线详情页
 *  - 展示跨区路线：主要展示入口 / 次要入口 / 停留点动线；
 *  - 撤回路线（410）展示替代指向，深链接有确定入口；
 *  - 返回时恢复来源街区；无来源时回退到路线主入口街区或街区列表。
 */
document.addEventListener('DOMContentLoaded', function () {
  const { fetchJSON, store, KEYS, goBack, hasSameOriginReferrer, escapeHTML } = window.DistrictAPI;

  const params = new URLSearchParams(location.search);
  const slugOrId = params.get('r');
  const els = {
    title: document.getElementById('routeTitle'),
    summary: document.getElementById('routeSummary'),
    breadcrumb: document.getElementById('breadcrumb'),
    districts: document.getElementById('routeDistricts'),
    stops: document.getElementById('routeStops'),
    gone: document.getElementById('goneBanner'),
    backBtn: document.getElementById('backBtn'),
    deepLinkHint: document.getElementById('deepLinkHint'),
  };

  const from = store.load(KEYS.routeFrom);

  if (!hasSameOriginReferrer()) {
    els.deepLinkHint.hidden = false;
  }

  // 返回：优先来源街区 → 浏览器历史 → 确定入口（街区列表）
  els.backBtn.addEventListener('click', () => {
    if (from && from.url && hasSameOriginReferrer()) {
      goBack(from.url);
    } else if (from && from.url) {
      window.location.href = from.url;
    } else {
      goBack('districts.html');
    }
  });

  if (!slugOrId) {
    els.title.textContent = '缺少路线参数';
    els.summary.textContent = '请从街区页面选择路线进入。';
    return;
  }

  function renderBreadcrumb(routeTitle) {
    const fromPart = from && from.slug
      ? `<a href="district.html?d=${encodeURIComponent(from.slug)}">${escapeHTML(from.name)}</a><span class="sep">/</span>`
      : '';
    els.breadcrumb.innerHTML = `
      <a href="index.html">首页</a><span class="sep">/</span>
      <a href="districts.html">街区章节</a><span class="sep">/</span>
      ${fromPart}
      <span aria-current="page">${escapeHTML(routeTitle)}</span>
    `;
  }

  function renderDistricts(d) {
    const chips = [];
    if (d.primaryDistrict) {
      chips.push(`
        <a class="district-chip primary" href="district.html?d=${encodeURIComponent(d.primaryDistrict.slug)}">
          <span class="role-dot"></span>主要入口 · ${escapeHTML(d.primaryDistrict.name)}
          ${d.primaryDistrict.needsReview ? '<span class="review-tag">复核中</span>' : ''}
        </a>
      `);
    }
    for (const sd of d.secondaryDistricts || []) {
      chips.push(`
        <a class="district-chip" href="district.html?d=${encodeURIComponent(sd.slug)}">
          次要入口 · ${escapeHTML(sd.name)}
          ${sd.needsReview ? '<span class="review-tag">复核中</span>' : ''}
        </a>
      `);
    }
    els.districts.innerHTML = chips.length ? chips.join('') : '<div class="empty-state">暂无关联街区。</div>';
  }

  function renderStops(stops) {
    if (!stops.length) {
      els.stops.innerHTML = '<li style="padding-left:0;"><p>暂无可公开的停留点。</p></li>';
      return;
    }
    els.stops.innerHTML = stops.map((s) => `
      <li id="rstop-${escapeHTML(s.id)}">
        <span class="seq">${s.seq}</span>
        <h4>${escapeHTML(s.name)}</h4>
        <p>${escapeHTML(s.description)} · 章节「${escapeHTML(s.chapterTitle)}」</p>
      </li>
    `).join('');
  }

  async function load() {
    const res = await fetchJSON(`route:${slugOrId}`, `${window.DistrictAPI.API_BASE}/routes/${encodeURIComponent(slugOrId)}`);
    if (res === null) return; // 乱序回包

    if (res.status === 410) {
      // 撤回/拆分：展示替代指向，深链接也有确定入口
      const details = (res.data && res.data.error && res.data.error.details) || {};
      els.title.textContent = '路线已撤回';
      els.summary.textContent = '该路线已撤回或拆分。';
      els.gone.hidden = false;
      els.gone.innerHTML = details.fallbackRouteId
        ? `⚠️ 此路线已撤回，推荐改走替代路线。<a href="route.html?r=${encodeURIComponent(details.fallbackRouteId)}">前往替代路线 →</a>`
        : '⚠️ 此路线已撤回。<a href="districts.html">返回街区列表 →</a>';
      renderBreadcrumb('路线已撤回');
      return;
    }
    if (!res.ok) {
      els.title.textContent = '路线不存在';
      els.summary.textContent = '请检查链接，或返回街区列表。';
      return;
    }

    const d = res.data;
    document.title = `${d.route.title} - 街区章节 - 智慧学习平台`;
    els.title.textContent = d.route.title;
    els.summary.textContent = d.route.summary;
    renderBreadcrumb(d.route.title);
    renderDistricts(d);
    renderStops(d.stops || []);

    // 点击关联街区前记录来源，保证返回链路连续
    els.districts.querySelectorAll('a.district-chip').forEach((a) => {
      a.addEventListener('click', () => {
        store.save(KEYS.districtFrom, { type: 'route', slug: d.route.slug, name: d.route.title, url: location.pathname + location.search });
      });
    });
  }

  load();
});
