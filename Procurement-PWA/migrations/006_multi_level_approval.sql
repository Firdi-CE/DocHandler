-- ==========================================
-- Migration 006: Multi-level approval chains
-- ==========================================
-- Lets a sender/admin define an ordered list of specific approvers per
-- document. Each level must approve before the next is activated.
-- A rejection at level N (N>1) sends the document back to level N-1 for
-- re-review rather than killing the whole chain; a rejection at level 1
-- has no "previous" level, so it finalizes the document as rejected.

-- Tracks the live/current state of each step in a document's chain.
CREATE TABLE IF NOT EXISTS public.approval_chain_steps (
    id           SERIAL PRIMARY KEY,
    document_id  INTEGER NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
    level        INTEGER NOT NULL,                 -- 1-based position in the chain
    approver_id  INTEGER NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    status       VARCHAR(20) NOT NULL DEFAULT 'waiting', -- waiting | pending | approved | rejected
    comments     TEXT,
    decided_at   TIMESTAMP,
    created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(document_id, level)
);
CREATE INDEX IF NOT EXISTS idx_chain_steps_document ON public.approval_chain_steps (document_id);

-- Where the document currently sits in its chain (1 = first level).
ALTER TABLE public.documents ADD COLUMN IF NOT EXISTS current_level INTEGER DEFAULT 1;

-- Repurpose the existing (previously unused) `approvals` table as an
-- append-only history log: one row per decision, in order, even across
-- revision cycles where the same level is decided more than once.
ALTER TABLE public.approvals ADD COLUMN IF NOT EXISTS level INTEGER;
ALTER TABLE public.approvals ADD COLUMN IF NOT EXISTS action VARCHAR(20);
CREATE INDEX IF NOT EXISTS idx_approvals_document ON public.approvals (document_id);
