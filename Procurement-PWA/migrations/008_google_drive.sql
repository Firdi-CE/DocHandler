-- ==========================================
-- Migration 008: Google Drive integration
-- ==========================================
-- See BACKLOG.md ("Google Drive integration") and driveService.js.
-- This is a SINGLE shared-account connection (no Google Workspace for the
-- office yet), not per-user OAuth -- one Google account is connected once
-- by an admin, and every Drive operation in the app runs as that account.

-- Single-row settings table for the one shared Drive connection.
CREATE TABLE IF NOT EXISTS public.integration_settings (
    id                        INTEGER PRIMARY KEY DEFAULT 1,
    google_refresh_token      TEXT,
    google_connected_email    VARCHAR(255),
    google_connected_by       INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
    google_connected_at       TIMESTAMP,
    google_backup_folder_id   TEXT,
    google_backup_folder_name VARCHAR(255),
    updated_at                TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT integration_settings_singleton CHECK (id = 1)
);
INSERT INTO public.integration_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- documents: link a document to a Drive copy. At most one of these two
-- should ever be set per document (a doc is either a local upload
-- optionally mirrored to Drive, or entirely sourced FROM Drive -- never
-- both):
--   drive_backup_id      - set once a locally-uploaded file has been
--                          best-effort mirrored to the backup folder.
--                          NULL until/unless the backup succeeds; a failed
--                          or not-yet-run backup never blocks the upload
--                          itself.
--   drive_attachment_id  - set when the document itself IS a Drive file
--                          the user attached instead of uploading one --
--                          there is no local copy on disk for these, and
--                          download/stream must fetch from Drive instead.
ALTER TABLE public.documents ADD COLUMN IF NOT EXISTS drive_backup_id VARCHAR(255);
ALTER TABLE public.documents ADD COLUMN IF NOT EXISTS drive_attachment_id VARCHAR(255);
ALTER TABLE public.documents ADD COLUMN IF NOT EXISTS drive_web_link TEXT;
