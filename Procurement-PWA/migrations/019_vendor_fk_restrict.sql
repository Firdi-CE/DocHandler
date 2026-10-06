-- ==========================================
-- Migration 019: Restrict vendor deletion when PO history exists
-- ==========================================
-- Migration 018 defined po_headers.vendor_id with ON DELETE SET NULL,
-- which lets a vendor be hard-deleted even when it has POs on file --
-- silently blanking vendor_id on those historical rows and breaking the
-- GET /vendors/:id/item-history price-lookup for anything tied to them.
--
-- Postgres can't ALTER a foreign key's ON DELETE action in place; the
-- constraint has to be dropped and re-added. "po_headers_vendor_id_fkey"
-- is the default name Postgres gives a FK declared inline (no explicit
-- CONSTRAINT name was given in migration 018), following its standard
-- <table>_<column>_fkey convention.
--
-- After this, DELETE on a vendor with any po_headers row referencing it
-- will fail with a foreign_key_violation (Postgres error code 23503)
-- instead of silently succeeding. The admin UI's delete handler already
-- surfaces err.message on non-OK responses, so this will show up as an
-- error toast rather than crash -- but the message itself is Postgres's
-- raw constraint-violation text, not a friendly one yet (see follow-up
-- note at the bottom of this file).

ALTER TABLE public.po_headers
    DROP CONSTRAINT po_headers_vendor_id_fkey;

ALTER TABLE public.po_headers
    ADD CONSTRAINT po_headers_vendor_id_fkey
    FOREIGN KEY (vendor_id) REFERENCES public.vendors(id) ON DELETE RESTRICT;

-- rfq_invitees.vendor_id is NOT touched here: that FK is already
-- ON DELETE CASCADE (migration 018) and that's correct as-is --
-- an invitee row has no meaning once the vendor it refers to is gone,
-- unlike a PO header, which is a historical record worth keeping intact.

-- Follow-up not done here (separate, smaller task if wanted): the
-- server.js DELETE /admin/vendors/:id handler currently has no specific
-- catch for Postgres error code 23503, so a blocked delete will surface
-- Postgres's raw constraint-violation text in the UI's error toast
-- rather than a message like "This vendor has existing purchase orders
-- and can't be deleted — deactivate it instead." Worth a quick
-- server.js tweak once this migration is applied and confirmed working.
