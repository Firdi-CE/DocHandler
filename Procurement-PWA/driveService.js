// ==========================================
// Google Drive integration (shared single-account connection)
// ==========================================
// See BACKLOG.md ("Google Drive integration") for the feature brief.
//
// This is intentionally ONE shared connection -- a single Google account,
// connected once by an admin -- rather than per-user OAuth. There's no
// Google Workspace account for the office yet, so there's no clean way to
// do org-wide per-user Drive access; every Drive operation the app makes
// runs as this one connected account.
//
// Built directly on `google-auth-library` (already a dependency, used by
// auth.js for Sign-In) instead of adding the much heavier `googleapis`
// package -- OAuth2Client.request() can call the Drive REST API directly,
// which is all this needs.
//
// Required environment variables:
//   GOOGLE_CLIENT_ID          - OAuth 2.0 Client ID, type "Web application".
//                                Can be the SAME client already used for
//                                Google Sign-In in auth.js, as long as it's
//                                a Web application client with a redirect
//                                URI configured (see below) -- Google
//                                Identity Services sign-in and this
//                                authorization-code flow can share one
//                                client. Or use a separate client if you'd
//                                rather keep them apart.
//   GOOGLE_CLIENT_SECRET      - OAuth 2.0 Client Secret for that client.
//                                (Not needed for the existing ID-token
//                                Sign-In flow, only for this one.)
//   GOOGLE_DRIVE_REDIRECT_URI - Must exactly match an "Authorized redirect
//                                URI" registered on that client, e.g.
//                                https://yourdomain.com/admin/integrations/google-drive/callback
//
// Setup notes for whoever connects the account (see BACKLOG.md):
//   - The connecting Google account must be added as a "Test user" under
//     OAuth consent screen in Google Cloud Console, unless/until the app
//     is verified -- this app requests restricted scopes (Drive), and an
//     unverified app can only be used by accounts on that test-user list.
//   - Expect an "Google hasn't verified this app" warning during consent;
//     that's normal for an internal unverified app -- click
//     Advanced -> Go to [app name] (unsafe) to proceed.

const fs = require('fs');
const { OAuth2Client } = require('google-auth-library');
const db = require('./db');

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = process.env.GOOGLE_DRIVE_REDIRECT_URI;

// Least-privilege scopes:
//  - drive.readonly lets the connected account's EXISTING files be listed
//    and read (needed to "attach an existing file").
//  - drive.file lets the app create and manage NEW files (needed for the
//    upload-backup feature) without granting write access to anything
//    else already in the account.
const SCOPES = [
    'https://www.googleapis.com/auth/drive.readonly',
    'https://www.googleapis.com/auth/drive.file',
    'openid',
    'email',
    'profile',
];

function isConfigured() {
    return !!(CLIENT_ID && CLIENT_SECRET && REDIRECT_URI);
}

function newClient() {
    if (!isConfigured()) {
        throw new Error('Google Drive integration is not configured: set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_DRIVE_REDIRECT_URI.');
    }
    return new OAuth2Client(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
}

function getAuthUrl(state) {
    const client = newClient();
    return client.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent', // force a fresh refresh_token even on reconnect
        scope: SCOPES,
        state,
    });
}

// Exchanges a one-time auth code for a long-lived refresh token, and looks
// up which Google account was actually connected.
async function exchangeCodeForConnection(code) {
    const client = newClient();
    const { tokens } = await client.getToken(code);
    if (!tokens.refresh_token) {
        throw new Error("Google didn't return a refresh token. Revoke the app's existing access at https://myaccount.google.com/permissions and try connecting again.");
    }
    client.setCredentials(tokens);
    const userInfoRes = await client.request({ url: 'https://www.googleapis.com/oauth2/v2/userinfo' });
    return { refreshToken: tokens.refresh_token, email: userInfoRes.data.email };
}

async function getSettings() {
    const res = await db.query('SELECT * FROM integration_settings WHERE id = 1');
    return res.rows[0] || null;
}

async function isConnected() {
    const settings = await getSettings();
    return !!(settings && settings.google_refresh_token);
}

async function saveConnection({ refreshToken, email, connectedByUserId }) {
    await db.query(
        `UPDATE integration_settings
         SET google_refresh_token = $1, google_connected_email = $2,
             google_connected_by = $3, google_connected_at = NOW(),
             google_backup_folder_id = NULL, google_backup_folder_name = NULL,
             updated_at = NOW()
         WHERE id = 1`,
        [refreshToken, email, connectedByUserId]
    );
}

async function disconnect() {
    const settings = await getSettings();
    if (settings && settings.google_refresh_token) {
        try {
            const client = newClient();
            await client.revokeToken(settings.google_refresh_token);
        } catch (e) {
            console.warn('Google token revoke failed (clearing local record anyway):', e.message);
        }
    }
    await db.query(
        `UPDATE integration_settings
         SET google_refresh_token = NULL, google_connected_email = NULL,
             google_connected_by = NULL, google_connected_at = NULL,
             google_backup_folder_id = NULL, google_backup_folder_name = NULL,
             updated_at = NOW()
         WHERE id = 1`
    );
}

