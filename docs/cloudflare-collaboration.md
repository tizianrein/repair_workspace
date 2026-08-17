# Cloudflare shared condition layers

Repair Workspace keeps its existing interface and local undo/history model.
Cloudflare adds a shared project template plus one condition layer per typed
participant name.

## Current deployment

Provisioned and verified on 17 August 2026:

- Repair Workspace: `https://repair-workspace.vercel.app`
- Collaboration Worker: `https://repair-workspace-collaboration.familie-rein.workers.dev`
- D1 database: `repair-workspace-db`
- R2 bucket: `repair-workspace-files`

The production Vercel environment already contains `VITE_COLLAB_API_URL`, and
the current Vercel domains are present in `ALLOWED_ORIGINS`. The setup steps
below are only needed when recreating the backend in a different account.

## What is implemented

- Loading an example creates or updates a stable shared project such as
  `example:chapel_foot`, then asks for a participant name.
- Loading a workspace JSON creates a new shared project and then asks for a
  participant name.
- **Start shared project** publishes the currently loaded custom artefact.
- Entering an existing name loads that name's condition layer.
- Entering a new name starts an empty condition layer.
- **My conditions** loads the active name's editable layer.
- **All conditions** loads every participant's conditions read-only.
- Condition changes are saved after a short debounce while the normal local
  Repair Workspace persistence continues as a fallback.
- The link button copies a URL containing the shared `project` identifier.

The current implementation deliberately keeps Vercel for the existing
frontend and Gemini endpoints. A small Cloudflare Worker owns collaboration,
D1 owns records, and R2 is ready for shared model files. This staged setup
avoids changing the Repair Workspace UI or rewriting the AI endpoints.

## Architecture

```text
Repair Workspace on Vercel
  ├─ existing /api/chat, /api/propose, image and plan endpoints
  └─ browser calls Cloudflare collaboration Worker
       ├─ D1: project templates and participant condition layers
       └─ R2: optional uploaded GLB/GLTF models
```

## 1. Create the Cloudflare resources

From the repository root:

```powershell
npx wrangler login
npx wrangler d1 create repair-workspace-db
npx wrangler r2 bucket create repair-workspace-files
```

The D1 command prints a `database_id`. Put that value in the `DB` entry in
`cloudflare/wrangler.jsonc` before applying migrations.

## 2. Allow the Repair Workspace origins

In `cloudflare/wrangler.jsonc`, set `ALLOWED_ORIGINS` to a comma-separated
list. Include local Vite and every deployed Repair Workspace origin:

```json
"ALLOWED_ORIGINS": "http://localhost:5173,http://127.0.0.1:5173,https://repair-workspace.vercel.app"
```

Do not include paths or trailing slashes.

## 3. Apply the production migration

```powershell
npm run cloudflare:migrate:remote
```

This creates `rw_projects`, `rw_conditions`, and their indexes. Migration SQL
is versioned in `cloudflare/migrations/`.

## 4. Deploy the collaboration Worker

```powershell
npm run cloudflare:deploy
```

Wrangler prints a URL similar to:

```text
https://repair-workspace-collaboration.<account>.workers.dev
```

Check it:

```text
https://repair-workspace-collaboration.<account>.workers.dev/api/collaboration/health
```

The response should be `{"ok":true}`.

## 5. Connect the deployed Repair Workspace

In the Vercel project, add this environment variable for Production:

```text
VITE_COLLAB_API_URL=https://repair-workspace-collaboration.familie-rein.workers.dev
```

Redeploy Repair Workspace. Vite embeds this public API origin at build time.
Database credentials remain inside Cloudflare bindings and never enter the
browser.

## 6. Local development

Create and migrate the local D1 database once:

```powershell
npm run cloudflare:migrate:local
```

Run the collaboration Worker:

```powershell
npm run cloudflare:dev
```

In a second terminal, run Repair Workspace:

```powershell
npm run dev
```

Vite proxies only `/api/collaboration` to port 8787. Existing `/api` requests
still target the Vercel development server on port 3000.

## 7. Workshop flow

### Example project

1. Open Repair Workspace.
2. Select an example in the existing left drawer.
3. Type a participant name.
4. Add or edit conditions normally.
5. Copy the project link and send it to other participants.

### Custom project

1. Load or construct the artefact and its parts.
2. Click **Start shared project** in the existing Data section.
3. Type a participant name.
4. Copy the generated project link.

Loading a workspace JSON starts a shared project automatically.

### Existing name

Click the displayed participant name and type another existing name. That
name's saved layer becomes editable. This is intentionally open and has no
password or ownership verification.

### All conditions

Click **All conditions** in the right drawer. Repair Workspace saves the
current participant's layer, fetches the project aggregate, and renders it
read-only. Each condition card displays its recorded author. Return to
**My conditions** to continue editing.

## Name and data behavior

- Names are trimmed, internal repeated spaces are collapsed, and lookup is
  case-insensitive.
- `Tizian`, `tizian`, and ` Tizian ` address the same layer.
- Anyone who knows a name can open and edit that layer, as requested for the
  password-free workshop.
- D1 soft-deletes missing conditions when a participant snapshot is saved.
- Local browser persistence remains available if a network save fails.
- Shared photographs remain a later step. Current photo blobs continue to
  live in browser IndexedDB and workspace ZIP exports.

## Optional R2 model upload endpoint

The Worker includes an R2-backed model route:

```text
PUT /api/collaboration/projects/:projectId/model
GET /api/collaboration/projects/:projectId/model
```

Example models remain static assets in the repository. A later UI addition
can send a selected GLB/GLTF to this route for custom projects without
changing the condition database.

## Tests

```powershell
npm run test:collaboration
npm run test:cloudflare-api # while npm run cloudflare:dev is running
npm run test:commands
npm run test:migrate
npm run build
```

For an end-to-end test, use two private browser windows, open the same project
link, enter different names, add one condition in each, and verify that **All
conditions** shows both authors.
