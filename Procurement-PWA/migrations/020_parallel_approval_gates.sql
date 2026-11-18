-- ==========================================
-- Migration 020: Parallel approval gates
-- ==========================================
-- Until now a chain level held exactly ONE approver (UNIQUE(document_id,
-- level) on approval_chain_steps, UNIQUE(document_type_id, level) on
-- document_type_default_approvers). This migration lets a level hold
-- SEVERAL approvers -- a "gate".
--
-- Semantics (enforced in server.js, not in SQL):
--   * A level with one row behaves exactly as before.
--   * A level with 2+ rows is a parallel gate: every approver on it is
--     activated at the same time, they can decide in any order, and the
--     chain only advances once ALL of them have approved.
--   * A rejection by ANY approver on a gate finalizes the document as
--     'rejected' (back to the requester, who revises it as a new version
--     via the existing resubmit flow). The other approvers on the gate
--     are un-activated.
--
-- Safe to re-run (IF EXISTS / IF NOT EXISTS throughout). Existing rows
-- are untouched: every existing level has one row, so the new, looser
-- uniqueness rules are trivially satisfied.

-- 1. approval_chain_steps: one row per (document, level, approver).
ALTER TABLE public.approval_chain_steps
    DROP CONSTRAINT IF EXISTS approval_chain_steps_document_id_level_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_chain_steps_doc_level_approver
    ON public.approval_chain_steps (document_id, level, approver_id);

-- 2. document_type_default_approvers: a level may list several approvers
--    (each a role or a specific person). COALESCE because approver_role /
--    approver_user_id are mutually exclusive and one of them is always NULL.
ALTER TABLE public.document_type_default_approvers
    DROP CONSTRAINT IF EXISTS document_type_default_approvers_document_type_id_level_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_type_default_approvers_level_member
    ON public.document_type_default_approvers
        (document_type_id, level, COALESCE(approver_user_id, 0), COALESCE(approver_role, ''));
