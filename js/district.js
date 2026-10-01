/**
 * 街区详情页
 *  - 展示历史背景、章节树、停留点、路线入口（主/次）；
 *  - 面包屑由后端按权限生成，页面不自行拼接隐藏节点；
 *  - 返回时恢复来源（列表筛选/滚动）；深链接无历史也有确定入口；
 *  - 点击路线入口前记录来源街区，供路线页返回时恢复。
 */
document.addEventListener('DOMContentLoaded', function () {
  const { fetchJSON, store, KEYS, goBack, restoreScroll, hasSameOriginReferrer, escapeHTML } = window.DistrictAPI;

  const params = new URLSearchParams(location.search);
  const slug = params.get('d');
  const els = {
    name: document.getElementById('districtName'),
    summary: document.getElementById('districtSummary'),
    history: document.getElementById('districtHistory'),
    breadcrumb: document.getElementById('breadcrumb'),
    chapterTree: document.getElementById('chapterTree'),
    stopList: document.getElementById('stopList'),
    primary: document.getElementById('primaryEntries'),
    secondary: document.getElementById('secondaryEntries'),
    backBtn: document.getElementById('backBtn'),
    deepLinkHint: document.getElementById('deepLinkHint'),
  };

  // 深链接：无同站来源时提示确定入口
  if (!hasSameOriginReferrer()) {
    els.deepLinkHint.hidden = false;
  }
  els.backBtn.addEventListener('click', () => goBack('districts.html'));

  if (!slug) {
    els.name.textContent = '缺少街区参数';
    els.summary.textContent = '请从街区列表进入。';
    return;
  }

  function renderBreadcrumb(district) {
    els.breadcrumb.innerHTML = `
      <a href="index.html">首页</a><span class="sep">/</span>
      <a href="districts.html">街区章节</a><span class="sep">/</span>
      <span aria-current="page">${escapeHTML(district.name)}</span>
    `;
  }

  function renderChapters(nodes) {
    if (!nodes.length) return '<li><span class="chapter-summary">暂无公开章节。</span></li>';
    return nodes.map((c) => `
      <li id="chapter-${escapeHTML(c.id)}">
        <div class="chapter-row">
          <a class="chapter-title" href="#chapter-${escapeHTML(c.id)}">${escapeHTML(c.title)}</a>
          ${c.status !== 'published' ? `<span class="status-tag ${escapeHTML(c.status)}">${escapeHTML(c.status)}</span>` : ''}
          <span class="chapter-summary">${escapeHTML(c.summary)}</span>
          ${c.historyBackground ? `<span class="chapter-summary">📜 ${escapeHTML(c.historyBackground)}</span>` : ''}
        </div>
        ${c.children && c.children.length ? `<ul>${renderChapters(c.children)}</ul>` : ''}
      </li>
    `).join('');
  }

  function renderStops(stops) {
    if (!stops.length) return '<div class="empty-state">暂无停留点。</div>';
    return stops.map((s) => `
      <div class="stop-card" id="stop-${escapeHTML(s.id)}">
        <h4>📍 ${escapeHTML(s.name)}</h4>
        <span class="stop-chapter">所属章节：${escapeHTML(s.chapterTitle)}</span>
        <p>${escapeHTML(s.description)}</p>
      </div>
    `).join('');
  }

  function entryHTML(e, isPrimary) {
    if (e.status === 'withdrawn' || e.status === 'split') {
      // 撤回路线：展示替代指向，不提供正文入口
      const fb = e.fallbackRouteId;
      return `
        <div class="route-entry withdrawn">
          <div>
            <span class="entry-role">已撤回</span>
            <h4>${escapeHTML(e.title)}</h4>
            <div class="entry-note">该路线已撤回${fb ? '，请改走替代路线' : ''}</div>
          </div>
          ${fb ? `<a class="btn btn-secondary" data-route-id="${escapeHTML(fb)}" href="route.html?r=${encodeURIComponent(fb)}">查看替代路线 →</a>` : ''}
        </div>
      `;
    }
    return `
      <div class="route-entry ${isPrimary ? 'primary' : 'secondary'}">
        <div>
          <span class="entry-role">${isPrimary ? '主要入口' : '次要入口'}</span>
          ${e.needsReview ? '<span class="review-tag">边界复核中</span>' : ''}
          <h4>${escapeHTML(e.title)}</h4>
          <div class="entry-note">${escapeHTML(e.entryNote || e.summary || '')}</div>
        </div>
        <a class="btn btn-primary" data-route-slug="${escapeHTML(e.slug)}" href="route.html?r=${encodeURIComponent(e.slug)}">进入路线 →</a>
      </div>
    `;
  }

  async function load() {
    const res = await fetchJSON(`district:${slug}`, `${window.DistrictAPI.API_BASE}/districts/${encodeURIComponent(slug)}`);
    if (res === null) return; // 乱序回包
    if (res.status === 410) {
      els.name.textContent = '街区已撤回';
      els.summary.textContent = '该街区已下线，请返回街区列表选择其他街区。';
      return;
    }
    if (!res.ok) {
      els.name.textContent = '街区不存在';
      els.summary.textContent = '请检查链接，或返回街区列表。';
      return;
    }
    const d = res.data;
    document.title = `${d.district.name} - 街区章节 - 智慧学习平台`;
    els.name.textContent = d.district.name;
    els.summary.textContent = d.district.summary;
    els.history.textContent = d.district.history || '历史背景整理中。';
    renderBreadcrumb(d.district);
    els.chapterTree.innerHTML = renderChapters(d.chapters || []);
    els.stopList.innerHTML = renderStops(d.stops || []);
    els.primary.innerHTML = (d.primaryEntries || []).map((e) => entryHTML(e, true)).join('');
    els.secondary.innerHTML = (d.secondaryEntries || []).map((e) => entryHTML(e, false)).join('');
    if (!(d.primaryEntries || []).length && !(d.secondaryEntries || []).length) {
      els.secondary.innerHTML = '<div class="empty-state">暂无路线经过本街区。</div>';
    }

    // 点击路线入口前：记录来源街区（路线页返回时恢复）
    document.querySelectorAll('[data-route-slug], [data-route-id]').forEach((a) => {
      a.addEventListener('click', () => {
        store.save(KEYS.routeFrom, {
          type: 'district', slug: d.district.slug, name: d.district.name,
          url: location.pathname + location.search + location.hash,
        });
      });
    });

    // 滚动锚点恢复（#stop-S1 等）
    restoreScroll(0);
  }

  load();
});
