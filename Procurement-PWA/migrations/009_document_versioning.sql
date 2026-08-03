-- ==========================================
-- Migration 009: Document versioning
-- ==========================================
-- See BACKLOG.md ("Document versioning"). Lets a rejected document be
-- corrected and resubmitted as a new version of the same document, rather
-- than becoming a disconnected new upload.
--
-- version_group_id points at the ORIGINAL document in a version chain
-- (self-referencing). NULL means "I am my own root" -- app code treats
-- COALESCE(version_group_id, id) as the group key throughout, so existing
-- rows and every non-resubmitted upload never need this column touched.
-- version_number is 1 for every document until it's superseded by a
-- resubmission, at which point the new row gets the next number in the
-- group.
ALTER TABLE public.documents ADD COLUMN IF NOT EXISTS version_group_id INTEGER REFERENCES public.documents(id) ON DELETE SET NULL;
ALTER TABLE public.documents ADD COLUMN IF NOT EXISTS version_number INTEGER NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_documents_version_group ON public.documents (version_group_id);

-- ------------------------------------------------------------------
-- Unrelated small cleanup, found while wiring up the Google Drive
-- integration: migration 002 added drive_file_id/drive_view_link/file_type
-- to documents, but nothing in the codebase ever read or wrote them --
-- they predate migration 008's drive_backup_id/drive_attachment_id/
-- drive_web_link, which replaced them with a real (and more precise)
-- design. Confirmed unused via a full grep of server.js and public/ before
-- dropping. Safe to skip this block if you'd rather keep them around.
-- ------------------------------------------------------------------
ALTER TABLE public.documents DROP COLUMN IF EXISTS drive_file_id;
ALTER TABLE public.documents DROP COLUMN IF EXISTS drive_view_link;
ALTER TABLE public.documents DROP COLUMN IF EXISTS file_type;
