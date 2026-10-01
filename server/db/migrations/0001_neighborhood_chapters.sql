-- ============================================================================
-- 街区章节：发布版 / 别名 / 迁移关系 / 路线多对多关联 / 边界复核
-- 0001_neighborhood_chapters.sql
--
-- 设计要点：
-- 1. 章节树用 parent_id 表达层级；层级循环只在“章节自身”上检查（触发器 +
--    服务层双保险），路线与街区是多对多，绝不强制唯一父节点。
-- 2. 路线不存单一街区外键；route_neighborhood 关联表带主次标记与状态。
-- 3. chapter_revision 存发布版（草稿改在 chapter 行上，发布时生成不可变版本）。
-- 4. chapter_alias / chapter_migration 存别名与迁移关系，供深链接 301/302。
-- 5. 街区边界修改只产生“待复核”标记，不按旧中心点永久继承。
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 枚举
-- ---------------------------------------------------------------------------
CREATE TYPE chapter_kind        AS ENUM ('neighborhood', 'section');
CREATE TYPE chapter_status      AS ENUM ('draft', 'published', 'withdrawn');
CREATE TYPE migration_kind      AS ENUM ('move', 'merge', 'split');
CREATE TYPE entry_role          AS ENUM ('primary', 'secondary');
CREATE TYPE association_state   AS ENUM ('active', 'review_pending', 'rejected', 'detached');
CREATE TYPE review_decision     AS ENUM ('keep', 'reattach', 'detach');
CREATE TYPE route_status        AS ENUM ('draft', 'published', 'withdrawn');

-- ---------------------------------------------------------------------------
-- 章节（街区是 kind = 'neighborhood' 的章节；section 是其下的普通章节）
-- ---------------------------------------------------------------------------
CREATE TABLE chapter (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    kind            chapter_kind   NOT NULL,
    slug            TEXT           NOT NULL,
    parent_id       BIGINT        REFERENCES chapter(id) ON DELETE RESTRICT,
    title           TEXT           NOT NULL,
    status          chapter_status NOT NULL DEFAULT 'draft',
    summary         TEXT,
    history_body    TEXT,                       -- 历史背景正文
    -- 版本号用于乐观锁：两个编辑同时移动章节时后写者必须重试
    tree_version    BIGINT         NOT NULL DEFAULT 1,
    current_revision_id BIGINT,                -- -> chapter_revision.id，发布后回填
    created_by      BIGINT,
    created_at      TIMESTAMPTZ    NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ    NOT NULL DEFAULT now(),
    CONSTRAINT chapter_slug_under_parent UNIQUE (parent_id, slug)
);

-- 仅在已发布兄弟之间要求 slug 唯一（草稿之间可重名，发布时再裁决）
CREATE UNIQUE INDEX chapter_published_slug_uidx
    ON chapter (COALESCE(parent_id, 0), slug)
    WHERE status = 'published';

-- ---------------------------------------------------------------------------
-- 发布版本：不可变快照，面包屑与路线入口始终按版本一致性渲染
-- ---------------------------------------------------------------------------
CREATE TABLE chapter_revision (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    chapter_id      BIGINT         NOT NULL REFERENCES chapter(id) ON DELETE CASCADE,
    revision_no     INT            NOT NULL,
    title           TEXT           NOT NULL,
    summary         TEXT,
    history_body    TEXT,
    tree_path       BIGINT[]       NOT NULL,   -- 发布时刻的祖先 id 链
    published_by    BIGINT,
    published_at    TIMESTAMPTZ    NOT NULL DEFAULT now(),
    UNIQUE (chapter_id, revision_no)
);

ALTER TABLE chapter
    ADD CONSTRAINT chapter_current_rev_fk
    FOREIGN KEY (current_revision_id) REFERENCES chapter_revision(id) DEFERRABLE;