// A fresh OAuth2Client per call, credentialed with the stored refresh
// token. request() transparently fetches/refreshes an access token as
// needed -- nothing else to manage. (This does mean each call pays for a
// token refresh round-trip rather than reusing a cached access token
// across requests; at this app's scale that's a fine tradeoff for the
// simplicity of not persisting access tokens at all.)
async function getAuthedClient() {
    const settings = await getSettings();
    if (!settings || !settings.google_refresh_token) {
        throw new Error('Google Drive is not connected.');
    }
    const client = newClient();
    client.setCredentials({ refresh_token: settings.google_refresh_token });
    return client;
}

// Ensures a "DocHandler Uploads" backup folder exists in the connected
// account, creating it on first use. Cached in integration_settings.
async function ensureBackupFolder(client) {
    const settings = await getSettings();
    if (settings.google_backup_folder_id) return settings.google_backup_folder_id;

    const createRes = await client.request({
        url: 'https://www.googleapis.com/drive/v3/files',
        method: 'POST',
        data: { name: 'DocHandler Uploads', mimeType: 'application/vnd.google-apps.folder' },
    });
    const folderId = createRes.data.id;
    await db.query(
        `UPDATE integration_settings SET google_backup_folder_id = $1, google_backup_folder_name = $2, updated_at = NOW() WHERE id = 1`,
        [folderId, 'DocHandler Uploads']
    );
    return folderId;
}

// Mirrors a file already written to local disk into the backup folder.
// Two-step (raw media upload, then a metadata PATCH to name + move it)
// instead of hand-rolling a multipart/related body. Returns
// { id, webViewLink }.
//
// Self-healing: if the cached backup folder ID no longer resolves (e.g.
// someone deleted "DocHandler Uploads" by hand in Drive), a stale ID would
// otherwise silently break every future backup until an admin noticed and
// fixed it in the database directly. Instead, a failed move retries once
// against a freshly-created folder.
async function backupLocalFile({ filePath, displayName, mimeType }) {
    const client = await getAuthedClient();
    const fileBytes = fs.readFileSync(filePath);

    const uploadRes = await client.request({
        url: 'https://www.googleapis.com/upload/drive/v3/files?uploadType=media',
        method: 'POST',
        headers: { 'Content-Type': mimeType || 'application/octet-stream' },
        data: fileBytes,
    });
    const fileId = uploadRes.data.id;

    let folderId = await ensureBackupFolder(client);
    try {
        return await moveIntoFolder(client, fileId, folderId, displayName);
    } catch (moveErr) {
        console.warn('Drive backup folder move failed, recreating the backup folder and retrying once:', moveErr.message);
        await db.query(
            `UPDATE integration_settings SET google_backup_folder_id = NULL, google_backup_folder_name = NULL, updated_at = NOW() WHERE id = 1`
        );
        folderId = await ensureBackupFolder(client);
        return await moveIntoFolder(client, fileId, folderId, displayName);
    }
}

async function moveIntoFolder(client, fileId, folderId, displayName) {
    const patchRes = await client.request({
        url: `https://www.googleapis.com/drive/v3/files/${fileId}`,
        method: 'PATCH',
        params: { addParents: folderId, fields: 'id, webViewLink' },
        data: { name: displayName },
    });
    return { id: patchRes.data.id, webViewLink: patchRes.data.webViewLink };
}

// Lists files in the connected account (for the "attach an existing file"
// browser). Excludes trashed files and folders.
async function listFiles({ query, pageToken } = {}) {
    const client = await getAuthedClient();
    let q = "trashed = false and mimeType != 'application/vnd.google-apps.folder'";
    if (query) {
        // Drive's query language needs backslashes/quotes escaped this way
        // inside a string literal -- see Drive API "Search for files" docs.
        const escaped = query.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        q += ` and name contains '${escaped}'`;
    }
    const res = await client.request({
        url: 'https://www.googleapis.com/drive/v3/files',
        params: {
            q,
            pageSize: 25,
            pageToken: pageToken || undefined,
            fields: 'nextPageToken, files(id, name, mimeType, iconLink, modifiedTime, webViewLink, size)',
            orderBy: 'modifiedTime desc',
        },
    });
    return res.data;
}

// Server-verified metadata for one file -- used so we trust our own
// lookup of what the user picked, rather than trusting client-supplied
// name/link for anything we store.
async function getFileMetadata(fileId) {
    const client = await getAuthedClient();
    const res = await client.request({
        url: `https://www.googleapis.com/drive/v3/files/${fileId}`,
        params: { fields: 'id, name, mimeType, webViewLink' },
    });
    return res.data;
}

// Streams a Drive file's bytes -- for "attach" documents, whose only copy
// lives in Drive (no local file to fall back to).
async function getFileStream(fileId) {
    const client = await getAuthedClient();
    const res = await client.request({
        url: `https://www.googleapis.com/drive/v3/files/${fileId}`,
        params: { alt: 'media' },
        responseType: 'stream',
    });
    return res.data; // a Node readable stream
}

module.exports = {
    isConfigured,
    getAuthUrl,
    exchangeCodeForConnection,
    getSettings,
    isConnected,
    saveConnection,
    disconnect,
    backupLocalFile,
    listFiles,
    getFileMetadata,
    getFileStream,
};
