-- ==========================================
-- Migration 012: Tags
-- ==========================================
-- Item #2 of the Papra-inspired feature roadmap (PAPRA_FEATURE_ROADMAP.md).
-- Simple many-to-many tagging, same shape as Papra's tags.table.ts
-- (tags + documents_tags join table) minus the organization-scoping
-- column, since DocHandler is single-tenant -- tags are global across the
-- whole company rather than admin-defined-per-department like
-- document_types/custom_property_definitions. Unlike those two, tags are
-- deliberately NOT admin-gated to create: any authenticated user can
-- create one inline while tagging a document (find-or-create pattern),
-- matching how lightweight organizational labels are normally used
-- (Gmail labels, Notion tags, etc.) rather than a formal admin-managed
-- taxonomy. Renaming/deleting an existing tag IS admin-gated in
-- server.js, since either action affects every document that already
-- carries that tag.

CREATE TABLE IF NOT EXISTS public.tags (
    id               SERIAL PRIMARY KEY,
    name             VARCHAR(100) NOT NULL,
    normalized_name  VARCHAR(100) NOT NULL UNIQUE, -- lowercased/trimmed, used for find-or-create dedup
    color            VARCHAR(7),                    -- optional hex color, e.g. '#2E6DA4', for the UI chip
    description      TEXT,
    created_by        INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
    created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS public.document_tags (
    document_id  INTEGER NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
    tag_id       INTEGER NOT NULL REFERENCES public.tags(id) ON DELETE CASCADE,
    created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (document_id, tag_id)
);
CREATE INDEX IF NOT EXISTS idx_document_tags_tag ON public.document_tags (tag_id);
