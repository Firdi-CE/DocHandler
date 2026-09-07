-- ==========================================
-- Migration 014: Content extraction columns
-- ==========================================
-- Item #4 of the Papra-inspired feature roadmap (PAPRA_FEATURE_ROADMAP.md).
-- See contentExtraction.js for the extraction logic itself. Extraction
-- runs fire-and-forget after upload (not awaited in the request path,
-- since OCR can be slow) -- content_extraction_status lets the UI/future
-- Full-Text Search feature (#5) tell "not processed yet" apart from
-- "processed, nothing extractable" apart from "processed, here's the text".

ALTER TABLE public.documents
    ADD COLUMN IF NOT EXISTS content_text TEXT,
    ADD COLUMN IF NOT EXISTS content_extraction_status VARCHAR(20);
-- Expected values: NULL (not yet processed), 'native', 'ocr', 'unsupported', 'error'
-- -- see contentExtraction.js's extractDocumentContent() return shape.
