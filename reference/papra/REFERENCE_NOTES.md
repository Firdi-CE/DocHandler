# Papra — UI/UX & Feature Reference

Source: https://github.com/papra-hq/papra (AGPL-3.0)

This is a trimmed, git-history-free snapshot of Papra's `apps/papra-client`
(SolidJS + Shadcn Solid frontend) and `apps/papra-server` (API) directories,
vendored here on a dedicated branch (`reference/papra-ui-ux`) purely as a
design/feature reference for DocHandler's generalization into a company-wide
documents management system.

Not meant to be built, run, or merged into `main` — it's a lookup source for:
- Document list / detail view patterns
- Upload flow UX
- Organization + tag-based document grouping (maps to our `document_types`
  concept)
- Full-text search UX
- Admin/settings screen patterns (relevant to our Phase 3 admin UI)

Pulled: 2026-09-01, from `papra-hq/papra` main branch (shallow clone, no
`.github`/`.changeset`/`apps/{docs,mobile,website}`/other packages).

License note: Papra is AGPL-3.0. This snapshot is for reference/inspiration
only — do not copy code verbatim into DocHandler without checking license
compatibility first.
