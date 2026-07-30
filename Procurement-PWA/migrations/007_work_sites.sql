-- ==========================================
-- Migration 007: Work Sites & Maintenance Lifecycle
-- ==========================================
-- See BACKLOG.md ("Work Sites & Maintenance Lifecycle") for the original
-- feature brief. Implemented with a placeholder `Manager` role -- see
-- roles.js for the single place that role is defined/gated, since the
-- real org-chart mapping is still unconfirmed (BACKLOG.md open questions).

-- 1. Work sites belong to a project. Deleting the project takes its sites
--    with it (mirrors how project_assignments/documents already cascade
--    off projects).
CREATE TABLE IF NOT EXISTS public.work_sites (
    id         SERIAL PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
    site_name  VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(project_id, site_name)
);
CREATE INDEX IF NOT EXISTS idx_work_sites_project ON public.work_sites (project_id);

-- 2. Project lifecycle status. 'active' by default; a Manager (or
--    Executive/Admin) can flip a project to 'maintenance' or 'completed'.
ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'active';
ALTER TABLE public.projects DROP CONSTRAINT IF EXISTS projects_status_check;
ALTER TABLE public.projects ADD CONSTRAINT projects_status_check
    CHECK (status IN ('active', 'completed', 'maintenance'));

-- 3. Optional site-level scoping on top of the existing project-level
--    assignment. NULL (the default) means "whole project", matching
--    current behavior exactly -- nobody's access changes just from this
--    column existing.
ALTER TABLE public.project_assignments ADD COLUMN IF NOT EXISTS site_id
    INTEGER REFERENCES public.work_sites(id) ON DELETE SET NULL;

-- 4. Not in the original migration bullet list, but added here so the
--    Upload modal's cascading Project -> Site dropdown actually records
--    something -- otherwise the second dropdown has nowhere to write its
--    value. Nullable/optional: uploads without a site keep working exactly
--    as before.
ALTER TABLE public.documents ADD COLUMN IF NOT EXISTS site_id
    INTEGER REFERENCES public.work_sites(id) ON DELETE SET NULL;
