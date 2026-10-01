'use strict';

/**
 * 数据访问层（PostgreSQL 实现）。
 * 与 store.js（内存实现）方法签名一致；服务层无感知切换。
 * 需要 `npm i pg` 并设置 DATABASE_URL。
 */

const fs = require('fs');
const path = require('path');

const CAMEL = /_([a-z])/g;
const toCamel = (s) => s.replace(CAMEL, (_, c) => c.toUpperCase());
function rowToCamel(row) {
  if (!row) return null;
  const out = {};
  for (const k of Object.keys(row)) out[toCamel(k)] = row[k];
  return out;
}

class PgStore {
  constructor(databaseUrl) {
    // 懒加载，未安装 pg 时给出明确错误
    let pg;
    try {
      pg = require('pg');
    } catch (e) {
      throw new Error('使用 PostgreSQL 存储需要先安装依赖：cd server && npm i pg');
    }
    this.pool = new pg.Pool({ connectionString: databaseUrl });
  }

  async init() {
    const ddl = fs.readFileSync(path.join(__dirname, '..', 'sql', 'schema.sql'), 'utf8');
    await this.pool.query(ddl);
  }

  async q(text, params) {
    const res = await this.pool.query(text, params);
    return res.rows.map(rowToCamel);
  }
  async one(text, params) {
    const rows = await this.q(text, params);
    return rows[0] || null;
  }

  // ---------- 街区 ----------
  async listDistricts() { return this.q('SELECT * FROM districts ORDER BY id'); }
  async getDistrict(id) { return this.one('SELECT * FROM districts WHERE id=$1', [id]); }
  async getDistrictBySlug(slug) { return this.one('SELECT * FROM districts WHERE slug=$1', [slug]); }
  async updateDistrict(id, patch, baseVersion) {
    const sets = [];
    const vals = [];
    let i = 1;
    const map = { boundary: 'boundary', boundaryVersion: 'boundary_version', centerLng: 'center_lng', centerLat: 'center_lat', version: 'version', status: 'status', name: 'name', summary: 'summary', history: 'history' };
    for (const [k, col] of Object.entries(map)) {
      if (patch[k] !== undefined) { sets.push(`${col}=$${i++}`); vals.push(k === 'boundary' ? JSON.stringify(patch[k]) : patch[k]); }
    }
    if (!sets.length) return this.getDistrict(id);
    sets.push('updated_at=now()');
    vals.push(id);
    let sql = `UPDATE districts SET ${sets.join(',')} WHERE id=$${i++}`;
    if (baseVersion !== undefined) { sql += ` AND version=$${i++}`; vals.push(baseVersion); }
    const rows = await this.q(sql + ' RETURNING *', vals);
    if (baseVersion !== undefined && rows.length === 0) return false;
    return rows[0] || null;
  }
  async deleteDistrict(id) {
    const rows = await this.q('DELETE FROM districts WHERE id=$1 RETURNING id', [id]);
    return rows.length > 0;
  }

  // ---------- 章节 ----------
  async getChapter(id) { return this.one('SELECT * FROM chapters WHERE id=$1', [id]); }
  async getChapterBySlug(districtId, slug) { return this.one('SELECT * FROM chapters WHERE district_id=$1 AND slug=$2', [districtId, slug]); }
  async findChapterBySlug(slug) { return this.one('SELECT * FROM chapters WHERE slug=$1', [slug]); }
  async listChaptersByDistrict(districtId) { return this.q('SELECT * FROM chapters WHERE district_id=$1 ORDER BY sort_order', [districtId]); }
  async listChildren(parentId) { return this.q('SELECT * FROM chapters WHERE parent_id=$1 ORDER BY sort_order', [parentId]); }
  async moveChapter(id, newParentId, baseVersion) {
    const rows = await this.q(
      'UPDATE chapters SET parent_id=$1, version=version+1, updated_at=now() WHERE id=$2 AND version=$3 RETURNING *',
      [newParentId, id, baseVersion]
    );
    if (rows.length === 0) {
      const exists = await this.getChapter(id);
      return exists ? 'VERSION_CONFLICT' : null;
    }
    return rows[0];
  }
  async updateChapter(id, patch, baseVersion) {
    const sets = [];
    const vals = [];
    let i = 1;
    const map = { title: 'title', summary: 'summary', historyBackground: 'history_background', status: 'status', sortOrder: 'sort_order', slug: 'slug' };
    for (const [k, col] of Object.entries(map)) {
      if (patch[k] !== undefined) { sets.push(`${col}=$${i++}`); vals.push(patch[k]); }
    }
    sets.push('version=version+1', 'updated_at=now()');
    vals.push(id);
    let sql = `UPDATE chapters SET ${sets.join(',')} WHERE id=$${i++}`;
    if (baseVersion !== undefined) { sql += ` AND version=$${i++}`; vals.push(baseVersion); }
    const rows = await this.q(sql + ' RETURNING *', vals);
    if (rows.length === 0) {
      const exists = await this.getChapter(id);
      return exists ? 'VERSION_CONFLICT' : null;
    }
    return rows[0];
  }

