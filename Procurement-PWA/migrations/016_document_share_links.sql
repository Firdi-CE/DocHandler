-- ==========================================
-- Migration 016: Document Share Links
-- ==========================================
-- Item #6 of the Papra-inspired feature roadmap (PAPRA_FEATURE_ROADMAP.md).
-- Token-based public links, same shape as Papra's
-- document-share-links.table.ts: optional expiry, optional password,
-- an enabled flag, and last-accessed tracking.
--
-- Password hashing uses Node's built-in crypto.scrypt (see server.js)
-- rather than adding bcrypt as a new dependency purely for this one
-- feature -- this codebase has no existing password-hashing pattern to
-- match (auth is Google OAuth only, no local passwords anywhere), so
-- there was no existing convention to follow either way.

CREATE TABLE IF NOT EXISTS public.document_share_links (
    id               SERIAL PRIMARY KEY,
    document_id      INTEGER NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
    token            VARCHAR(64) NOT NULL UNIQUE,
    password_hash    TEXT,     -- NULL = no password required
    password_salt    TEXT,     -- NULL iff password_hash is NULL
    expires_at       TIMESTAMP, -- NULL = never expires
    is_enabled       BOOLEAN NOT NULL DEFAULT TRUE,
    access_count     INTEGER NOT NULL DEFAULT 0,
    last_accessed_at TIMESTAMP,
    created_by       INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
    created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_document_share_links_document ON public.document_share_links (document_id);
