-- 1. Create Independent Scope Tables
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

-- 2. Create Base Users Table with Roles and Department Links
CREATE TABLE IF NOT EXISTS public.users (
    id SERIAL PRIMARY KEY,
    google_id VARCHAR(255) UNIQUE,
    email VARCHAR(255) NOT NULL UNIQUE,
    display_name VARCHAR(255),
    is_approved BOOLEAN DEFAULT FALSE,
    role VARCHAR(50) DEFAULT 'Staff', -- Roles can be: 'Executive', 'Supervisor', 'Staff'
    department_id INTEGER REFERENCES public.departments(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 3. Create Project Assignments Table (Many-to-Many Mapping)
CREATE TABLE IF NOT EXISTS public.user_projects (
    user_id INTEGER REFERENCES public.users(id) ON DELETE CASCADE,
    project_id INTEGER REFERENCES public.projects(id) ON DELETE CASCADE,
    assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, project_id)
);

-- 4. Create Documents Table Pre-Scoped with Scoping Keys
CREATE TABLE IF NOT EXISTS public.documents (
    id SERIAL PRIMARY KEY,
    filename VARCHAR(255) NOT NULL,
    file_path VARCHAR(255) NOT NULL,
    uploaded_by INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
    recipient_id INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
    department_id INTEGER REFERENCES public.departments(id) ON DELETE SET NULL,
    project_id INTEGER REFERENCES public.projects(id) ON DELETE CASCADE,
    status VARCHAR(50) DEFAULT 'Pending',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 5. Create Approvals Track Table
CREATE TABLE IF NOT EXISTS public.approvals (
    id SERIAL PRIMARY KEY,
    document_id INTEGER REFERENCES public.documents(id) ON DELETE CASCADE,
    approved_by INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
    status VARCHAR(50) DEFAULT 'Pending',
    comments TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);