  // ---------- 发布版 ----------
  async addPublication(chapterId, version, payload, publishedBy) {
    return this.one(
      'INSERT INTO chapter_publications(chapter_id,version,payload,published_by) VALUES($1,$2,$3,$4) ON CONFLICT (chapter_id,version) DO NOTHING RETURNING *',
      [chapterId, version, JSON.stringify(payload), publishedBy || 'system']
    );
  }
  async listPublications(chapterId) {
    return this.q('SELECT * FROM chapter_publications WHERE chapter_id=$1 ORDER BY version DESC', [chapterId]);
  }

  // ---------- 别名 ----------
  async addAlias(alias, chapterId) {
    await this.q('INSERT INTO chapter_aliases(alias,chapter_id) VALUES($1,$2) ON CONFLICT (alias) DO UPDATE SET chapter_id=$2', [alias, chapterId]);
  }
  async resolveAlias(alias) {
    const row = await this.one('SELECT chapter_id AS cid FROM chapter_aliases WHERE alias=$1', [alias]);
    return row ? this.getChapter(row.cid) : null;
  }

  // ---------- 章节迁移 ----------
  async addChapterMigration(fromId, toId, reason, note) {
    return this.one('INSERT INTO chapter_migrations(from_chapter_id,to_chapter_id,reason,note) VALUES($1,$2,$3,$4) RETURNING *', [fromId, toId, reason, note || '']);
  }
  async findChapterMigration(fromId) {
    return this.q('SELECT * FROM chapter_migrations WHERE from_chapter_id=$1 ORDER BY id', [fromId]);
  }

  // ---------- 停留点 ----------
  async getStop(id) { return this.one('SELECT * FROM stops WHERE id=$1', [id]); }
  async listStopsByChapter(chapterId) { return this.q('SELECT * FROM stops WHERE chapter_id=$1 ORDER BY sort_order', [chapterId]); }

  // ---------- 路线 ----------
  async getRoute(id) { return this.one('SELECT * FROM routes WHERE id=$1', [id]); }
  async getRouteBySlug(slug) { return this.one('SELECT * FROM routes WHERE slug=$1', [slug]); }
  async createRoute(data) {
    return this.one(
      'INSERT INTO routes(id,slug,title,summary,status,fallback_route_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
      [data.id, data.slug, data.title, data.summary || '', data.status || 'published', data.fallbackRouteId || null]
    );
  }
  async updateRoute(id, patch, baseVersion) {
    const sets = [];
    const vals = [];
    let i = 1;
    const map = { title: 'title', summary: 'summary', status: 'status', fallbackRouteId: 'fallback_route_id' };
    for (const [k, col] of Object.entries(map)) {
      if (patch[k] !== undefined) { sets.push(`${col}=$${i++}`); vals.push(patch[k]); }
    }
    sets.push('version=version+1', 'updated_at=now()');
    vals.push(id);
    let sql = `UPDATE routes SET ${sets.join(',')} WHERE id=$${i++}`;
    if (baseVersion !== undefined) { sql += ` AND version=$${i++}`; vals.push(baseVersion); }
    const rows = await this.q(sql + ' RETURNING *', vals);
    if (rows.length === 0) {
      const exists = await this.getRoute(id);
      return exists ? 'VERSION_CONFLICT' : null;
    }
    return rows[0];
  }

