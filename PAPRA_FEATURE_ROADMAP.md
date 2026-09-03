# Papra-Inspired Feature Roadmap

Source-level analysis of `reference/papra/papra-server` (branch
`reference/papra-ui-ux`), mapping each previously-identified Papra feature
onto DocHandler's actual stack, with a recommended build order. Follow the
"1-Feature Rule" — each numbered item below is its own session/patch, not a
single mega-change.

**One structural difference to keep in mind throughout:** Papra is
multi-tenant SaaS (SQLite + Drizzle ORM, everything scoped by
`organizationId`, with a `plans`/`subscriptions`/`plan-entitlements` layer
gating feature limits per paying customer). DocHandler is a single-tenant
internal tool (Postgres + raw `pg`, scoped by `department_id`/`project_id`/
`site_id`). Every port below drops the multi-tenancy and billing-entitlement
layers — they're not "missing," they're intentionally not applicable.

---

## Recommended order

1. Custom Properties
2. Tags
3. Tagging Rules (depends on Tags)
4. OCR / Content Extraction
5. Full-Text Search (depends on #4 for document-body search to be meaningful)
6. Document Share Links
7. Ingestion Folders
8. Intake Emails (recommend redesigning rather than porting — see below)
9. API Keys / Webhooks / SDK (defer until a concrete integration need exists)

Rationale for the order: 1–3 are cheap, self-contained, and make every
document immediately more useful to organize/filter — good early wins. 4–5
are coupled (search needs something to search) and answer the OCR-tooling
question that was already tabled separately. 6 is a small, isolated
feature. 7–9 are progressively more infrastructure-heavy with progressively
less certain payoff for an internal office tool — good candidates to
revisit only if a real need shows up, rather than building speculatively.

---

## 1. Custom Properties

**Papra:** `custom-properties.table.ts` — `custom_property_definitions`
(name, key, type: text/number/date/boolean/select, JSON `config`,
`display_order`) + `document_custom_property_values` (one row per
document/property pair, with a separate typed column per value type —
`text_value`, `number_value`, `date_value`, `boolean_value`,
`select_option_id` — rather than a single stringly-typed column). Clean
EAV-style pattern, portable as-is to Postgres.

**DocHandler port:** New migration — `custom_property_definitions` table
(scoped by `department_id` or global, admin-managed) and
`document_custom_property_values`. Admin CRUD UI similar in shape to the
existing document-types admin page. Document upload/detail forms render
whatever properties are defined for that document's type. **Complexity:
Medium.** No dependencies on other items in this list — good first pick.

## 2. Tags

**Papra:** `tags.table.ts` — simple `tags` (name, normalized_name, color,
description) + `documents_tags` join table. About as simple as this list
gets.

**DocHandler port:** Two small tables, a tag-picker on upload/detail forms,
a tag filter alongside the existing Project/Site/Person filters on
Inbox/Sent. **Complexity: Small.** No dependencies.

## 3. Tagging Rules

**Papra:** `tagging-rules.tables.ts` — a rule has a `condition_match_mode`
(`all`/`any`), a list of `tagging_rule_conditions` (field + operator +
value + case-sensitivity), and a list of `tagging_rule_actions` (which
tag(s) to apply). `applyTaggingRule()` evaluates conditions against a
single document at creation time; `applyTaggingRuleToExistingDocuments()`
does the retroactive pass — batches through all existing documents via a
paginated iterator (`batchSize: 100`) and applies the rule to each.

**DocHandler port:** `tagging_rules` + `tagging_rule_conditions` +
`tagging_rule_actions` tables. Condition fields would be DocHandler-
specific (filename, document type, project, site, sender department,
custom property values once #1 exists) rather than Papra's field set.
Retroactive apply = same paginated-loop pattern, run as a background task
(matches the existing "respond immediately, poll status" pattern already
used for the Drive backfill feature). **Complexity: Medium.** Depends on
Tags (#2); benefits from Custom Properties (#1) existing first if you want
rules to condition on custom fields.

## 4. OCR / Content Extraction

**Papra:** A clean strategy pattern (`content-extraction.usecases.ts`) —
tries each configured strategy in order (`docling`, `mistral-ocr`,
`azure-di`, `custom-http`, a local `lecture` package) via a shared
`canExtractTextFromDocument()` / `extractTextFromDocument()` interface;
first strategy that can handle the file type wins, with errors from failed
attempts collected into an `AggregateError` if all strategies fail.

**DocHandler port — this also answers the previously-tabled OCR tooling
question.** Given the stated priority (ease of use, computational
efficiency) and that DocHandler is self-hosted without Azure/Mistral API
budgets, Papra's multi-cloud-provider fallback chain is more than needed.
A pragmatic two-strategy version of the same pattern:
- **Strategy 1 — native text extraction** for already-text PDFs/docx (no
  OCR needed, fast, free): a `canExtractTextFromDocument` check that just
  tries pulling embedded text and succeeds if it's non-empty.
- **Strategy 2 — `tesseract.js`** as the OCR fallback for scanned
  PDFs/images: canExtractTextFromDocument = "is it image-like or did
  strategy 1 return nothing." Runs in-process (no external service to
  stand up), which fits "ease of use," at the cost of being slower than a
  cloud OCR API — acceptable trade-off per the stated "computational
  efficiency" priority meaning "cheap to run," not "fastest possible."

Runs as an async task after upload (matches the existing "auto-create
approval chain, best-effort, never fails the upload" pattern from the
document-types work) storing extracted text on the document row (new
`content_text` column). **Complexity: Medium-Large** (the OCR path itself
is straightforward with `tesseract.js`; the async task-queue plumbing is
the larger piece, since DocHandler doesn't currently have a generic
background-job system — `node-cron` handles scheduled digests but not
one-off async work). No dependencies, but full-text search (#5) is only
meaningful once this exists.

## 5. Full-Text Search

**Papra:** SQLite FTS5 virtual table (`database-fts5.repository.ts`),
custom query-builder for their search syntax, kept in sync with the main
documents table via events.

**DocHandler port:** Postgres has native full-text search
(`tsvector`/`tsquery` + GIN index) — actually simpler to stand up than
replicating FTS5, no separate virtual-table sync mechanism needed. Add a
generated `tsvector` column on `documents` (filename + `content_text` from
#4 + notes), GIN index on it, a search endpoint using `plainto_tsquery` or
`websearch_to_tsquery`. **Complexity: Small-Medium** given Postgres does
most of the work. Depends on #4 for document-body search to have anything
beyond filename/metadata to search.

## 6. Document Share Links

**Papra:** `document-share-links.table.ts` — a token-based public link per
document, with optional `expiresAt`, `passwordHash`, `isEnabled`,
`lastAccessedAt`. Straightforward.

**DocHandler port:** One table, a "Share" button on the document detail
view generating a signed/random token URL, a public (unauthenticated)
route that checks expiry/password before serving the file. **Complexity:
Small.** No dependencies — could actually be pulled earlier in the
sequence if wanted; placed here mainly because it's lower-value than 1-3
for an internal-approval-workflow tool where most access is already
role-gated.

## 7. Ingestion Folders

**Papra:** `chokidar` file-system watcher on a configured root path, glob
matching via `picomatch`, a `PQueue` for bounded-concurrency processing,
moves files to done/error subfolders after processing.

**DocHandler port:** Same pattern would work if there's a network share
or local folder the office already drops files into. Needs `chokidar` +
`p-queue` as new dependencies, a background watcher process (or poll on an
interval if a true fs-watcher isn't reliable on whatever the deployment
host is), and reuses the existing upload usecase under the hood.
**Complexity: Medium.** No dependencies. Worth confirming there's an
actual folder/workflow this would serve before building it — speculative
otherwise.

## 8. Intake Emails

**Papra's version is not a good porting candidate as-is.** It's deeply
wired into their SaaS billing (`checkIfOrganizationCanCreateNewIntakeEmail`
checks plan entitlements/subscription limits before allowing a new intake
address), multi-tenant username generation, and a dedicated email-receiving
driver/webhook infrastructure. None of the plan/subscription machinery
applies to a single-org internal tool.

**If wanted for DocHandler**, this would be a much smaller, from-scratch
design: one shared intake mailbox (e.g. `documents@pilarenergi.com`) parsed
via IMAP polling or a provider webhook (SendGrid/Mailgun inbound parse),
attachments run through the normal upload usecase. That's "inspired by,"
not "ported from." **Complexity: Large**, and lowest-confidence value of
anything on this list — recommend treating as a separate ask-first
conversation rather than default sequencing, not just deferred like #9.

## 9. API Keys / Webhooks / SDK

**Papra:** `api-keys` module (hashed keys, scoping, middleware), `webhooks`
module (SSRF-protected HTTP client with allowed-hostname list, retry via
`triggerWebhooks`/`deferTriggerWebhooks`), plus a published `api-sdk`
package.

**DocHandler port:** All standard, well-understood patterns, but the
highest infrastructure cost on this list (auth scoping design, rate
limiting, SSRF protection, retry/backoff, and — if an SDK is wanted — a
whole separate publishable package). **Complexity: Large.** Recommend
deferring until there's a concrete integration need (e.g. "the accounting
system needs to pull approved documents automatically") rather than
building speculative API surface — this is the one item on the list where
building it "because Papra has it" isn't a good enough reason on its own.

---

## Open questions before starting #1

- Should Custom Properties be global or scoped per-department (like
  document types already are)? Papra scopes per-organization, which maps
  most naturally to "global" in DocHandler's single-tenant model, but
  per-department properties might make more sense (e.g. Finance wants an
  "Invoice Number" property that's meaningless outside Finance docs).
- Confirm there isn't already a `content_text`-shaped column collision
  risk — checked current schema, there isn't one yet, but worth a fresh
  `\d documents` before #4's migration given past silently-unapplied-
  migration issues.
