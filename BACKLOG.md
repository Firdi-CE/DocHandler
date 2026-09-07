# DocHandler — Backlog

Deferred work, not yet started. Follow the "1-Feature Rule" when picking one of
these up — implement only the item in scope, no bleed into other features.

---

## Papra-inspired feature development

**See `PAPRA_FEATURE_ROADMAP.md`** (added 2026-09-03) for the full
sequencing plan — 9 features analyzed against `reference/papra`'s actual
source (branch `reference/papra-ui-ux`), each mapped onto DocHandler's
Postgres/Express stack with a complexity estimate and dependency order.
Recommended order: Custom Properties → Tags → Tagging Rules → OCR/Content
Extraction (also resolves the previously-tabled OCR tooling decision, see
that doc) → Full-Text Search → Document Share Links → Ingestion Folders →
Intake Emails (recommend redesigning, not porting) → API Keys/Webhooks/SDK
(defer until a concrete need exists).

**#1 Custom Properties — fully done (2026-09-03).** Migration 011 adds
`custom_property_definitions`, `custom_property_select_options`,
`document_custom_property_values` (same nullable-`department_id`-means-
global pattern as `document_types`). Admin CRUD at
`public/admin/custom-properties.html` + routes in `server.js`, sidebar nav
link added across all admin pages.

Values are now wired in too: `GET /custom-properties?departmentId=X`
(any authenticated user, not admin-only) drives dynamic fields on the
upload form once a department is picked — same department dropdown
already used for recipient filtering, no document-type selector needed
since properties are scoped by department, not type. Wired into **both**
upload paths (`/upload` multipart and `/documents/drive-attach` JSON) via
a shared `saveDocumentCustomPropertyValues()` helper, best-effort/never-
fails-the-upload, same pattern as default-approval-chain auto-creation.
A "Properties" button on every document row opens a modal
(`GET`/`PUT /documents/:id/custom-properties`) to view or edit values
after the fact — gated by the same `checkDocumentAccess()` used
everywhere else a single document is accessed, so visibility and edit
rights are the same rule.

