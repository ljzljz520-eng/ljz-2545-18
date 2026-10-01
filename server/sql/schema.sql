-- =============================================================
-- 街区章节 · PostgreSQL 结构
-- 储存：发布版（chapter_publications）、别名（chapter_aliases）、
--       迁移关系（chapter_migrations / route_migrations）
-- 关键决策：路线 ↔ 街区 使用独立关联表 route_districts（多对多），
--           不在 routes 上存单一 district_id —— 路线可跨多个街区，
--           不强制唯一父节点；章节自身才是树，移动时检查层级循环。
-- =============================================================

BEGIN;

-- ---------- 街区 ----------
CREATE TABLE IF NOT EXISTS districts (
    id               TEXT PRIMARY KEY,
    slug             TEXT NOT NULL UNIQUE,
    name             TEXT NOT NULL,
    summary          TEXT NOT NULL DEFAULT '',
    history          TEXT NOT NULL DEFAULT '',      -- 历史背景
    theme            TEXT NOT NULL DEFAULT 'history',
    status           TEXT NOT NULL DEFAULT 'published'
                     CHECK (status IN ('draft','published','withdrawn')),
    boundary_version INTEGER NOT NULL DEFAULT 1,    -- 边界版本：修改即 +1
    boundary         JSONB,                          -- 多边形坐标
    center_lng       DOUBLE PRECISION,
    center_lat       DOUBLE PRECISION,
    version          INTEGER NOT NULL DEFAULT 1,     -- 乐观锁
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- 章节（树：唯一父节点，循环检查在服务层） ----------
CREATE TABLE IF NOT EXISTS chapters (
    id                 TEXT PRIMARY KEY,
    district_id        TEXT NOT NULL REFERENCES districts(id),
    parent_id          TEXT REFERENCES chapters(id),   -- NULL = 根章节
    slug               TEXT NOT NULL,
    title              TEXT NOT NULL,
    summary            TEXT NOT NULL DEFAULT '',
    history_background TEXT NOT NULL DEFAULT '',       -- 历史背景
    sort_order         INTEGER NOT NULL DEFAULT 0,
    status             TEXT NOT NULL DEFAULT 'draft'
                       CHECK (status IN ('draft','published','withdrawn')),
    version            INTEGER NOT NULL DEFAULT 1,     -- 乐观锁（并发移动）
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (district_id, slug)
);
CREATE INDEX IF NOT EXISTS chapters_parent_idx ON chapters(parent_id);
CREATE INDEX IF NOT EXISTS chapters_district_idx ON chapters(district_id);

-- ---------- 章节发布版（PG 储存发布版快照） ----------
CREATE TABLE IF NOT EXISTS chapter_publications (
    id           BIGSERIAL PRIMARY KEY,
    chapter_id   TEXT NOT NULL REFERENCES chapters(id),
    version      INTEGER NOT NULL,              -- 对应 chapters.version 的发布快照
    payload      JSONB NOT NULL,                -- 发布时内容快照
    published_by TEXT NOT NULL DEFAULT 'system',
    published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (chapter_id, version)
);

-- ---------- 章节别名（旧 slug 仍可解析，深链接不丢） ----------
CREATE TABLE IF NOT EXISTS chapter_aliases (
    alias      TEXT PRIMARY KEY,
    chapter_id TEXT NOT NULL REFERENCES chapters(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- 章节迁移关系（移动/合并/拆分后的确定指向） ----------
CREATE TABLE IF NOT EXISTS chapter_migrations (
    id             BIGSERIAL PRIMARY KEY,
    from_chapter_id TEXT NOT NULL,
    to_chapter_id   TEXT NOT NULL,
    reason          TEXT NOT NULL CHECK (reason IN ('move','merge','split','withdraw')),
    note            TEXT NOT NULL DEFAULT '',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chapter_migrations_from_idx ON chapter_migrations(from_chapter_id);

-- ---------- 停留点 ----------
CREATE TABLE IF NOT EXISTS stops (
    id          TEXT PRIMARY KEY,
    chapter_id  TEXT NOT NULL REFERENCES chapters(id),
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    lng         DOUBLE PRECISION,
    lat         DOUBLE PRECISION,
    sort_order  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS stops_chapter_idx ON stops(chapter_id);

-- ---------- 路线 ----------
CREATE TABLE IF NOT EXISTS routes (
    id                TEXT PRIMARY KEY,
    slug              TEXT NOT NULL UNIQUE,
    title             TEXT NOT NULL,
    summary           TEXT NOT NULL DEFAULT '',
    status            TEXT NOT NULL DEFAULT 'published'
                      CHECK (status IN ('draft','published','withdrawn','split')),
    fallback_route_id TEXT REFERENCES routes(id),   -- 撤回后的替代指向
    version           INTEGER NOT NULL DEFAULT 1,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- 路线途经停留点（有序） ----------
CREATE TABLE IF NOT EXISTS route_stops (
    route_id TEXT NOT NULL REFERENCES routes(id),
    stop_id  TEXT NOT NULL REFERENCES stops(id),
    seq      INTEGER NOT NULL,
    PRIMARY KEY (route_id, stop_id)
);

-- ---------- 路线 ↔ 街区 独立关联表 ----------
-- 落实：主要展示入口（role=primary，每条路线至多一个）、
--       次要入口（role=secondary）、撤回后的替代指向（fallback_route_id）、
--       边界修改后的复核标记（needs_review）。
CREATE TABLE IF NOT EXISTS route_districts (
    route_id          TEXT NOT NULL REFERENCES routes(id),
    district_id       TEXT NOT NULL REFERENCES districts(id),
    role              TEXT NOT NULL DEFAULT 'secondary'
                      CHECK (role IN ('primary','secondary')),
    entry_note        TEXT NOT NULL DEFAULT '',
    fallback_route_id TEXT REFERENCES routes(id),
    needs_review      BOOLEAN NOT NULL DEFAULT FALSE,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (route_id, district_id)
);
-- 每条路线至多一个主要展示入口
CREATE UNIQUE INDEX IF NOT EXISTS route_districts_one_primary
    ON route_districts(route_id) WHERE role = 'primary';
CREATE INDEX IF NOT EXISTS route_districts_district_idx ON route_districts(district_id);

-- ---------- 边界修改后的复核队列 ----------
-- 街区边界修改后，关联需要复核，而不是按旧中心点永远继承。
CREATE TABLE IF NOT EXISTS route_district_reviews (
    id                   BIGSERIAL PRIMARY KEY,
    route_id             TEXT NOT NULL REFERENCES routes(id),
    district_id          TEXT NOT NULL REFERENCES districts(id),
    old_boundary_version INTEGER NOT NULL,
    new_boundary_version INTEGER NOT NULL,
    status               TEXT NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending','confirmed','removed')),
    decided_by           TEXT,
    decided_at           TIMESTAMPTZ,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reviews_status_idx ON route_district_reviews(status);

-- ---------- 路线迁移关系（跨区拆分等） ----------
CREATE TABLE IF NOT EXISTS route_migrations (
    id            BIGSERIAL PRIMARY KEY,
    from_route_id TEXT NOT NULL,
    to_route_id   TEXT NOT NULL,
    reason        TEXT NOT NULL CHECK (reason IN ('split','merge','withdraw')),
    note          TEXT NOT NULL DEFAULT '',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS route_migrations_from_idx ON route_migrations(from_route_id);

COMMIT;
