/**
 * 街区章节列表页
 *  - 筛选/搜索/滚动位置在离开前保存，返回时恢复；
 *  - URL 参数（?theme=&q=）支持深链接，优先级高于存储状态；
 *  - 防乱序：快速切换筛选时，旧响应不会覆盖新列表。
 */
document.addEventListener('DOMContentLoaded', function () {
  const { fetchJSON, store, KEYS, restoreScroll, escapeHTML } = window.DistrictAPI;

  const grid = document.getElementById('districtGrid');
  const tabs = document.getElementById('themeTabs');
  const searchInput = document.getElementById('districtSearch');
  const searchBtn = document.getElementById('districtSearchBtn');

  const params = new URLSearchParams(location.search);
  // 深链接参数优先；否则用存储状态恢复
  const saved = store.load(KEYS.listState) || {};
  const state = {
    theme: params.get('theme') || saved.theme || 'all',
    q: params.has('q') ? params.get('q') : (saved.q || ''),
  };

  // 恢复筛选 UI
  tabs.querySelectorAll('.filter-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.theme === state.theme);
  });
  searchInput.value = state.q;

  function syncURL() {
    const p = new URLSearchParams();
    if (state.theme !== 'all') p.set('theme', state.theme);
    if (state.q) p.set('q', state.q);
    const qs = p.toString();
    history.replaceState(null, '', location.pathname + (qs ? '?' + qs : ''));
  }

  function saveState() {
    store.save(KEYS.listState, { theme: state.theme, q: state.q, scrollY: window.scrollY });
  }

  async function load() {
    syncURL();
    const p = new URLSearchParams();
    if (state.theme !== 'all') p.set('theme', state.theme);
    if (state.q) p.set('q', state.q);
    const res = await fetchJSON('districts:list', `${window.DistrictAPI.API_BASE}/districts?${p}`);
    if (res === null) return; // 乱序回包，已丢弃
    if (!res.ok) {
      grid.innerHTML = '<div class="empty-state">街区数据加载失败，请稍后重试。</div>';
      return;
    }
    render(res.data.items || []);
  }

  function render(items) {
    if (!items.length) {
      grid.innerHTML = '<div class="empty-state">没有符合条件的街区，换个筛选试试。</div>';
      return;
    }
    const themeIcon = { history: '🏯', culture: '🚢', industry: '🏭', food: '🍜' };
    grid.innerHTML = items.map((d) => `
      <article class="district-card" data-id="${escapeHTML(d.id)}">
        <div class="card-banner">${themeIcon[d.theme] || '🏘️'}</div>
        <div class="card-body">
          <h3>${escapeHTML(d.name)}</h3>
          <p class="card-summary">${escapeHTML(d.summary)}</p>
          <div class="card-meta">
            <span>📖 ${d.chapterCount} 个章节</span>
            <span>🗺️ ${d.routeCount} 条路线</span>
          </div>
          <a class="card-link" href="district.html?d=${encodeURIComponent(d.slug)}">进入街区 →</a>
        </div>
      </article>
    `).join('');

    // 进入详情前保存列表状态（筛选 + 滚动位置）
    grid.querySelectorAll('a.card-link').forEach((a) => {
      a.addEventListener('click', saveState);
    });
  }

  tabs.addEventListener('click', (e) => {
    const btn = e.target.closest('.filter-btn');
    if (!btn) return;
    tabs.querySelectorAll('.filter-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    state.theme = btn.dataset.theme;
    load();
  });

  function doSearch() {
    state.q = searchInput.value.trim();
    load();
  }
  searchBtn.addEventListener('click', doSearch);
  searchInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') doSearch(); });

  // 页面隐藏时（跳转详情）保存滚动位置
  window.addEventListener('pagehide', saveState);

  load().then(() => {
    // 返回时恢复滚动锚点（深链接带 hash 时优先 hash）
    if (!params.has('theme') && !params.has('q')) {
      restoreScroll(saved.scrollY || 0);
    }
  });
});