  // ---------- 路线-停留点 ----------
  async listRouteStops(routeId) { return this.q('SELECT * FROM route_stops WHERE route_id=$1 ORDER BY seq', [routeId]); }
  async addRouteStop(routeId, stopId, seq) {
    await this.q('INSERT INTO route_stops(route_id,stop_id,seq) VALUES($1,$2,$3) ON CONFLICT (route_id,stop_id) DO UPDATE SET seq=$3', [routeId, stopId, seq]);
  }
  async clearRouteStops(routeId) { await this.q('DELETE FROM route_stops WHERE route_id=$1', [routeId]); }

  // ---------- 路线 ↔ 街区 关联 ----------
  async listRouteDistricts(routeId) { return this.q('SELECT * FROM route_districts WHERE route_id=$1', [routeId]); }
  async listRouteDistrictsByDistrict(districtId) { return this.q('SELECT * FROM route_districts WHERE district_id=$1', [districtId]); }
  async addRouteDistrict(routeId, districtId, role, entryNote, fallbackRouteId) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (role === 'primary') {
        await client.query("UPDATE route_districts SET role='secondary' WHERE route_id=$1 AND role='primary'", [routeId]);
      }
      const res = await client.query(
        `INSERT INTO route_districts(route_id,district_id,role,entry_note,fallback_route_id)
         VALUES($1,$2,$3,$4,$5)
         ON CONFLICT (route_id,district_id) DO UPDATE SET role=$3, entry_note=$4
         RETURNING *`,
        [routeId, districtId, role || 'secondary', entryNote || '', fallbackRouteId || null]
      );
      await client.query('COMMIT');
      return rowToCamel(res.rows[0]);
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
  async setRouteDistrictNeedsReview(routeId, districtId, needsReview) {
    return this.one('UPDATE route_districts SET needs_review=$3 WHERE route_id=$1 AND district_id=$2 RETURNING *', [routeId, districtId, needsReview]);
  }
  async removeRouteDistrict(routeId, districtId) {
    const rows = await this.q('DELETE FROM route_districts WHERE route_id=$1 AND district_id=$2 RETURNING route_id', [routeId, districtId]);
    return rows.length > 0;
  }
  async setRouteDistrictFallback(routeId, districtId, fallbackRouteId) {
    return this.one('UPDATE route_districts SET fallback_route_id=$3 WHERE route_id=$1 AND district_id=$2 RETURNING *', [routeId, districtId, fallbackRouteId]);
  }

  // ---------- 复核队列 ----------
  async createReview(data) {
    return this.one(
      'INSERT INTO route_district_reviews(route_id,district_id,old_boundary_version,new_boundary_version) VALUES($1,$2,$3,$4) RETURNING *',
      [data.routeId, data.districtId, data.oldBoundaryVersion, data.newBoundaryVersion]
    );
  }
  async getReview(id) { return this.one('SELECT * FROM route_district_reviews WHERE id=$1', [id]); }
  async listReviews(status) {
    return status
      ? this.q('SELECT * FROM route_district_reviews WHERE status=$1 ORDER BY id DESC', [status])
      : this.q('SELECT * FROM route_district_reviews ORDER BY id DESC');
  }
  async resolveReview(id, action, actor) {
    return this.one('UPDATE route_district_reviews SET status=$2, decided_by=$3, decided_at=now() WHERE id=$1 RETURNING *', [id, action, actor || 'system']);
  }

  // ---------- 路线迁移 ----------
  async addRouteMigration(fromRouteId, toRouteId, reason, note) {
    return this.one('INSERT INTO route_migrations(from_route_id,to_route_id,reason,note) VALUES($1,$2,$3,$4) RETURNING *', [fromRouteId, toRouteId, reason, note || '']);
  }
  async findRouteMigrations(fromRouteId) {
    return this.q('SELECT * FROM route_migrations WHERE from_route_id=$1 ORDER BY id', [fromRouteId]);
  }
}

module.exports = { PgStore };
