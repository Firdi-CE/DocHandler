// ==========================================
// Centralized role / capability config
// ==========================================
// Hierarchy confirmed 2026-09-03 against the office's real org chart
// ("Corporate PT. Pilar Bahtera Energi", Aug 2026). Supersedes the
// provisional PV & BESS Installation project chart previously used as a
// stand-in (see BACKLOG.md history for that context).
//
// Confirmed mapping:
//   Director (L1) + VP (L2)              -> Executive
//     VP was explicitly *not confirmed* to need narrower access than
//     Director — defaulted to full Executive access for now. Revisit if a
//     distinct VP tier (more than Manager, less than Director) turns out
//     to be needed; that would be new code, not just a config change here.
//   Manager (L3) + their direct reports  -> Manager
//     (Supervisors, Senior Engineers, etc. under a Manager share the
//     Manager's access level per the confirmed chart — this already
//     matches how `Supervisor` and `Manager` have identically been treated
//     by `isProjectScopedRole` since the Work Sites feature shipped, so no
//     behavior change was needed there.)
//   Staff (L4)                           -> Staff
//   QA & HSE (reports to President Director, not nested under any of the
//   4 Directors' chains)                 -> HSE (new role, see below)
//   Site (Polytama, Tanjung, Kawengan, Sukowati A/B, Johnlin, Lirik, ...)
//                                         -> confirmed as the existing
//     `site_id` scoping mechanism from the Work Sites feature. Not a role
//     tier — orthogonal to the ladder above.
//
// HSE is a NEW role, not a relabeling of an existing tier: the 3 HSE staff
// on the chart are individual contributors reporting to the President
// Director, not Directors themselves. They were confirmed to need
// cross-project *visibility* like Executive — but that's deliberately ALL
// they get. HSE is in GLOBAL_ROLES (visibility/scoping bypass) but NOT in
// ADMIN_ROLES (admin panel: user management, document-type/project/site
// CRUD, integrations, audit log). Before this change, `ensureAdmin` in
// server.js reused `isGlobalRole()` for both concerns, which would have
// silently granted HSE full admin-panel access too — split into
// `isGlobalRole()` (visibility) and `isAdminPanelRole()` (admin gate) to
// keep those separate. See server.js's `ensureAdmin` for the one callsite
// that needed to change.
//
// HSE was also deliberately left OUT of document approval authority
// (`/documents/:id/status`, `/documents/:id/approval-chain` still
// hardcode 'Executive'/'Admin') and out of `PROJECT_STATUS_MANAGER_ROLES`
// (changing a project's active/completed/maintenance status). Visibility
// was the only thing confirmed as in-scope for HSE; approval/management
// authority wasn't asked for and shouldn't be assumed.
//
// Everything that needs to know "who can do X" should import a helper from
// this file instead of comparing req.user.role to a string literal inline.
// That way, when the real roles/hierarchy need to change again, this is
// the only file that needs to change.
//
// Existing role checks elsewhere in server.js (the approval-authority
// endpoints noted above, and a couple of pre-existing frontend gates)
// predate this file and weren't touched, to keep this change scoped to
// reconciling the role hierarchy — see BACKLOG.md's "1-Feature Rule".
// They'd be reasonable to migrate onto this file later.

const ROLES = {
  STAFF: 'Staff',
  SUPERVISOR: 'Supervisor',
  MANAGER: 'Manager',
  HSE: 'HSE', // new — cross-project visibility only, not admin panel or approval authority
  EXECUTIVE: 'Executive', // Director + VP
  ADMIN: 'Admin',
};

// Every known role, for reference/UI dropdowns. Not a strict linear ladder
// — HSE is a lateral, cross-cutting role rather than a rung between
// Manager and Executive, but is listed in roughly that position since it
// shares Executive's visibility scope.
const ALL_ROLES = [ROLES.STAFF, ROLES.SUPERVISOR, ROLES.MANAGER, ROLES.HSE, ROLES.EXECUTIVE, ROLES.ADMIN];

// Roles that bypass all project/site/department scoping and see everything.
// Used for document/project/site VISIBILITY only — not admin panel access
// (see ADMIN_ROLES below) and not approval authority.
const GLOBAL_ROLES = new Set([ROLES.EXECUTIVE, ROLES.HSE, ROLES.ADMIN]);

// Roles allowed into the admin panel (user management, document-type/
// project/site CRUD, integrations, audit log). Deliberately narrower than
// GLOBAL_ROLES: HSE has full visibility but not admin/management rights.
const ADMIN_ROLES = new Set([ROLES.EXECUTIVE, ROLES.ADMIN]);

// Roles allowed to change a project's status (active/completed/
// maintenance), gated behind also being assigned to that project (checked
// at the route level for non-global roles). Explicit list rather than
// spreading GLOBAL_ROLES, so adding a future visibility-only role (like
// HSE) doesn't silently grant it project-management rights too.
const PROJECT_STATUS_MANAGER_ROLES = new Set([ROLES.MANAGER, ROLES.EXECUTIVE, ROLES.ADMIN]);

// Roles whose document access is scoped to their assigned department
// and/or projects (as opposed to Staff, who only see documents they sent
// or received). Manager is treated the same as Supervisor here — matches
// the confirmed chart, where a Manager's direct reports share the
// Manager's access level.
const PROJECT_SCOPED_ROLES = new Set([ROLES.SUPERVISOR, ROLES.MANAGER]);

function isGlobalRole(role) {
  return GLOBAL_ROLES.has(role);
}

function isAdminPanelRole(role) {
  return ADMIN_ROLES.has(role);
}

function canManageProjectStatus(role) {
  return PROJECT_STATUS_MANAGER_ROLES.has(role);
}

function isProjectScopedRole(role) {
  return PROJECT_SCOPED_ROLES.has(role);
}

module.exports = {
  ROLES,
  ALL_ROLES,
  isGlobalRole,
  isAdminPanelRole,
  canManageProjectStatus,
  isProjectScopedRole,
};