-- ---------------------------------------------------------------------------
-- 别名：深链接没有历史记录也能解析到确定入口
-- ---------------------------------------------------------------------------
CREATE TABLE chapter_alias (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    chapter_id      BIGINT         NOT NULL REFERENCES chapter(id) ON DELETE CASCADE,
    alias_slug      TEXT           NOT NULL,
    created_at      TIMESTAMPTZ    NOT NULL DEFAULT now(),
    UNIQUE (chapter_id, alias_slug)
);
-- 别名全局唯一；解析命中已撤回章节时返回 410 + 替代指向，不静默改派
CREATE UNIQUE INDEX chapter_alias_slug_uidx ON chapter_alias (alias_slug);

-- ---------------------------------------------------------------------------
-- 章节迁移关系：移动 / 合并 / 拆分（不覆盖旧别名，给出确定的重定向目标）
-- ---------------------------------------------------------------------------
CREATE TABLE chapter_migration (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    kind            migration_kind NOT NULL,
    from_chapter_id BIGINT        REFERENCES chapter(id) ON DELETE SET NULL,
    to_chapter_id   BIGINT        REFERENCES chapter(id) ON DELETE SET NULL,
    reason          TEXT,
    created_at      TIMESTAMPTZ    NOT NULL DEFAULT now()
);
CREATE INDEX chapter_migration_from_idx ON chapter_migration (from_chapter_id);

-- ---------------------------------------------------------------------------
-- 层级循环检查：只作用于章节树自身（递归 CTE 沿 parent_id 向上走）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION chapter_assert_no_cycle() RETURNS trigger AS $$
BEGIN
    IF NEW.parent_id IS NOT NULL THEN
        IF EXISTS (
            WITH RECURSIVE ancestors AS (
                SELECT id, parent_id FROM chapter WHERE id = NEW.parent_id
                UNION ALL
                SELECT c.id, c.parent_id
                FROM chapter c JOIN ancestors a ON c.id = a.parent_id
            )
            SELECT 1 FROM ancestors WHERE id = NEW.id
        ) THEN
            RAISE EXCEPTION 'chapter cycle detected: chapter % cannot be moved under %',
                NEW.id, NEW.parent_id
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    NEW.tree_version := OLD.tree_version + 1;
    NEW.updated_at := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER chapter_tree_guard
    BEFORE UPDATE OF parent_id ON chapter
    FOR EACH ROW
    WHEN (OLD.parent_id IS DISTINCT FROM NEW.parent_id)
    EXECUTE FUNCTION chapter_assert_no_cycle();

