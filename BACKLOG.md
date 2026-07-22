# DocHandler — Backlog

Deferred work, not yet started. Follow the "1-Feature Rule" when picking one of
these up — implement only the item in scope, no bleed into other features.

---

## Work Sites & Maintenance Lifecycle

Full architecture prompt to run when this is picked up (paste as-is into a
fresh session so the "1-Feature Rule" framing and phase structure stay
intact):

> You are acting as a Senior Full-Stack Architect helping a Solo SysAdmin build a Node.js/Express/PostgreSQL Progressive Web App (PWA) for Document Management.
> We are strictly following the "1-Feature Rule". Do not write code for anything outside the scope of this prompt. Provide fully complete, copy-pasteable code blocks. NO PLACEHOLDERS like `// rest of code here`.
> CURRENT STACK:
> - Backend: Node.js (Express), `pg` pool, JWT for stateless authentication.
> - Frontend: Vanilla JS, HTML, CSS.
> - Database: PostgreSQL.
> OBJECTIVE:
> Implement the "Work Sites & Maintenance Lifecycle" feature block.
> ARCHITECTURAL REQUIREMENTS:
> 1. Database Schema (Provide the SQL script):
> - Create a new table `work_sites` (id, project_id (FK), site_name).
> - Add a new column `status` to the existing `projects` table. It should default to 'active'. Other valid states are 'completed' and 'maintenance'.
> - Update the `project_assignments` (or similar RBAC table) to allow assigning a user to a specific `site_id` (nullable, if null they have access to the whole project).
> 2. Backend API Routes (Provide the Express/Node.js updates):
> - Create `GET /api/projects/:id/sites` to fetch sites for a specific project.
> - Create `PATCH /api/projects/:id/status` so an assigned Project Manager can update the status from 'active' to 'maintenance'.
> - Update the Document Fetching logic:
>   - If user role == 'Staff', they can ONLY access their Inbox/Outbox routes. They are forbidden from fetching global Project/Site document lists.
>   - If user role == 'Supervisor' or 'Manager', they can fetch documents for projects/sites they are assigned to.
> 3. Frontend UI Logic (Provide Vanilla JS/HTML updates):
> - Upload Modal: Implement "Cascading Dropdowns". When a user selects a Project from the first dropdown, dynamically fetch and populate the second dropdown with the corresponding Work Sites.
> - Project Manager UI: Add a lightweight "My Projects" view for Supervisors/Managers where they can see the projects they own and toggle a dropdown to change the project's status to 'Maintenance'.
> EXECUTION PLAN:
> Please output your response in three distinct phases:
> Phase 1: The exact PostgreSQL commands to execute.
> Phase 2: The `server.js` route additions and modifications.
> Phase 3: The Frontend HTML/JS snippets to update the UI.
> End your response with a brief "Next Steps" checklist.

**Notes before starting:**
- Existing roles in the codebase are `Staff` / `Supervisor` / `Executive` / `Admin` — this prompt refers to `Manager`, which doesn't currently exist. Reconcile before running Phase 1 (either rename in the prompt to `Executive`, or decide `Manager` is a genuinely new role and work out where it sits relative to `Supervisor`/`Executive` in the approval-chain and admin-override logic).
- New migration would be `007_work_sites.sql` — remember the recurring "migration silently not applied" issue; confirm it actually ran before building on top of it.
- Touches document-fetching RBAC logic, so re-check interaction with `buildInboxScopeClause()` (added in the server-side inbox filtering work) and the existing multi-level approval chain scoping.

---

## Other deferred items

- **Google Drive integration** — not started.
- **`schema_migrations` tracking table/runner** — proposed once, explicitly declined ("i dont need it").
- **Admin approval-override relaxation** — currently Admin can act on any approval level (intentional for dev phase). Revisit at deployment: only the exact assigned approver should be able to act.
