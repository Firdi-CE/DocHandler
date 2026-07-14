-- ==========================================
-- Migration 003: Urgent flag + digest notification queue
-- ==========================================

-- Urgent documents bypass the digest queue and trigger an immediate email.
ALTER TABLE public.documents ADD COLUMN IF NOT EXISTS is_urgent BOOLEAN DEFAULT false;

-- Non-urgent uploads land here instead of triggering an immediate email.
-- The digest job periodically groups unsent rows by recipient and sends
-- one summary email per recipient, then stamps sent_at.
CREATE TABLE IF NOT EXISTS public.notification_queue (
    id SERIAL PRIMARY KEY,
    document_id INTEGER NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
    recipient_id INTEGER NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    sent_at TIMESTAMP
);

-- Speeds up "find all pending digest rows" which is the query the cron job
-- runs every cycle.
CREATE INDEX IF NOT EXISTS idx_notification_queue_pending
    ON public.notification_queue (recipient_id)
    WHERE sent_at IS NULL;
