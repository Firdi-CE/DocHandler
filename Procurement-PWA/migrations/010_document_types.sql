-- ==========================================
-- Migration 010: Document types
-- ==========================================
-- First step of generalizing the engine beyond procurement: lets each
-- department define named document types (e.g. "Purchase Request",
-- "Onboarding Form", "Expense Report"), each with its own default
-- approval chain. A type's default chain is NOT auto-applied to new
-- uploads yet -- that wiring is the next phase -- this migration only
-- adds the tables to hold the config.
--
-- An approver on a type's default chain is either a specific person
-- (approver_user_id) or a role within the type's department
-- (approver_role, resolved to whoever currently holds that role at
-- chain-creation time) -- exactly one of the two should be set.

CREATE TABLE IF NOT EXISTS public.document_types (
    id            SERIAL PRIMARY KEY,
    name          VARCHAR(255) NOT NULL,
    department_id INTEGER REFERENCES public.departments(id) ON DELETE SET NULL,
    description   TEXT,
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(name, department_id)
);
CREATE INDEX IF NOT EXISTS idx_document_types_department ON public.document_types (department_id);

-- Default approval chain for a document type -- same shape as
-- approval_chain_steps (migration 006), one row per level.
CREATE TABLE IF NOT EXISTS public.document_type_default_approvers (
    id                SERIAL PRIMARY KEY,
    document_type_id  INTEGER NOT NULL REFERENCES public.document_types(id) ON DELETE CASCADE,
    level             INTEGER NOT NULL,           -- 1-based position in the chain
    approver_role     VARCHAR(50),                -- 'Staff' | 'Supervisor' | 'Manager' | 'Executive' | 'Admin'
    approver_user_id  INTEGER REFERENCES public.users(id) ON DELETE CASCADE,
    created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(document_type_id, level)
);
CREATE INDEX IF NOT EXISTS idx_type_default_approvers_type ON public.document_type_default_approvers (document_type_id);

-- Tag documents with a type. Nullable + SET NULL on delete, same
-- pattern as documents.department_id -- existing documents (and a
-- type being deleted later) never break because of this column.
ALTER TABLE public.documents ADD COLUMN IF NOT EXISTS document_type_id INTEGER REFERENCES public.document_types(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_documents_type ON public.documents (document_type_id);
