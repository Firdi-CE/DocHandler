-- ==========================================
-- Migration 021: Requisitions + configurable document numbering
-- ==========================================
-- Backs the Engineering "Requisition" stage -- the entry point of the
-- whiteboard workflow (Engineering -> Procurement as a Material
-- Request/MTO, referencing D/SLD spec + MTO, looping back on rejection).
--
-- Unlike PO/RFQ (migration 018), a Requisition is filled in as
-- structured data by Engineering rather than starting from an uploaded
-- file. To keep reusing the existing documents/approval-chain engine
-- (inbox, approve/reject, resubmit-as-new-version) without touching the
-- generic /upload route's file-required behavior, the Requisition's
-- `documents` row carries a synthetic filename (e.g. "Material
-- Requisition REQ-2026-0007") and a NULL file_path -- the
-- /documents/:id/stream route already answers a missing physical file
-- with a 404, so nothing needs to change there.
-- Supporting evidence (spec sheets, drawings) attaches separately via
-- requisition_attachments below; those ARE real files, but they're
-- evidence carried alongside the requisition, not independently
-- approved documents of their own.
--
-- Also introduces document_number_sequences: a generic, admin-
-- configurable numbering pattern keyed by document_type (not
-- requisition-specific), so the numbering format can be changed later
-- without a code change. Reusable for PO/RFQ numbering too.
--
-- Safe to re-run (IF NOT EXISTS / ON CONFLICT throughout).

CREATE TABLE IF NOT EXISTS public.document_number_sequences (
    id                SERIAL PRIMARY KEY,
    document_type_id  INTEGER NOT NULL UNIQUE REFERENCES public.document_types(id) ON DELETE CASCADE,
    pattern           VARCHAR(100) NOT NULL DEFAULT '{PREFIX}-{YYYY}-{seq:04d}',
    prefix            VARCHAR(20) NOT NULL DEFAULT '',
    next_seq          INTEGER NOT NULL DEFAULT 1,
    reset_period      VARCHAR(10) NOT NULL DEFAULT 'yearly' CHECK (reset_period IN ('never', 'yearly', 'monthly')),
    last_reset_year   INTEGER,
    last_reset_month  INTEGER,
    updated_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
-- Placeholders supported in `pattern`: {PREFIX}, {YYYY}, {YY}, {MM},
-- {seq} or {seq:0Nd} for zero-padded to width N (e.g. {seq:04d} -> 0007).
-- Rendered + advanced by getNextDocumentNumber() in server.js inside the
-- same transaction that creates the numbered document (row locked FOR
-- UPDATE), so concurrent submissions can't collide or reuse a number.

CREATE TABLE IF NOT EXISTS public.requisition_headers (
    id                SERIAL PRIMARY KEY,
    document_id       INTEGER NOT NULL UNIQUE REFERENCES public.documents(id) ON DELETE CASCADE,
    requisition_no    VARCHAR(50) NOT NULL UNIQUE,
    requestor_id      INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
    project_id        INTEGER REFERENCES public.projects(id) ON DELETE SET NULL,
    client            VARCHAR(255),
    job_no            VARCHAR(100),
    cost_code         VARCHAR(100),
    d_sld_spec_ref    VARCHAR(255),  -- Design / Single Line Diagram spec reference
    mto_ref           VARCHAR(255),  -- Material Take Off reference
    need_by_date      DATE,
    created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_requisition_headers_project ON public.requisition_headers (project_id);
CREATE INDEX IF NOT EXISTS idx_requisition_headers_requestor ON public.requisition_headers (requestor_id);

-- Line items: description/qty/unit only -- deliberately no price column.
-- Pricing is looked up later by Procurement against PO history
-- (GET /vendors/:id/item-history, migration 018), not entered here.
CREATE TABLE IF NOT EXISTS public.requisition_line_items (
    id                    SERIAL PRIMARY KEY,
    requisition_header_id INTEGER NOT NULL REFERENCES public.requisition_headers(id) ON DELETE CASCADE,
    line_no               INTEGER NOT NULL,
    material_description  TEXT NOT NULL,
    qty                   NUMERIC(14,3) NOT NULL,
    unit                  VARCHAR(50),
    created_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(requisition_header_id, line_no)
);
CREATE INDEX IF NOT EXISTS idx_requisition_line_items_header ON public.requisition_line_items (requisition_header_id);

-- Supporting documents (spec sheets, drawings, etc.). Separate from the
-- requisition's own `documents` row -- they don't go through the approval
-- chain themselves, they just travel with it as evidence.
CREATE TABLE IF NOT EXISTS public.requisition_attachments (
    id                    SERIAL PRIMARY KEY,
    requisition_header_id INTEGER NOT NULL REFERENCES public.requisition_headers(id) ON DELETE CASCADE,
    filename              VARCHAR(255) NOT NULL,  -- original name, shown to users
    stored_name           VARCHAR(255) NOT NULL,  -- name on disk inside uploads/ (collision-proof, not the original)
    uploaded_by           INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
    created_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_requisition_attachments_header ON public.requisition_attachments (requisition_header_id);

-- Register the document type + its default numbering pattern.
-- Default approvers are deliberately NOT seeded (same as PO/RFQ in 018):
-- assign them in the admin panel (document type -> Chain). A Requisition
-- needs only a single sequential approver (Procurement).
-- NOT EXISTS rather than ON CONFLICT: UNIQUE(name, department_id) never
-- fires while department_id is NULL (NULLs are distinct in Postgres), so a
-- re-run would otherwise insert a duplicate type.
INSERT INTO public.document_types (name, description, is_active)
SELECT 'Material Requisition', 'Engineering material request to Procurement (MR/MTO). Data-entry form, no source file required. See requisition_headers/requisition_line_items.', TRUE
WHERE NOT EXISTS (SELECT 1 FROM public.document_types WHERE name = 'Material Requisition' AND department_id IS NULL);

INSERT INTO public.document_number_sequences (document_type_id, pattern, prefix, next_seq, reset_period)
SELECT id, '{PREFIX}-{YYYY}-{seq:04d}', 'REQ', 1, 'yearly'
FROM public.document_types WHERE name = 'Material Requisition' AND department_id IS NULL
ON CONFLICT (document_type_id) DO NOTHING;
