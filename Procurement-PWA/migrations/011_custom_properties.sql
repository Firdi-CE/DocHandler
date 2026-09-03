-- ==========================================
-- Migration 011: Custom properties
-- ==========================================
-- Item #1 of the Papra-inspired feature roadmap (PAPRA_FEATURE_ROADMAP.md).
-- Lets departments define typed custom fields (e.g. "Invoice Number",
-- "Contract Expiry Date") that show up on documents of that department --
-- same nullable-department_id-means-global pattern as document_types
-- (migration 010).
--
-- This migration is schema + admin CRUD only (see server.js routes below
-- it and public/admin/custom-properties.html). Wiring actual values into
-- the upload form / document detail view is a deliberately separate
-- follow-up patch -- there's nothing to enter values for until an admin
-- has defined at least one property, so schema+admin-UI has to land first.
--
-- Value storage follows Papra's EAV pattern: one typed column per value
-- type on document_custom_property_values, rather than a single stringly-
-- typed column, so number/date/boolean values stay real numbers/dates/
-- booleans instead of text that needs parsing everywhere they're used.

CREATE TABLE IF NOT EXISTS public.custom_property_definitions (
    id            SERIAL PRIMARY KEY,
    name          VARCHAR(255) NOT NULL,
    key           VARCHAR(100) NOT NULL,   -- slug form of name, stable identifier if name is later edited
    department_id INTEGER REFERENCES public.departments(id) ON DELETE SET NULL,
    description   TEXT,
    type          VARCHAR(20) NOT NULL CHECK (type IN ('text', 'number', 'date', 'boolean', 'select')),
    display_order INTEGER NOT NULL DEFAULT 0,
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(key, department_id)
);
CREATE INDEX IF NOT EXISTS idx_custom_property_definitions_department ON public.custom_property_definitions (department_id);

-- Only populated for type = 'select'. A definition's select options are
-- managed as a set (replace-wholesale), same UX pattern as a document
-- type's default approval chain.
CREATE TABLE IF NOT EXISTS public.custom_property_select_options (
    id                    SERIAL PRIMARY KEY,
    property_definition_id INTEGER NOT NULL REFERENCES public.custom_property_definitions(id) ON DELETE CASCADE,
    value                 VARCHAR(255) NOT NULL,
    display_order         INTEGER NOT NULL DEFAULT 0,
    UNIQUE(property_definition_id, value)
);
CREATE INDEX IF NOT EXISTS idx_custom_property_select_options_definition ON public.custom_property_select_options (property_definition_id);

-- One row per document/property pair. Exactly one of the *_value columns
-- should be set, matching the definition's `type`. Enforced at the
-- application layer (like document_type_default_approvers' exactly-one-of
-- approver_role/approver_user_id), not a DB CHECK -- keeps the migration
-- simple and matches the existing convention in this codebase.
CREATE TABLE IF NOT EXISTS public.document_custom_property_values (
    id                      SERIAL PRIMARY KEY,
    document_id             INTEGER NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
    property_definition_id  INTEGER NOT NULL REFERENCES public.custom_property_definitions(id) ON DELETE CASCADE,
    text_value              TEXT,
    number_value            NUMERIC,
    date_value              DATE,
    boolean_value           BOOLEAN,
    select_option_id        INTEGER REFERENCES public.custom_property_select_options(id) ON DELETE SET NULL,
    created_at              TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at              TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(document_id, property_definition_id)
);
CREATE INDEX IF NOT EXISTS idx_document_custom_property_values_document ON public.document_custom_property_values (document_id);
CREATE INDEX IF NOT EXISTS idx_document_custom_property_values_definition ON public.document_custom_property_values (property_definition_id);
