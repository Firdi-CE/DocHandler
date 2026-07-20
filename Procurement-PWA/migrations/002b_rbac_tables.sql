-- ==========================================
-- Migration 002: Role-based access control + document workflow columns
-- ==========================================

-- 1. Independent scope tables (no-op if already created)
CREATE TABLE IF NOT EXISTS public.departments (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL UNIQUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS public.projects (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL UNIQUE,
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 2. Base users table with roles and department links
CREATE TABLE IF NOT EXISTS public.users (
    id SERIAL PRIMARY KEY,
    google_id VARCHAR(255) UNIQUE,
    email VARCHAR(255) NOT NULL UNIQUE,
    display_name VARCHAR(255),
    is_approved BOOLEAN DEFAULT FALSE,
    role VARCHAR(50) DEFAULT 'Staff', -- Roles: 'Executive', 'Supervisor', 'Staff'
    department_id INTEGER REFERENCES public.departments(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 3. Canonical project-assignment table (originally created in 001_auth_tables.sql).
-- NOTE: an earlier version of this migration also created a separate
-- `user_projects` table, but every route in server.js (/admin/assign-project,
-- /documents/my-inbox, /documents/:id/stream) queries `project_assignments`.
-- Standardizing on that name and dropping the unused duplicate.
CREATE TABLE IF NOT EXISTS public.project_assignments (
    id SERIAL PRIMARY KEY,
    user_id INT REFERENCES public.users(id) ON DELETE CASCADE,
    project_id INT REFERENCES public.projects(id) ON DELETE CASCADE,
    UNIQUE(user_id, project_id)
);
DROP TABLE IF EXISTS public.user_projects;

-- 4. Documents table (create if missing)
CREATE TABLE IF NOT EXISTS public.documents (
    id SERIAL PRIMARY KEY,
    filename VARCHAR(255) NOT NULL,
    file_path VARCHAR(500),
    sender_id INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
    recipient_id INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
    department_id INTEGER REFERENCES public.departments(id) ON DELETE SET NULL,
    project_id INTEGER REFERENCES public.projects(id) ON DELETE CASCADE,
    status VARCHAR(50) DEFAULT 'Pending',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- `documents` already existed before this branch (CREATE TABLE IF NOT EXISTS above
-- is a no-op on your dev DB), so explicitly backfill the columns the new code
-- depends on -- this is what actually fixes the /upload + /documents/:id/stream
-- "file_path is undefined" bug.
ALTER TABLE public.documents ADD COLUMN IF NOT EXISTS file_path VARCHAR(500);
ALTER TABLE public.documents ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'Pending';

-- 5. Approvals tracking table (reserved for the reviewed/pending workflow item;
-- not wired into server.js yet)
CREATE TABLE IF NOT EXISTS public.approvals (
    id SERIAL PRIMARY KEY,
    document_id INTEGER REFERENCES public.documents(id) ON DELETE CASCADE,
    approved_by INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
    status VARCHAR(50) DEFAULT 'Pending',
    comments TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
