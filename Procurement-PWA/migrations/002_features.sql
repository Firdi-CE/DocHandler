-- ==========================================
-- Migration 002: Document Features & Queues
-- ==========================================

-- 1. Add new columns to documents
ALTER TABLE documents ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'pending';
ALTER TABLE documents ADD COLUMN IF NOT EXISTS is_urgent BOOLEAN DEFAULT false;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS file_type VARCHAR(50);
ALTER TABLE documents ADD COLUMN IF NOT EXISTS drive_file_id VARCHAR(255);
ALTER TABLE documents ADD COLUMN IF NOT EXISTS drive_view_link TEXT;

-- 2. Add email preference to users
ALTER TABLE users ADD COLUMN IF NOT EXISTS notify_frequency VARCHAR(20) DEFAULT 'digest';

-- 3. Create the notification queue for the cron job
CREATE TABLE IF NOT EXISTS notification_queue (
    id SERIAL PRIMARY KEY,
    document_id INT REFERENCES documents(id) ON DELETE CASCADE,
    recipient_id INT REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    sent_at TIMESTAMP
);