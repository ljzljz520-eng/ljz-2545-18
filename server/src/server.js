'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { ApiError, NotFoundError, ValidationError } = require('./errors');
const { VersionedCache } = require('./cache');
const services = require('./services');

const STATIC_ROOT = path.resolve(__dirname, '..', '..');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.md': 'text/plain; charset=utf-8',
};

/** 从请求头解析调用者身份（演示级：X-Actor-Id / X-Role） */
function actorOf(req) {
  const role = req.headers['x-role'];
  if (!role) return null;
  return { id: req.headers['x-actor-id'] || 'editor-1', role };
}

function sendJSON(res, status, body, extraHeaders) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(payload);
}

function sendError(res, err) {
  if (err instanceof ApiError) {
    sendJSON(res, err.status, { error: { code: err.code, message: err.message, details: err.details } });
  } else {
    console.error(err);
    sendJSON(res, 500, { error: { code: 'INTERNAL', message: '服务器内部错误' } });
  }
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) reject(new ValidationError('请求体过大'));
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { reject(new ValidationError('请求体必须是 JSON')); }
    });
    req.on('error', reject);
  });
}

/** API 路由表：[method, pattern, handler]。pattern 中 :name 为路径参数 */
function buildRoutes(ctx) {
  const { store, cache } = ctx;
  return [
    // ---------- 公开查询 ----------
    ['GET', '/api/districts', async (req, res, m, q) => {
      const actor = actorOf(req);
      const allowed = services.visibleStatuses(actor);
      let list = (await store.listDistricts()).filter((d) => allowed.includes(d.status));
      const theme = q.get('theme');
      const kw = (q.get('q') || '').trim().toLowerCase();
      if (theme && theme !== 'all') list = list.filter((d) => d.theme === theme);
      if (kw) list = list.filter((d) => (d.name + d.summary).toLowerCase().includes(kw));
      // 每个街区附带可见章节数与路线入口数（计数同样按权限过滤）
      const items = [];
      for (const d of list) {
        const chapters = (await store.listChaptersByDistrict(d.id)).filter((c) => allowed.includes(c.status));
        const links = await store.listRouteDistrictsByDistrict(d.id);
        let routeCount = 0;
        for (const l of links) {
          const r = await store.getRoute(l.routeId);
          if (r && allowed.includes(r.status)) routeCount += 1;
        }
        items.push({ ...d, chapterCount: chapters.length, routeCount });
      }
      sendJSON(res, 200, { items, cacheSeq: cache.nextSeq() });
    }],

    ['GET', '/api/districts/:slug', async (req, res, m) => {
      const detail = await services.getDistrictDetail(store, cache, m.slug, actorOf(req));
      sendJSON(res, 200, detail, { 'X-Cache-Seq': String(detail.cacheSeq) });
    }],

    ['GET', '/api/chapters/:id', async (req, res, m) => {
      const result = await services.resolveChapter(store, m.id, actorOf(req));
      sendJSON(res, 200, result);
    }],

    ['GET', '/api/chapters/:id/breadcrumb', async (req, res, m) => {
      const bc = await services.getBreadcrumb(store, m.id, actorOf(req));
      sendJSON(res, 200, bc);
    }],

    ['GET', '/api/routes/:slug', async (req, res, m) => {
      const detail = await services.getRouteDetail(store, cache, m.slug, actorOf(req));
      sendJSON(res, 200, detail, { 'X-Cache-Seq': String(detail.cacheSeq) });
    }],

    ['GET', '/api/reviews', async (req, res, m, q) => {
      const actor = actorOf(req);
      if (!actor || actor.role !== 'editor') throw new ValidationError('需要编辑权限');
      sendJSON(res, 200, { items: await store.listReviews(q.get('status') || 'pending') });
    }],

    // ---------- 编辑操作 ----------
    ['POST', '/api/chapters/:id/move', async (req, res, m) => {
      const body = await readBody(req);
      const moved = await services.moveChapter(store, cache, {
        id: m.id, newParentId: body.newParentId ?? null,
        baseVersion: body.baseVersion, actor: actorOf(req),
      });
      sendJSON(res, 200, { chapter: moved });
    }],

    ['POST', '/api/districts/:id/boundary', async (req, res, m) => {
      const body = await readBody(req);
      const result = await services.updateDistrictBoundary(store, cache, {
        id: m.id, boundary: body.boundary, center: body.center,
        baseVersion: body.baseVersion, actor: actorOf(req),
      });
      sendJSON(res, 200, result);
    }],

    ['POST', '/api/reviews/:id/resolve', async (req, res, m) => {
      const body = await readBody(req);
      const review = await services.resolveReview(store, cache, {
        reviewId: Number(m.id), action: body.action, actor: actorOf(req),
      });
      sendJSON(res, 200, { review });
    }],

    ['DELETE', '/api/districts/:id', async (req, res, m) => {
      const result = await services.deleteDistrict(store, cache, { id: m.id, actor: actorOf(req) });
      sendJSON(res, 200, result);
    }],

    ['POST', '/api/routes/:id/split', async (req, res, m) => {
      const result = await services.splitRoute(store, cache, { routeId: m.id, actor: actorOf(req) });
      sendJSON(res, 200, result);
    }],

    ['POST', '/api/routes/:id/withdraw', async (req, res, m) => {
      const body = await readBody(req);
      const result = await services.withdrawRoute(store, cache, {
        routeId: m.id, fallbackRouteId: body.fallbackRouteId || null, actor: actorOf(req),
      });
      sendJSON(res, 200, result);
    }],

    ['GET', '/api/health', async (req, res) => {
      sendJSON(res, 200, { ok: true, cache: cache.stats() });
    }],
  ];
}

function matchRoute(pattern, pathname) {
  const pp = pattern.split('/').filter(Boolean);
  const ap = pathname.split('/').filter(Boolean);
  if (pp.length !== ap.length) return null;
  const params = {};
  for (let i = 0; i < pp.length; i++) {
    if (pp[i].startsWith(':')) params[pp[i].slice(1)] = decodeURIComponent(ap[i]);
    else if (pp[i] !== ap[i]) return null;
  }
  return params;
}

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.normalize(path.join(STATIC_ROOT, rel));
  if (!file.startsWith(STATIC_ROOT)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

function createServer(ctx) {
  const routes = buildRoutes(ctx);
  return http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://localhost');
    const pathname = u.pathname;
    if (!pathname.startsWith('/api/')) {
      serveStatic(req, res, pathname);
      return;
    }
    try {
      for (const [method, pattern, handler] of routes) {
        if (method !== req.method) continue;
        const params = matchRoute(pattern, pathname);
        if (!params) continue;
        await handler(req, res, params, u.searchParams);
        return;
      }
      throw new NotFoundError('接口不存在', { path: pathname });
    } catch (err) {
      sendError(res, err);
    }
  });
}

async function buildContext() {
  if (process.env.DATABASE_URL) {
    const { PgStore } = require('./pg-store');
    const store = new PgStore(process.env.DATABASE_URL);
    await store.init();
    console.log('[server] 使用 PostgreSQL 存储');
    return { store, cache: new VersionedCache() };
  }
  const { MemoryStore, seed } = require('./store');
  const store = seed(new MemoryStore());
  console.log('[server] 未配置 DATABASE_URL，使用内存存储（含种子数据）');
  return { store, cache: new VersionedCache() };
}

if (require.main === module) {
  (async () => {
    const ctx = await buildContext();
    const server = createServer(ctx);
    const port = Number(process.env.PORT || 3000);
    server.listen(port, () => console.log(`[server] listening on :${port}`));
  })();
}

module.exports = { createServer, buildContext };
