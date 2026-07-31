// ==========================================
// Centralized role / capability config
// ==========================================
// PLACEHOLDER — see BACKLOG.md ("Work Sites & Maintenance Lifecycle") for
// context. The org chart used to derive this mapping
// (Struktur_Organisasi_PV_BESS_Installation.pdf) is explicitly provisional.
//
// The `Manager` role added here for the Work Sites feature does NOT match
// the office's real hierarchy yet (that chart has TWO manager tiers --
// Project Manager and Site Manager -- collapsed into one string below).
//
// Everything that needs to know "who can do X" should import a helper from
// this file instead of comparing req.user.role to a string literal inline.
// That way, when the real roles/hierarchy are confirmed, this is the only
// file that needs to change -- e.g. splitting MANAGER into
// PROJECT_MANAGER/SITE_MANAGER, renaming it, or moving it up/down a tier.
//
// Existing role checks elsewhere in server.js (ensureAdmin, the
// download/stream handlers) predate this file and weren't touched, to keep
// this change scoped to the Work Sites feature -- see BACKLOG.md's
// "1-Feature Rule". They'd be reasonable to migrate onto this file later.

const ROLES = {
  STAFF: 'Staff',
  SUPERVISOR: 'Supervisor',
  MANAGER: 'Manager', // placeholder, introduced by the Work Sites feature
  EXECUTIVE: 'Executive',
  ADMIN: 'Admin',
};

// Every known role, in ascending order of scope (for reference/UI dropdowns).
const ALL_ROLES = [ROLES.STAFF, ROLES.SUPERVISOR, ROLES.MANAGER, ROLES.EXECUTIVE, ROLES.ADMIN];

// Roles that bypass all project/site/department scoping and see everything.
// Matches the existing `Executive`/`Admin` bypass used throughout server.js.
const GLOBAL_ROLES = new Set([ROLES.EXECUTIVE, ROLES.ADMIN]);

// Roles allowed to change a project's status (active/completed/maintenance),
// gated behind also being assigned to that project (checked at the route
// level for non-global roles). Provisional: revisit once it's clear
// whether Project Manager and Site Manager should have different rights
// here (see BACKLOG.md open question #1).
const PROJECT_STATUS_MANAGER_ROLES = new Set([ROLES.MANAGER, ...GLOBAL_ROLES]);

// Roles whose document access is scoped to their assigned department
// and/or projects (as opposed to Staff, who only see documents they sent
// or received). Manager is treated the same as Supervisor here per the
// Work Sites brief ("Supervisor or Manager ... fetch documents for
// projects/sites they are assigned to").
const PROJECT_SCOPED_ROLES = new Set([ROLES.SUPERVISOR, ROLES.MANAGER]);

function isGlobalRole(role) {
  return GLOBAL_ROLES.has(role);
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
  canManageProjectStatus,
  isProjectScopedRole,
};
