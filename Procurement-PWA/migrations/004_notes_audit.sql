-- ==========================================
-- Migration 004: Approval notes + audit trail
-- ==========================================

-- Req 2: Executive can attach a note when approving/rejecting
-- Run this manually in DBeaver if the documents table already existed
-- before this migration was written (ALTER TABLE is a no-op if the
-- column already exists, so it is safe to run more than once).
ALTER TABLE public.documents ADD COLUMN IF NOT EXISTS notes TEXT;

-- Req 6: Lean audit trail for state-changing events
CREATE TABLE IF NOT EXISTS public.audit_logs (
    id          SERIAL PRIMARY KEY,
    user_id     INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
    action_type VARCHAR(100) NOT NULL,  -- e.g. 'DOCUMENT_UPLOAD', 'STATUS_CHANGE'
    entity_id   INTEGER,                -- document id (or other entity in the future)
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON public.audit_logs (entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_user   ON public.audit_logs (user_id);
