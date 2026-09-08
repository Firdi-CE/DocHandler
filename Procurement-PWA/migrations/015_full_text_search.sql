-- ==========================================
-- Migration 015: Full-Text Search
-- ==========================================
-- Item #5 of the Papra-inspired feature roadmap (PAPRA_FEATURE_ROADMAP.md).
-- Depends on OCR/Content Extraction (#4, migration 014) for content_text
-- to search document bodies, not just filenames.
--
-- Papra uses a SQLite FTS5 virtual table with a custom sync mechanism to
-- keep it current. Postgres has native full-text search built in --
-- actually simpler to stand up here than replicating FTS5: a GENERATED
-- ALWAYS AS ... STORED column keeps itself in sync automatically on every
-- INSERT/UPDATE, no separate sync trigger or virtual-table bookkeeping
-- needed at all.
--
-- Weighted: filename matches rank higher ('A') than document-body matches
-- ('B') ranked higher than notes ('C') -- so a search for "invoice" that
-- matches a filename like "Invoice_2026.pdf" ranks above a document that
-- merely mentions the word "invoice" somewhere in its OCR'd body text.
--
-- IMPORTANT (found via testing against a real Postgres instance, not
-- assumed): Postgres's default text search parser treats underscore/dash/
-- dot-joined strings as a SINGLE token -- to_tsvector('english',
-- 'Invoice_2026_Q3.pdf') produces one token, 'invoice_2026_q3.pdf', not
-- separate words. Since DocHandler filenames are exactly this pattern
-- (timestamped prefix + original name, commonly with underscores/dashes),
-- searching for "invoice" would never have matched a filename containing
-- it -- silently defeating the single most common search case despite
-- filename being weighted highest. Fixed by replacing separator
-- characters with spaces before tokenizing, so words split normally.

ALTER TABLE public.documents
    ADD COLUMN IF NOT EXISTS search_vector tsvector
    GENERATED ALWAYS AS (
        setweight(to_tsvector('english', regexp_replace(coalesce(filename, ''), '[_.\-]', ' ', 'g')), 'A') ||
        setweight(to_tsvector('english', coalesce(content_text, '')), 'B') ||
        setweight(to_tsvector('english', coalesce(notes, '')), 'C')
    ) STORED;

CREATE INDEX IF NOT EXISTS idx_documents_search_vector ON public.documents USING GIN (search_vector);