-- ---------------------------------------------------------------------------
-- 街区（街区本身也是章节，承载历史背景；边界为 GeoJSON，中心点仅用于展示）
-- ---------------------------------------------------------------------------
CREATE TABLE neighborhood (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    chapter_id      BIGINT         NOT NULL UNIQUE REFERENCES chapter(id) ON DELETE RESTRICT,
    boundary        JSONB,                        -- GeoJSON Polygon/MultiPolygon
    center_lng      DOUBLE PRECISION,
    center_lat      DOUBLE PRECISION,
    boundary_version BIGINT        NOT NULL DEFAULT 1,
    created_at      TIMESTAMPTZ    NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 停留点：隶属街区（从街区页进入），历史介绍独立维护
-- ---------------------------------------------------------------------------
CREATE TABLE stop (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    neighborhood_id BIGINT         NOT NULL REFERENCES neighborhood(id) ON DELETE RESTRICT,
    slug            TEXT           NOT NULL,
    title           TEXT           NOT NULL,
    description     TEXT,
    lng             DOUBLE PRECISION,
    lat             DOUBLE PRECISION,
    sort_order      INT            NOT NULL DEFAULT 0,
    status          chapter_status NOT NULL DEFAULT 'draft',
    created_at      TIMESTAMPTZ    NOT NULL DEFAULT now(),
    UNIQUE (neighborhood_id, slug)
);

-- ---------------------------------------------------------------------------
-- 路线：只存自身元数据与状态，不存“所属街区”单一外键
-- ---------------------------------------------------------------------------
CREATE TABLE route (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    slug            TEXT           NOT NULL UNIQUE,
    title           TEXT           NOT NULL,
    status          route_status   NOT NULL DEFAULT 'draft',
    -- 撤回后的替代指向：迁移到新路线 / 退回街区 / 无（返回 410）
    fallback_route_id BIGINT       REFERENCES route(id) ON DELETE SET NULL,
    fallback_chapter_id BIGINT     REFERENCES chapter(id) ON DELETE SET NULL,
    withdrawn_at    TIMESTAMPTZ,
    created_by      BIGINT,
    created_at      TIMESTAMPTZ    NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ    NOT NULL DEFAULT now(),
    CONSTRAINT route_fallback_target_chk CHECK (
        fallback_route_id IS DISTINCT FROM id
    )
);

-- ---------------------------------------------------------------------------
-- 路线 ↔ 街区：独立关联表（多对多）
--   role=primary 主要展示入口；role=secondary 次要入口（跨区路线）
--   state：街区边界修改后关联进入 review_pending，复核前不再自动继承
-- ---------------------------------------------------------------------------
CREATE TABLE route_neighborhood (
    id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    route_id          BIGINT       NOT NULL REFERENCES route(id) ON DELETE CASCADE,
    neighborhood_id   BIGINT       NOT NULL REFERENCES neighborhood(id) ON DELETE RESTRICT,
    role              entry_role   NOT NULL DEFAULT 'secondary',
    state             association_state NOT NULL DEFAULT 'active',
    -- 复核期间的候选改派；确认后才真正改写 neighborhood_id
    pending_neighborhood_id BIGINT REFERENCES neighborhood(id) ON DELETE SET NULL,
    sort_order        INT          NOT NULL DEFAULT 0,
    created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
    UNIQUE (route_id, neighborhood_id)
);
-- 每条已发布路线至多一个 active 的主要入口（候选必须在发布前唯一确定）
CREATE UNIQUE INDEX route_one_active_primary_uidx
    ON route_neighborhood (route_id)
    WHERE role = 'primary' AND state = 'active';

-- ---------------------------------------------------------------------------
-- 边界复核记录
-- ---------------------------------------------------------------------------
CREATE TABLE boundary_review (
    id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    neighborhood_id   BIGINT       NOT NULL REFERENCES neighborhood(id) ON DELETE CASCADE,
    route_id          BIGINT       NOT NULL REFERENCES route(id) ON DELETE CASCADE,
    association_id    BIGINT       NOT NULL REFERENCES route_neighborhood(id) ON DELETE CASCADE,
    old_boundary      JSONB,
    new_boundary      JSONB,
    decision          review_decision,
    decided_by        BIGINT,
    decided_at        TIMESTAMPTZ,
    created_at        TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 路线迁移关系（跨区路线拆分后，旧路线给出确定替代）
-- ---------------------------------------------------------------------------
CREATE TABLE route_migration (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    kind            migration_kind NOT NULL DEFAULT 'split',
    from_route_id   BIGINT        REFERENCES route(id) ON DELETE SET NULL,
    to_route_id     BIGINT        REFERENCES route(id) ON DELETE SET NULL,
    reason          TEXT,
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT now()
);
CREATE INDEX route_migration_from_idx ON route_migration (from_route_id);

-- ---------------------------------------------------------------------------
-- 边界修改触发器：不删除、不改派关联，仅置 review_pending 等待人工复核
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION neighborhood_flag_reviews() RETURNS trigger AS $$
BEGIN
    IF OLD.boundary IS DISTINCT FROM NEW.boundary THEN
        NEW.boundary_version := OLD.boundary_version + 1;

        INSERT INTO boundary_review (neighborhood_id, route_id, association_id,
                                     old_boundary, new_boundary)
        SELECT NEW.id, rn.route_id, rn.id, OLD.boundary, NEW.boundary
        FROM route_neighborhood rn
        WHERE rn.neighborhood_id = NEW.id AND rn.state = 'active';

        UPDATE route_neighborhood
        SET state = 'review_pending', updated_at = now()
        WHERE neighborhood_id = NEW.id AND state = 'active';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER neighborhood_boundary_guard
    BEFORE UPDATE OF boundary ON neighborhood
    FOR EACH ROW EXECUTE FUNCTION neighborhood_flag_reviews();

-- ---------------------------------------------------------------------------
-- 已发布路线入口解析：主要入口 / 次要入口 / 撤回替代 / 410
-- 未公开章节（draft / withdrawn）不会出现在结果中——权限过滤在 SQL 内兜底
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION resolve_public_route_entry(p_route_slug TEXT)
RETURNS TABLE (
    route_id        BIGINT,
    route_status    route_status,
    entry_kind      TEXT,                 -- primary | secondary | redirect | gone
    chapter_id      BIGINT,
    chapter_title   TEXT,
    neighborhood_id BIGINT,
    role            entry_role,
    target_route_id BIGINT
) AS $$
DECLARE
    v_route route%ROWTYPE;
    v_assoc route_neighborhood%ROWTYPE;
BEGIN
    SELECT * INTO v_route FROM route WHERE slug = p_route_slug;
    IF NOT FOUND THEN
        RETURN;
    END IF;

    IF v_route.status = 'published' THEN
        -- 主要入口优先；主要入口处于待复核时，回落第一个可用次要入口（确定性排序）
        SELECT rn.* INTO v_assoc
        FROM route_neighborhood rn
        JOIN neighborhood n ON n.id = rn.neighborhood_id
        JOIN chapter c      ON c.id = n.chapter_id AND c.status = 'published'
        WHERE rn.route_id = v_route.id AND rn.state = 'active'
        ORDER BY CASE rn.role WHEN 'primary' THEN 0 ELSE 1 END,
                 rn.sort_order, rn.id
        LIMIT 1;

        IF FOUND THEN
            RETURN QUERY
            SELECT v_route.id, v_route.status,
                   CASE WHEN v_assoc.role = 'primary' THEN 'primary' ELSE 'secondary' END,
                   c.id, c.title, n.id, v_assoc.role, NULL::BIGINT
            FROM neighborhood n JOIN chapter c ON c.id = n.chapter_id
            WHERE n.id = v_assoc.neighborhood_id;
            RETURN;
        END IF;

        -- 已发布但无可用关联（例如主要入口正待复核）：显式无入口，不静默猜测
        RETURN QUERY SELECT v_route.id, v_route.status, 'gone',
                            NULL::BIGINT, NULL, NULL::BIGINT, NULL::entry_role, NULL::BIGINT;
        RETURN;
    END IF;

    IF v_route.status = 'withdrawn' THEN
        -- 撤回后的替代指向：新路线 > 章节；都没有则 410
        IF v_route.fallback_route_id IS NOT NULL THEN
            RETURN QUERY SELECT v_route.id, v_route.status, 'redirect',
                                NULL::BIGINT, NULL, NULL::BIGINT, NULL::entry_role,
                                v_route.fallback_route_id;
        ELSIF v_route.fallback_chapter_id IS NOT NULL
              AND EXISTS (SELECT 1 FROM chapter
                          WHERE id = v_route.fallback_chapter_id AND status = 'published') THEN
            RETURN QUERY
            SELECT v_route.id, v_route.status, 'redirect', c.id, c.title,
                   n.id, NULL::entry_role, NULL::BIGINT
            FROM chapter c
            LEFT JOIN neighborhood n ON n.chapter_id = c.id
            WHERE c.id = v_route.fallback_chapter_id;
        ELSE
            RETURN QUERY SELECT v_route.id, v_route.status, 'gone',
                                NULL::BIGINT, NULL, NULL::BIGINT, NULL::entry_role, NULL::BIGINT;
        END IF;
        RETURN;
    END IF;

    -- draft 路线：公开解析一律 404，不暴露其存在
    RETURN;
END;
$$ LANGUAGE plpgsql STABLE;

COMMIT;
