-- ==========================================
-- Migration 005: Per-user notification digest preference
-- ==========================================

-- digest_mode: 'interval' = every N hours, 'daily' = once per day at a fixed time
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS digest_mode    VARCHAR(20)  DEFAULT 'interval';

-- For 'interval' mode: how many hours between digest runs (min 1, practical max 24)
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS digest_interval_hours INTEGER DEFAULT 4;

-- For 'daily' mode: hour of day (0-23) and minute (0-59) in 24h time
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS digest_daily_hour   INTEGER DEFAULT 8;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS digest_daily_minute INTEGER DEFAULT 0;
