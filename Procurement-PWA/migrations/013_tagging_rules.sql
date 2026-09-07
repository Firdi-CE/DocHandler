-- ==========================================
-- Migration 013: Tagging Rules
-- ==========================================
-- Item #3 of the Papra-inspired feature roadmap (PAPRA_FEATURE_ROADMAP.md).
-- Depends on Tags (migration 012). Mirrors Papra's tagging-rules.tables.ts
-- shape (a rule has a match mode + a list of conditions + a list of
-- actions) but with a deliberately smaller condition field set than
-- Papra's for this first pass: filename (contains), department, project,
-- site. Custom-property-based conditions were flagged as a nice-to-have
-- in the roadmap, not a requirement -- can be added as a new `field`
-- value later without a schema change (conditions are already a generic
-- field/operator/value row).

CREATE TABLE IF NOT EXISTS public.tagging_rules (
    id           SERIAL PRIMARY KEY,
    name         VARCHAR(255) NOT NULL,
    description  TEXT,
    match_mode   VARCHAR(10) NOT NULL DEFAULT 'all' CHECK (match_mode IN ('all', 'any')),
    is_active    BOOLEAN NOT NULL DEFAULT TRUE,
    created_by   INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
    created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS public.tagging_rule_conditions (
    id        SERIAL PRIMARY KEY,
    rule_id   INTEGER NOT NULL REFERENCES public.tagging_rules(id) ON DELETE CASCADE,
    field     VARCHAR(30) NOT NULL CHECK (field IN ('filename', 'department_id', 'project_id', 'site_id')),
    operator  VARCHAR(20) NOT NULL CHECK (operator IN ('contains', 'equals')),
    value     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tagging_rule_conditions_rule ON public.tagging_rule_conditions (rule_id);

CREATE TABLE IF NOT EXISTS public.tagging_rule_actions (
    id       SERIAL PRIMARY KEY,
    rule_id  INTEGER NOT NULL REFERENCES public.tagging_rules(id) ON DELETE CASCADE,
    tag_id   INTEGER NOT NULL REFERENCES public.tags(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_tagging_rule_actions_rule ON public.tagging_rule_actions (rule_id);