Noted in passing, not fixed (out of scope): `document_type_id` is accepted
by `/upload` server-side and has full admin CRUD, but no frontend upload
form anywhere actually has a document-type selector — that selector was
apparently never built. Doesn't block Custom Properties (scoped by
department, not type) but worth knowing before Tagging Rules (#3) if any
rule condition wants to key off document type.

**#2 Tags — fully done (2026-09-03).** Migration 012 adds `tags` +
`document_tags` (many-to-many). Unlike Custom Properties and Document
Types, tags are **not** admin-gated to create — any authenticated user can
create one inline via find-or-create (`POST /tags` returns the existing
tag if the name already exists, case/whitespace-insensitive). Renaming or
deleting an existing tag IS admin-gated (`PATCH`/`DELETE /tags/:id`),
since either affects every document that already carries it. Tags are
global, not department-scoped — no equivalent open question to Custom
Properties' department-vs-global one, since Papra's tags aren't
org-scoped in a way that maps to DocHandler's departments either.

Wired in fully: a tag picker (chip input, type-and-press-Enter or "Add")
on the upload form, feeding into both upload paths via a shared
`saveDocumentTags()` helper, same best-effort pattern as custom property
values. `my-inbox`/`my-outbox` now aggregate each document's tags inline
(`json_agg` subquery) so chips render under the filename with zero extra
round-trips. A tag filter dropdown was added alongside the existing
project/site/sender/file-type filters (`tagId` query param, populated from
only the tags actually in use in that scope, same pattern as the
file-type filter). A "Tags" button on every row opens an edit modal
(`PUT /documents/:id/tags`, `checkDocumentAccess`-gated like Custom
Properties) — reuses the already-loaded row data instead of an extra
fetch when opening.

No dedicated "Manage Tags" admin page was built this pass — rename/delete
exist as API routes only. Worth adding a small admin page later if stray
or duplicate-ish tags start accumulating and need cleanup; skipped for now
to keep this patch scoped to the core feature.

**#3 Tagging Rules — done (2026-09-03).** Migration 013 adds
`tagging_rules` + `tagging_rule_conditions` + `tagging_rule_actions`,
depends on Tags. Unlike Tags, rules ARE fully admin-gated (`ensureAdmin`
on every route) — a rule affects every future upload and, via retroactive
apply, every existing document, so this isn't left open to any user.

Condition field set deliberately smaller than Papra's for this first
pass: `filename` (contains/equals) and `department_id`/`project_id`/
`site_id` (equals only, matched by ID). Custom-property-based conditions
were a nice-to-have in the roadmap, not a requirement — can be added as a
new `field` value later without a schema change, since conditions are
already generic field/operator/value rows.

`evaluateTaggingRule()` runs a rule's conditions against a document with
`all`/`any` match-mode logic; `applyTaggingRulesToDocument()` runs every
active rule after upload (both `/upload` and `/documents/drive-attach`,
after the uploader's own tag/property choices are saved) via a new
`addDocumentTags()` helper that **adds** tags without removing existing
ones — layering on top rather than replacing, since a rule shouldn't undo
what the uploader or a previous rule already set.

Retroactive apply (`POST /admin/tagging-rules/:id/apply-retroactive`) runs
synchronously in a paginated loop (100 docs/batch, mirrors Papra's
`applyTaggingRuleToExistingDocuments` batching) rather than a background
job — DocHandler doesn't have a generic job queue yet, and this is an
infrequent admin-triggered action, not something worth building queue
infrastructure for yet. Worth revisiting if document volume grows enough
that this becomes slow.

Admin UI at `public/admin/tagging-rules.html` (list, create, edit modal
with a condition-row builder and tag-checkbox action picker, "Apply Now"
button), nav link added across all 10 admin/dashboard pages — **which
also caught and fixed a pre-existing gap**: `document-types.html` itself
had never gotten the Custom Properties nav link when that feature shipped,
so it was missing that link the whole time. Fixed in the same patch.

**#4 OCR / Content Extraction — done (2026-09-03).** Migration 014 adds
`content_text`/`content_extraction_status` to `documents`. New
`contentExtraction.js` module: native text extraction (`.txt`/`.md`/`.csv`
read directly, `.pdf` via `pdf-parse`) tried first, `tesseract.js` OCR as
a fallback for images and text-less (scanned) PDFs — resolving the
previously-tabled OCR tooling decision. Wired into `/upload` only,
fire-and-forget (not awaited in the request path, since OCR can take
seconds). **Direct-upload only — Google Drive-attached documents are not
covered**, since extracting from those would require downloading via the
Drive API first; noted as a real gap, not silently skipped.

Three real bugs were found and fixed via actual smoke-testing against the
libraries as-installed (not assumed from memory) — worth recording since
none of these would have been obvious from reading the code alone:

1. **`pdf-parse` v2 broke its API entirely** from v1's default-function
   export to a `PDFParse` class (`new PDFParse({ data: buffer }).getText()`).
   `package.json` had no prior pin so `npm install` would've grabbed v2;
   the original code was written against the v1 shape and would have
   failed on every single PDF upload. Fixed after generating a real test
   PDF and hitting `pdfParse is not a function`.

2. **`tesseract.js`'s `createWorker()` can crash the entire Node process**,
   not just fail the one OCR call. If the language-data fetch to
   `cdn.jsdelivr.net` fails for any reason (firewall, outage, DNS), the
   default behavior is an unhandled `'error'` event — which Node treats as
   fatal — rather than a rejected promise. Confirmed by triggering it in
   this sandbox (blocked CDN access) and watching it kill the process even
   inside a try/catch. Fixed with a required `errorHandler` option.

3. **Even with the crash fixed, a failed worker load hangs forever**
   rather than rejecting. Added an explicit 45s timeout wrapping both
   `createWorker()` and `recognize()` (confirmed `createWorker()` itself is
   what hangs, not `recognize()`) so a stuck OCR attempt resolves to
   `{ text: null, method: 'error' }` in bounded time instead of leaking
   forever. One residual limitation, documented in code: if the CDN fetch
   never resolves or rejects at all (vs. failing cleanly), that specific
   worker thread leaks for the process's lifetime — bounded per failed
   attempt, not unbounded per request, and doesn't crash/hang the server,
   but accumulates under *sustained* CDN unreachability.

**Real follow-up worth prioritizing, not hypothetical**: bundle the
`eng.traineddata` file locally (`tesseract.js` supports a local `langPath`)
so OCR has zero runtime dependency on an external CDN. This sandbox
couldn't reach `cdn.jsdelivr.net` at all — if DocHandler's real deployment
server is similarly firewalled (plausible for an internal corporate tool),
OCR would silently never work without this, always falling through to the
timeout/error path. Skipped in this pass only because it means shipping a
~15MB data file through the patch-based workflow, which needs a
deliberate decision rather than a silent addition to a patch.

---

## Work Sites & Maintenance Lifecycle

**Status: implemented (2026-07-30) with placeholder roles; role hierarchy
confirmed 2026-09-03.** A `Manager` role was added purely as a placeholder
— see `roles.js`, which was the single file that needed to change once the
real org chart came in.

The real chart ("Corporate PT. Pilar Bahtera Energi", Aug 2026, uploaded
2026-09-03) turned out simpler than the old provisional one: **no separate
Project Manager / Site Manager split**. Confirmed hierarchy is
Director/VP → Manager (+ subordinates at the same access level) → Staff,
with "site" handled as the existing `site_id` scoping attribute rather than
a role tier — so the Work Sites feature's original design already covered
it correctly, no schema changes needed.

What changed in `roles.js` as a result:
- Director + VP both map to `Executive` (VP's exact scope wasn't confirmed
  — defaulted to full Executive access; flagged in `roles.js` as
  revisit-able if a narrower VP tier turns out to matter).
- Manager's subordinates (Supervisors etc.) sharing the Manager's access
  level was already true in code (`isProjectScopedRole` treats `Supervisor`
  and `Manager` identically) — no change needed there.
- **New `HSE` role added** for the 3 HSE staff, who report directly to the
  President Director rather than sitting under any of the 4 Directors.
  Confirmed to need cross-project visibility like `Executive`, but
  deliberately does NOT get admin-panel access or document-approval
  authority — see `roles.js` header comment for the full reasoning, and the
  new `isAdminPanelRole()` split from `isGlobalRole()` (the old
  `ensureAdmin` reused `isGlobalRole()`, which would have accidentally
  given HSE full admin rights too).

What shipped:
- `migrations/007_work_sites.sql` — `work_sites` table, `projects.status`
  (active/completed/maintenance), `project_assignments.site_id` (nullable —
  NULL still means whole-project access, unchanged), and `documents.site_id`
  (nullable; added beyond the original bullet list so the upload form's
  Site dropdown has somewhere to write its value). **Run this migration** —
  it does not apply itself.
- `roles.js` — centralized role/capability config.
- Backend: `GET /projects/:id/sites`, admin CRUD for sites
  (`POST/PATCH/DELETE /admin/.../sites`), `GET /my-projects`,
  `PATCH /projects/:id/status`, `buildInboxScopeClause` now treats `Manager`
  like `Supervisor`.
- Frontend: cascading Project → Site dropdown on the upload form, a new
  `/my-projects.html` page (status toggle, visible to anyone above Staff),
  and a "Sites" management modal on the admin Projects page.

Original architecture prompt, kept for reference:

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

**Role/hierarchy reference — RESOLVED 2026-09-03.**

An earlier provisional chart (`Struktur_Organisasi_PV_BESS_Installation.pdf`,
a single-project PV & BESS Installation org chart) had suggested a two-tier
Manager split (Project Manager / Site Manager) and was used as a stand-in.
The real company-wide chart (`Corporate_-_PBE_-_Agustus__26.pdf`) doesn't
support that split — see the confirmed mapping and `roles.js` above. Kept
here only as a note in case the old provisional chart resurfaces and causes
confusion; it does not reflect the current implementation.

Remaining open item: VP's exact access scope (defaulted to full `Executive`
— see `roles.js`) wasn't confirmed and could be revisited later if a
narrower VP tier turns out to matter in practice.

**Follow-up (2026-09-03):** `HSE` added to the document-types admin page's
`APPROVER_ROLES` dropdown (`public/admin/document-types.html`), so document
types can now route a chain level to "whoever holds the HSE role in this
department" as a default approver, same as any other role. No backend
change needed — `document_type_default_approvers` resolution was already
role-agnostic (`WHERE department_id = $1 AND role = $2`). One caveat worth
knowing: that resolution requires an HSE-role user to actually have
`department_id` set to the document type's department. Since HSE reports to
the President Director rather than sitting under one of the 4 Directors'
departments on the org chart, an HSE user's `department_id` assignment may
need to be set deliberately (e.g. to whichever department a given document
type belongs to, or duplicated across departments) for this to resolve —
not a code bug, just something to check when actually wiring up an
HSE-approved document type.

---

## Other deferred items

- **Google Drive integration** — **Done (2026-07-31).** Single shared-account
  connection (no Google Workspace for the office yet, so this is not per-user
  OAuth) — see `driveService.js` for the full design rationale. Both
  requested capabilities shipped: attaching an existing Drive file at
  upload time, and best-effort auto-backup of every local upload to a
  "DocHandler Uploads" folder in the connected account.

  **To actually turn this on:**
  1. Run `migrations/008_google_drive.sql`.
  2. In the Google Cloud project for the OAuth client you already have,
     confirm the client type is "Web application" and add an Authorized
     redirect URI: `<your domain>/admin/integrations/google-drive/callback`.
  3. Add three environment variables: `GOOGLE_CLIENT_ID` (can reuse the
     same one auth.js already uses for Sign-In, or a separate client — see
     driveService.js's header comment), `GOOGLE_CLIENT_SECRET`, and
     `GOOGLE_DRIVE_REDIRECT_URI` (must exactly match what you registered
     in step 2).
  4. Add the Google account you want to connect as a **Test user** under
     OAuth consent screen in Cloud Console — this app requests restricted
     Drive scopes, so an unverified app can only be used by accounts on
     that list. Expect a "Google hasn't verified this app" warning during
     connect; that's expected for an internal unverified app.
  5. As an Executive/Admin, go to Admin → Integrations → Connect.

  Not built (flagging in case it's wanted later): a way to change which
  Drive folder backups land in after the fact (currently auto-created once
  on first connect and fixed), and any de-dup/versioning if the same file
  gets attached twice.

  **Fix (2026-08-03, self-audit):** `backupLocalFile()` used to trust a
  cached backup-folder ID forever. If someone manually deleted the
  "DocHandler Uploads" folder from Drive, every future backup would fail
  silently (just a console warning) until an admin noticed and fixed it
  directly in the database. It's now self-healing: a failed folder move
  triggers one retry against a freshly-created folder.
- **`schema_migrations` tracking table/runner** — proposed once, explicitly declined ("i dont need it").
- **Admin approval-override relaxation** — ~~currently Admin can act on any approval level (intentional for dev phase). Revisit at deployment: only the exact assigned approver should be able to act.~~ **Done (2026-07-31).** `PATCH /documents/:id/approval-step` now requires `curStep.approver_id === req.user.id` by default. The old blanket-Admin bypass is still available for local dev only, behind `ALLOW_ADMIN_APPROVAL_OVERRIDE=true` in the environment (unset/false in production). Note: this only touched the multi-level chain endpoint (`approval-step`) — the separate single-level `/documents/:id/status` endpoint intentionally still allows any Executive or Admin to act, since documents without a chain never had one single assigned approver to defer to in the first place.

## Follow-up items (from a "any other ideas?" review after the above)

- **Document versioning** — **Done (2026-08-03).** A rejected document can
  now be corrected and resubmitted as a new version, instead of becoming a
  disconnected new upload — see `migrations/009_document_versioning.sql`
  (`version_group_id` self-reference + `version_number`) and
  `resolveResubmission()` / `checkDocumentAccess()` in server.js. Works for
  both local re-uploads and Drive-attach resubmissions. Inbox/Sent lists
  only ever show the latest version of a chain (`LATEST_VERSION_ONLY_CLAUSE`);
  older versions stay reachable via the "Versions" button →
  `GET /documents/:id/versions`.

  Not built: the new version does NOT inherit the original's multi-level
  approval chain (if it had one) — it starts fresh with no chain, so it'll
  go through the simple single-level Executive/Admin approval unless
  someone re-sets a chain on it via the existing "Set Chain" action. Copying
  the old chain automatically would be a reasonable follow-up if that
  friction turns out to matter in practice.

  **Fix (2026-08-03):** the rejection reason (`documents.notes`) was only
  ever visible in the Versions modal, which itself only appeared once a
  document had already been resubmitted — so a *first-time* rejection had
  no in-app way to see why (only the rejection email). Now shown inline in
  the document row for any rejected document, regardless of version count.

  Also folded in a small unrelated cleanup found while wiring this up:
  migration 002 had added `drive_file_id`/`drive_view_link`/`file_type` to
  `documents`, but nothing ever read or wrote them (dead columns predating
  the real Drive integration in migration 008) — dropped in
  `009_document_versioning.sql`, confirmed unused via a full grep first.

- **Inbox/Sent filter by site** — **Done (2026-08-03).** The filter bar
  (previously Inbox-only) now shows on both tabs, with a new Site dropdown
  alongside Project/Person/FileType. `/documents/my-outbox` gained the same
  server-side filtering `/documents/my-inbox` already had (it had none
  before — only pagination), and a new `outbox-filter-options` endpoint
  mirrors the inbox one. On Sent, "Sender" becomes "Recipient" (filtering
  by yourself would be pointless).

- **Admin view audit log** — **Done (2026-08-03).** New
  `GET /admin/audit-log` (paginated, searchable by action/user/document) and
  an Admin → Audit Log page. `audit_logs.entity_id` is generic per its
  original migration comment ("document id, or other entity in the
  future") but every action logged so far is document-related, so the
  viewer joins straight to `documents` for a filename; a future non-document
  action type would just show `#<id>` instead.

- **Admin backfill backup** — **Done (2026-08-03).** New
  `POST /admin/integrations/google-drive/backfill` (+ a `backfill-status`
  endpoint for progress) mirrors every local upload that predates Drive
  being connected into the backup folder, using the same
  `driveService.backupLocalFile()` the automatic per-upload backup uses.
  Runs in the background after responding immediately (no job-queue
  infrastructure in this app to track it properly otherwise) — the
  Integrations page polls status every few seconds while it runs. Surfaced
  automatically whenever Drive is connected.
