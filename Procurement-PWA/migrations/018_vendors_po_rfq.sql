-- ==========================================
-- Migration 018: Vendors, PO line items, RFQ headers
-- ==========================================
-- Backs the "Purchase Order" and "Request for Quotation" document types
-- against the real PBE templates (FORM_PO_BARU.docx, REQUEST_FOR_
-- QUOTATION.docx). Scalar header fields on those forms (job no., cost
-- code, delivery time, etc.) could go through the existing custom-
-- property EAV tables (migration 011), but two things on these forms
-- can't: (a) a repeating line-item table with per-row numbers that need
-- to be summed/queried, and (b) real entity references (which vendor,
-- which requisition) that the vendor/item price-history lookup depends
-- on. Custom properties only support text/number/date/boolean/select --
-- no repeating rows, no FK. Hence dedicated tables here instead.
--
-- NOT included yet: wiring these into document_type_default_approvers
-- as anything beyond a single-level placeholder. The PO approval design
-- (PMT schedule-check + Cost Control both gating the same level, in
-- parallel) needs the approval_chain_steps schema (migration 006) to
-- support more than one approver per level first -- that's separate,
-- larger surgery and shouldn't block this schema landing.

-- ------------------------------------------------------------------
-- Vendors
-- ------------------------------------------------------------------
-- One row per vendor company. Kept independent of any one PO/RFQ so the
-- same vendor is reused across documents -- this is what makes "list of
-- vendors, price, and last PO date per item" possible.
CREATE TABLE IF NOT EXISTS public.vendors (
    id            SERIAL PRIMARY KEY,
    name          VARCHAR(255) NOT NULL UNIQUE,
    phone         VARCHAR(50),
    fax           VARCHAR(50),
    contact_attn  VARCHAR(255),
    address       TEXT,
    npwp          VARCHAR(50),  -- Indonesian tax ID, as referenced on the PO template
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ------------------------------------------------------------------
-- Purchase Order header
-- ------------------------------------------------------------------
-- One row per PO document. document_id is UNIQUE (1:1 with a document
-- of type "Purchase Order") rather than embedding these columns
-- directly on `documents`, so this table -- and the FKs it needs -- only
-- exists for documents that are actually POs.
CREATE TABLE IF NOT EXISTS public.po_headers (
    id                      SERIAL PRIMARY KEY,
    document_id             INTEGER NOT NULL UNIQUE REFERENCES public.documents(id) ON DELETE CASCADE,
    vendor_id               INTEGER REFERENCES public.vendors(id) ON DELETE SET NULL,
    requisition_document_id INTEGER REFERENCES public.documents(id) ON DELETE SET NULL, -- links back to the originating Requisition, per "Requisition No." on the template
    manufacturer            VARCHAR(255),
    order_date              DATE,
    project_id              INTEGER REFERENCES public.projects(id) ON DELETE SET NULL,
    client                  VARCHAR(255),
    job_no                  VARCHAR(100),
    cost_code               VARCHAR(100),
    delivery_time           DATE,
    delivery_terms_incoterm VARCHAR(100),
    currency                VARCHAR(10) NOT NULL DEFAULT 'USD',
    created_at              TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_po_headers_vendor ON public.po_headers (vendor_id);
CREATE INDEX IF NOT EXISTS idx_po_headers_requisition ON public.po_headers (requisition_document_id);
CREATE INDEX IF NOT EXISTS idx_po_headers_project ON public.po_headers (project_id);

-- ------------------------------------------------------------------
-- Purchase Order line items
-- ------------------------------------------------------------------
-- Mirrors the template's material table: No | Material Description |
-- Qty | Unit | Unit Price | Extended Price. extended_price is a
-- generated column (qty * unit_price) so it can never drift out of
-- sync with the two inputs -- the template computes it the same way.
-- The PO's "Total Purchase Order Amount" field is intentionally NOT
-- stored anywhere; compute it as SUM(extended_price) per po_header_id
-- at read time instead of duplicating it.
CREATE TABLE IF NOT EXISTS public.po_line_items (
    id                  SERIAL PRIMARY KEY,
    po_header_id        INTEGER NOT NULL REFERENCES public.po_headers(id) ON DELETE CASCADE,
    line_no             INTEGER NOT NULL,
    material_description TEXT NOT NULL,
    qty                 NUMERIC(14,3) NOT NULL,
    unit                VARCHAR(50),
    unit_price          NUMERIC(14,2) NOT NULL,
    extended_price       NUMERIC(16,2) GENERATED ALWAYS AS (qty * unit_price) STORED,
    created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(po_header_id, line_no)
);
CREATE INDEX IF NOT EXISTS idx_po_line_items_header ON public.po_line_items (po_header_id);
-- Supports "what did we last pay this vendor for this item" lookups
-- (join to po_headers for vendor_id + order_date, filter by description).
CREATE INDEX IF NOT EXISTS idx_po_line_items_description ON public.po_line_items (material_description);

-- ------------------------------------------------------------------
-- Request for Quotation header + invited bidders
-- ------------------------------------------------------------------
-- One row per RFQ document.
CREATE TABLE IF NOT EXISTS public.rfq_headers (
    id                      SERIAL PRIMARY KEY,
    document_id             INTEGER NOT NULL UNIQUE REFERENCES public.documents(id) ON DELETE CASCADE,
    requisition_document_id INTEGER REFERENCES public.documents(id) ON DELETE SET NULL,
    job_number              VARCHAR(100),
    client                  VARCHAR(255),
    project_id              INTEGER REFERENCES public.projects(id) ON DELETE SET NULL,
    closing_date            DATE,
    delivery_time_required  VARCHAR(255),
    delivery_term_incoterm  VARCHAR(100),
    description_of_goods    TEXT,
    created_at              TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_rfq_headers_requisition ON public.rfq_headers (requisition_document_id);
CREATE INDEX IF NOT EXISTS idx_rfq_headers_project ON public.rfq_headers (project_id);

-- Which vendors were invited to bid, and their acknowledgment response --
-- mirrors the tear-off "Acknowledgment Form" on the RFQ template
-- (bidder confirms intent to quote, or declines with a reason).
CREATE TABLE IF NOT EXISTS public.rfq_invitees (
    id            SERIAL PRIMARY KEY,
    rfq_header_id INTEGER NOT NULL REFERENCES public.rfq_headers(id) ON DELETE CASCADE,
    vendor_id     INTEGER NOT NULL REFERENCES public.vendors(id) ON DELETE CASCADE,
    response      VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (response IN ('pending', 'will_bid', 'no_bid')),
    decline_reason TEXT,
    responded_at  TIMESTAMP,
    created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(rfq_header_id, vendor_id)
);
CREATE INDEX IF NOT EXISTS idx_rfq_invitees_header ON public.rfq_invitees (rfq_header_id);
CREATE INDEX IF NOT EXISTS idx_rfq_invitees_vendor ON public.rfq_invitees (vendor_id);

-- ------------------------------------------------------------------
-- Register the two document types (schema only -- see migration 010).
-- Default approvers deliberately omitted here: the PO's real approval
-- logic (PMT schedule-check + Cost Control in parallel) isn't
-- expressible with the current single-approver-per-level chain, so
-- adding a placeholder single approver now would just have to be
-- redone once that engine work lands. Assign document_type_default_
-- approvers by hand (admin panel) once that's ready, or as a follow-up
-- migration.
-- ------------------------------------------------------------------
INSERT INTO public.document_types (name, description, is_active)
VALUES
    ('Purchase Order', 'PO issued to a vendor against an approved requisition. See po_headers/po_line_items.', TRUE),
    ('Request for Quotation', 'Vendor solicitation for a requisition, prior to PO. See rfq_headers/rfq_invitees.', TRUE)
ON CONFLICT (name, department_id) DO NOTHING;
