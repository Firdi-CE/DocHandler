# DocHandler

DocHandler is a document management and approval workflow application built with Node.js, Express, and PostgreSQL. It is designed for internal document intake, processing, approval routing, search, tagging, and document sharing in a structured workflow.

This repository includes the application implementation under `Procurement-PWA/` and supporting project planning and feature documentation at the repository root.

## Overview

DocHandler helps teams manage incoming documents through a workflow that includes:

- Document upload and storage
- Approval chains and role-based access
- OCR/content extraction for text-enabled and scanned documents
- Full-text search over document content and metadata
- Tags and custom document properties
- Shareable document links
- Google Drive integration for attachments and backups
- Folder-based ingestion for scheduled processing

## Tech Stack

- Backend: Node.js + Express
- Database: PostgreSQL
- Authentication: Google OAuth / JWT-style app auth patterns
- OCR: Tesseract.js
- File handling: Multer, PDF parsing
- Email: Nodemailer
- Scheduling: node-cron

## Repository Structure

- `Procurement-PWA/` — main application code
  - `server.js` — Express server and route definitions
  - `auth.js` — authentication logic
  - `contentExtraction.js` — OCR and content extraction helpers
  - `driveService.js` — Google Drive integration
  - `middleware/` — middleware utilities
  - `migrations/` — database migration scripts
  - `public/` — front-end assets and admin pages
  - `utils/` — supporting utilities
- `reference/` — reference implementations and notes
- `BACKLOG.md` — implementation notes and shipped feature log
- `PAPRA_FEATURE_ROADMAP.md` — roadmap and feature sequencing notes

## Key Features

- Document intake and approval workflow
- Role-based visibility and access rules
- OCR and text extraction for uploaded files
- Search by filename, metadata, and extracted document text
- Tagging and custom property metadata
- Shareable links with optional expiry/password control
- Ingestion folder monitoring for automatic processing
- Google Drive attachments and backup workflow

## Getting Started

### Prerequisites

- Node.js (project is configured for a modern Node runtime)
- PostgreSQL instance
- Access to required environment variables for local database and external integrations
- Optional: Google OAuth / Drive credentials if you plan to enable Drive features

### Install dependencies

```bash
npm install
```

### Configure environment

Create a local `.env` file or set the required environment variables for your deployment. At minimum, configure the database connection and any authentication/integration settings needed by the application.

### Run the app

```bash
node Procurement-PWA/server.js
```

Then open the app in your browser using the local development server address and port configured in the app.

## Project Notes

This repository includes a substantial backlog and roadmap, which are useful for understanding the intended feature evolution and architecture decisions. See the following files for background and planning context:

- `BACKLOG.md`
- `PAPRA_FEATURE_ROADMAP.md`

## License

This project is licensed under the ISC license.

## Status

This repository appears to be an active internal workflow application with an implemented backlog of document-management features, including content extraction, tagging, search, share links, and folder ingestion. It is structured as a working application rather than a simple starter template.
