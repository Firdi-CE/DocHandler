-- ==========================================
-- Migration 017: Ingestion Folders
-- ==========================================
-- Item #7 of the Papra-inspired feature roadmap (PAPRA_FEATURE_ROADMAP.md).
-- Watches a local folder and auto-creates a document for each new file
-- that shows up, using pre-configured defaults instead of an interactive
-- upload form.
--
-- Papra uses chokidar (a filesystem-event watcher) + a bounded-concurrency
-- queue. This implementation deliberately uses simple interval polling
-- instead -- chokidar's current major version is ESM-only and would break
-- `require()` in this CommonJS codebase (confirmed by actually installing
-- it and inspecting its package.json, not assumed), and pinning to its
-- last CJS-compatible major version means inheriting years-old bugs for a
-- feature an internal tool doesn't need real-time responsiveness from.
-- Polling every 15s is more than adequate for "someone dropped a file in
-- a folder" and needs zero new dependencies. See ingestionWatcher.js.
--
-- recipient_id is required (a document needs an inbox to land in, same
-- as a normal upload); sender_id defaults to whoever configured the
-- folder if not set explicitly. project_id/site_id/document_type_id are
-- all optional, same as a manual upload.

CREATE TABLE IF NOT EXISTS public.ingestion_folders (
    id                SERIAL PRIMARY KEY,
    name              VARCHAR(255) NOT NULL,
    watch_path        TEXT NOT NULL,
    glob_pattern      VARCHAR(255) NOT NULL DEFAULT '*', -- simple * / ? wildcard matching, not a full glob library -- see ingestionWatcher.js
    sender_id         INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
    recipient_id      INTEGER NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    department_id     INTEGER REFERENCES public.departments(id) ON DELETE SET NULL,
    project_id        INTEGER REFERENCES public.projects(id) ON DELETE SET NULL,
    site_id           INTEGER REFERENCES public.work_sites(id) ON DELETE SET NULL,
    document_type_id  INTEGER REFERENCES public.document_types(id) ON DELETE SET NULL,
    is_active         BOOLEAN NOT NULL DEFAULT TRUE,
    last_scanned_at   TIMESTAMP,
    created_by        INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
    created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
