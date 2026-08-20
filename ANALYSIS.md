# Repair Workspace — Architecture Analysis & Roadmap

Analysis of `repair-workspace` v2.0.0-alpha.5 (schema 2.1.0), 19 Aug 2026.
~15.8k LOC excluding `node_modules`, `dist`, examples.

---

## 1. What you actually have

| Layer | Tech | State |
|---|---|---|
| Frontend | Vanilla ES modules + Vite, no framework | `src/main.js` (2267 lines) + 11 view modules |
| Data model | Command pattern, 33 undoable commands | `src/core/commands.js`, `schema.js` — genuinely good |
| Persistence | `localStorage` (workspace JSON) + IndexedDB (image blobs) | one key, whole-object rewrite per mutation |
| AI | 9 Vercel functions → Gemini 3.7 Flash + 3.1 Flash Image | tool-calling agent loop, 15 tools |
| Collaboration | Cloudflare Worker + D1 (2 tables) + R2 | **conditions only** |
| 3D | Three.js box model + optional `mesh.glb` | works |
| Graphs | Cytoscape + dagre, action DAG + spatial graph | works |

The **command pattern and the schema are the strong parts of this codebase.** Every mutation is a pure function returning `{workspace, inverse}`, `batch` composes them, undo is free. The v2.1 move of intent/constraints onto each plan ("strategies as parallel alternatives") is the right modelling decision for what you're researching. Build on that; don't rewrite it.

Everything else is workshop-grade scaffolding around it.

---

## 2. The root cause behind three of your four asks

**There is no server-side workspace.**

The Cloudflare backend stores exactly two things:

1. `rw_projects.base_workspace` — a **frozen snapshot** of the whole workspace, written **once**, at the moment a project is created (`main.js:2062` → `worker.js:102`). Nothing re-publishes it. Ever.
2. `rw_conditions` — per-participant condition rows, live-synced with a 450 ms debounce (`main.js:506, 2181`).

Plus photo blobs in R2 — but **only** for evidence whose `attachedTo.type === 'condition'` (`main.js:836-842`). Photos on parts, on steps, and every AI rendering never leave the browser.

So: plans/strategies, execution log, conversations, renderings and any edit to the parts model exist **only in `localStorage`**. That single fact produces your reported bug, and blocks two of the other three features.

### Your reported bug, traced

> "if the site is reloaded their repair strategies are gone"

Exact mechanism:

1. `startSharedProject()` calls `history.replaceState` to append `?project=<id>` to the URL (`main.js:2080-2082`). It is invoked automatically on **example load** (`main.js:724`) and on **any JSON/ZIP upload** (`main.js:655`). So virtually every user ends up with `?project=` in their address bar.
2. On reload, `rehydrateProject()` runs `openProjectFromUrl()` **first** (`main.js:2260-2265`), before anything else.
3. That calls `loadSharedProject()` → `loadWorkspaceJson(project.baseWorkspace)` (`main.js:2100`), which **replaces `state.workspace` wholesale** and clears undo history (`main.js:678-683`).
4. `autoPersist` then immediately overwrites `localStorage` with the template.

Result: every strategy, intent, constraint set, step, chat thread and rendering created since the project was started is destroyed, silently, with no undo. Conditions come back — but only after the user retypes their name, because `state.collaboration` is transient (`state.js:21-29`) and never persisted.

There is a second, quieter loss path: reloading **without** `?project=` while `workspace.collaboration.projectId` is still in the restored JSON leaves `state.collaboration.projectId = null`, so `queueCollaborationSave` bails at `main.js:2183` and every subsequent edit is silently local-only.

And a third: bumping `SCHEMA_VERSION` wipes everyone's stored work, because `restore()` (`state.js:68-71`) discards a mismatched version instead of calling `migrateV1ToV2` — which already handles 2.0 → 2.1 (`migrate.js:41-43`). The file-load path migrates; the reload path doesn't.

---

## 3. Fix before anything else (P0 — data loss & correctness)

These are cheap and they block everything downstream.

| # | Issue | Where | Fix |
|---|---|---|---|
| 1 | Reload from `?project=` destroys all local strategies | `main.js:2246-2265`, `2095-2120` | Don't blind-replace. Restore localStorage first; only fetch the project template if the local workspace has no matching `collaboration.projectId`. Then merge, don't overwrite. (Superseded by §6.3, but needed immediately.) |
| 2 | Participant name lost on every reload | `state.js:21-29` | Persist `{projectId, authorName, authorKey}` under a project-scoped localStorage key. |
| 3 | Schema bump wipes stored work | `state.js:63-79` | Route `restore()` through `migrateV1ToV2` like `main.js:672-678` does. |
| 4 | **Condition-ID collision can transfer one participant's data to another** | `schema.js:315-321` + `0001_collaboration.sql:24` + `worker.js:295-300` | `uid()` is `Date.now()` + a per-page counter starting at 0 — **no randomness, no per-user salt**. Two participants creating their first condition in the same millisecond generate the same `cond_…`. The D1 primary key is `(project_id, id)` without `author_key`, and the `ON CONFLICT` clause reassigns `author_key`/`author_name` and clears `deleted_at`. The second saver silently takes over the first's row. Fix: `crypto.randomUUID()` in `uid()`, and add `author_key` to the PK. |
| 5 | ZIP export drops every AI-generated image | `workspace-bundle.js:33` | Filter is `kind === 'photo'`; renderings are written to `workspace.json` as references with no blob. Save→Load loses every generated image. |
| 6 | A workspace with only renderings exports as bare JSON | `main.js:695-702` | `photoCount` counts only `kind === 'photo'`, so the ZIP branch is never taken. |
| 7 | "+ New condition" silently fails on 2 of 3 tabs | `main.js:292` | `querySelector('[data-tab="pane-3d"]')` — the buttons use `data-pane` (`index.html:136-138`). Always `null`, so place mode arms on a hidden canvas. |
| 8 | `intent` and `constraints` read from the wrong place by 4 endpoints | `generate-plan.js:188`, `enrich-plan.js:117`, `synthesize-target-json.js:128`, `modify-target-json.js:48` | They read `ws.intent` / `ws.constraints`. v2.1 moved these onto each plan (`schema.js:24`). All four callers post the raw workspace → **both are `undefined`**. `generate-plan.md` opens with "The workspace's REPAIR INTENT is your most important instruction" — the planner has been running with its primary directive empty. |
| 9 | Object-URL leaks on every keystroke | `main.js:1370, 1444, 1473, 1838` | `renderAll` → `renderImagineResult` runs on every state change and creates fresh `createObjectURL`s with no revoke. |
| 10 | Cloud-stored photos invisible in the imagine flow | `main.js:1365, 1438, 1467, 1505, 1833` | These call `PhotoStorage.get` directly instead of `getPersistedPhoto` (`main.js:805`), which is the only function with the R2 fallback. A photo uploaded on another device renders as "not on this device". |

### And one finding that matters for the paper

> "The AI proposes. The human disposes. Every state-changing AI output goes through the review modal... This is not optional — it's the whole point of the paper's framework." — `README.md`

**This is not true of the shipped code.** The review modal is unreachable.

`runPropose()` has exactly two callers (`main.js:144`, `main.js:191`):

- `quickActions.onPropose` — but `index.html:275` is `<div class="quick-actions" id="quick-actions" style="display: none">`. The inline style beats `components.css:915`. No chip is ever visible.
- `chatSheet.onProposeIntent` — fires only from the legacy `msg.suggestedAction` branch (`chat-sheet.js:231-241`), and **no API endpoint produces `suggestedAction`** (verified by grep across `api/`; the engine returns `followUpOptions` instead).

Meanwhile the live path — chat tool calls — applies commands **immediately and unconditionally** (`chat-sheet.js:356-366` → `main.js:157-183`). The AI can delete a strategy, rewrite the intent or remove conditions with no confirmation. The only affordances are an after-the-fact `<details>` audit card and Ctrl+Z.

Collateral damage: `views/propose-review.js` (128 lines), `views/quick-actions.js` (64), `views/justification-panel.js` (94, never imported), `enrichPlanInBackground` (~85), `isPlanGenerationIntent`, and the `/api/propose`, `/api/generate-plan`, `/api/enrich-plan` endpoints (648 lines) are all orphaned. That is roughly **1,300 lines of dead code**, and part of why the repo feels "quite large".

**Decision required:** either wire the review modal back onto the chat path (and keep the framework claim), or delete the propose stack and rewrite the claim as "reviewable and reversible after the fact". Given what the platform is for, I'd wire it back — but selectively: auto-apply additive/low-risk commands, gate destructive ones (`remove-plan`, `remove-condition`, `remove-step`, `set-intent`) behind the modal.

---

## 4. Feature 1 — ZIP in and out

### Today

`src/core/workspace-bundle.js` already does ZIP via JSZip. Format:

```
workspace.json
photos/<evidenceId>.jpg|.png     ← kind === 'photo' only
```

Missing from the bundle: **renderings**, `mesh.glb`, `instance.coverImage` when it was a URL rather than a data URL, cloud-only photos not yet cached locally, and (once it exists) the corpus. There is no manifest and no bundle version.

The JSON-vs-ZIP decision is a single line (`main.js:695`) keyed on photo count.

### Target format

```
<artefact>.repairws.zip
├── manifest.json                bundleVersion, schemaVersion, exportedAt,
│                                projectId, scope: "layer" | "project", counts
├── workspace.json               scope=layer: the full workspace
├── project.json                 scope=project: artefact + parts + corpus index
├── layers/
│   └── <authorKey>.json         scope=project: one file per participant
├── media/
│   ├── photos/<evidenceId>.<ext>
│   ├── renderings/<evidenceId>.png
│   └── documents/<docId>.<ext>
├── corpus/
│   ├── index.json               doc metadata, kinds, summaries
│   └── text/<docId>.txt         extracted plaintext
└── model/
    ├── mesh.glb                 optional
    └── cover.jpg
```

Two export scopes:

- **My workspace** — one participant's layer + every blob it references. This is the "take my work home" artefact.
- **Whole project** — artefact + corpus + all participant layers. This is the research dataset, and the thing you'll want when analysing how strategies diverged across participants.

Import mirrors it: read `manifest.json`, dispatch on `bundleVersion` and `scope`, migrate `workspace.json` through `migrateV1ToV2`, restore every blob to IndexedDB keyed by its id, and (if online and a project is active) offer to push the layer up.

Always ZIP. Delete the JSON branch — a format that sometimes carries images and sometimes doesn't is a support burden, and `.json` files silently missing images is exactly how the current build loses data.

**Effort:** small. `workspace-bundle.js` is 114 lines and the shape is already right. Roughly a day, mostly on the manifest and on the project-scope export.

---

## 5. Feature 2 — the shared corpus

### Today

**Nothing.** No `.pdf`, `.docx`, `.txt` or `.md` string appears anywhere in `src/`. The four file inputs accept `image/*` or `.json,.zip` only.

But the seams are already cut:

- `EVIDENCE_KIND` already includes `'document'` and `'note'` (`schema.js:38`) — declared, never produced or consumed. `newEvidence('document', {...})` validates today.
- `PhotoStorage` (`photo-storage.js`) is a kind-agnostic `id → {blob, mime, name}` IndexedDB store.
- `CollaborationApi.uploadEvidence` PUTs a raw blob with `Content-Type` from the blob (`collaboration.js:190`) — already generic. The worker's `image/*` check (`worker.js:366`) is the only blocker.
- `slim()` in `ai-payload.js:101-111` already passes an evidence `text` field through to the model.

### Design

**Corpus is project-level, not participant-level.** Everyone uploads into one pool; everyone's AI can read it. That matches your framing ("a base for the LLM to derive information about the structure or also the goal for repair").

**Storage:**

```sql
CREATE TABLE rw_corpus_docs (
  project_id   TEXT NOT NULL,
  id           TEXT NOT NULL,
  filename     TEXT NOT NULL,
  mime_type    TEXT NOT NULL,
  byte_size    INTEGER NOT NULL,
  doc_kind     TEXT NOT NULL,   -- 'structure' | 'goal' | 'technique' | 'reference'
  uploaded_by  TEXT,
  r2_key       TEXT NOT NULL,   -- projects/<id>/corpus/<docId>
  text_key     TEXT,            -- projects/<id>/corpus/<docId>.txt
  summary      TEXT,            -- 2-4 sentence LLM summary, written at ingest
  status       TEXT NOT NULL,   -- 'uploaded' | 'ingesting' | 'ready' | 'failed'
  created_at   TEXT NOT NULL,
  PRIMARY KEY (project_id, id)
);
```

Blobs in R2 alongside the existing evidence keys. New routes: `PUT/GET/DELETE /projects/:id/corpus/:docId`, `GET /projects/:id/corpus`.

`doc_kind` is worth the extra field. "This PDF describes the structure" and "this PDF states the repair goal" are different prompt roles, and asking the uploader to tag it is one dropdown that saves a lot of prompt ambiguity later.

**Text extraction — the real decision.** Four options:

| Option | Cost | Verdict |
|---|---|---|
| Client-side (pdf.js + mammoth.js) | ~1 MB of JS, fragile on mobile | no |
| In the Worker | no usable PDF libs | no |
| Vercel function (`pdf-parse`, `mammoth`) | Node runtime, easy | yes, for docx/txt/md |
| **Pass bytes straight to Gemini** | Gemini 3 reads PDFs natively as `inline_data` | **yes, for PDFs and images** |

Recommended: **hybrid ingest.** On upload, one `POST /api/ingest-document` call that sends the document to Gemini and gets back `{summary, plainText, extractedFacts}`. Store all three. That single call replaces an entire extraction pipeline, handles scanned PDFs (OCR is free at that point), and gives you a summary you'd have wanted anyway.

**Retrieval — make it a tool, not context stuffing.** This is where your token worry gets answered. Add to `chat-tools.js`:

```js
search_corpus({ query, docKinds?, maxResults? })
  → [{ docId, filename, docKind, summary, excerpts: [...] }]

read_corpus_document({ docId, pages? })
  → full text, or the raw bytes as inline_data for a specific PDF
```

Default context carries only the corpus **index** (filename + kind + one-line summary per doc — maybe 40 tokens each). The model pulls the full document only when it decides it needs it. A 50-document corpus costs ~2k tokens of index instead of ~500k of content.

For a workshop-scale corpus (tens of documents) keyword/BM25 over the stored plaintext inside the Worker is enough. If it grows past a few hundred documents, chunk + embed with `gemini-embedding-001` and put the vectors in **Cloudflare Vectorize** — you're already on that platform, and it slots in behind the same `search_corpus` tool signature without touching the prompt.

**UI:** a "Project corpus" section in the left drawer with a drop zone (`accept=".pdf,.docx,.txt,.md,.jpg,.jpeg,.png"`), a list showing filename / kind / status / uploader, and per-doc delete. Plus a corpus indicator in the chat sheet so participants can see what the AI can read.

**Effort:** medium. ~2–3 days for upload + ingest + index-in-context; another day for the tool-based retrieval.

---

## 6. Feature 3 — login, and strategies that survive a reload

### Today

- Identity = a typed-in name, lowercased into `authorKey` (`collaboration.js:61-67`). No password, no token, no session, no ownership record anywhere in the Worker.
- Retyped on every reload (`state.js:21-29`).
- Same name = same layer, by design (`docs/cloudflare-collaboration.md:157-163`). Two Annas in one workshop share and overwrite each other, second saver wins.
- Only conditions sync. Strategies don't exist server-side at all.
- `example:<slug>` project ids are trivially derivable (`collaboration.js:74-76`), so every example project is world-readable **and world-writable**.

### 6.1 Identity — three tiers, pick one

| Tier | Mechanism | Good for |
|---|---|---|
| **A. Persist what exists** | Store `{projectId, authorName, authorKey}` in localStorage; restore on load | Removes the retyping. 30 minutes of work. Does nothing about impersonation. |
| **B. Name + PIN** (recommended) | On first use of a name, ask for a 4–6 digit PIN. Store `pbkdf2(pin, salt)` in D1. Subsequent logins verify. Server returns a signed session token (HMAC with a Worker secret, 30-day expiry), stored in localStorage. | Workshop-appropriate. No accounts, no email, no password reset drama. Makes a name actually yours, makes same-name collisions an explicit error instead of silent data merging, and gives every write an authenticated author. |
| **C. Real auth** | Cloudflare Access, or magic links | Overkill unless this leaves the workshop context. |

Go with **B**. It's maybe 150 lines in the Worker and one modal change, and it's the minimum that lets you say "these strategies were authored by this person" in a paper.

Whatever you pick, add `Authorization: Bearer <token>` checks to every mutating Worker route. Right now `PUT /projects/:id` lets anyone overwrite any project's template, including every `example:*` project (`worker.js:102-141`).

### 6.2 Persist strategies — the schema change

Generalise "condition layer" → **participant layer**. Replace `rw_conditions` with:

```sql
CREATE TABLE rw_layers (
  project_id    TEXT NOT NULL,
  author_key    TEXT NOT NULL,
  author_name   TEXT NOT NULL,
  layer_r2_key  TEXT NOT NULL,   -- projects/<id>/layers/<authorKey>.json
  rev           INTEGER NOT NULL DEFAULT 1,
  condition_ct  INTEGER NOT NULL DEFAULT 0,
  plan_ct       INTEGER NOT NULL DEFAULT 0,
  rendering_ct  INTEGER NOT NULL DEFAULT 0,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (project_id, author_key)
);
```

The layer JSON body carries `{conditions, plans, evidence, conversations, executionLog}`.

**Put the body in R2, not D1.** D1 keeps only metadata. Reasons: the current 1.8 MB D1 cap (`worker.js:266`) will be hit fast once conversations are included, R2 has no practical limit, and the counts in D1 are enough to render the participant roster and a "compare strategies" view without fetching every layer.

Keep `rev` for optimistic concurrency: client sends the rev it last read, Worker rejects with 409 on mismatch. This is what makes two tabs (a known issue in `docs/known-issues.md`) fail loudly instead of silently clobbering.

**Sync strategy:** the current whole-layer snapshot replace on a 450 ms debounce is fine at workshop scale and is far simpler than a CRDT. Keep it. Just widen what it covers, and add: save on `visibilitychange`/`beforeunload`, retry with backoff on failure, and a visible "unsaved changes" indicator — currently a failed save is a one-line status message and then silence (`main.js:2203`).

### 6.3 Project vs layer — draw the line explicitly

| Scope | Contents | Who writes | Where |
|---|---|---|---|
| **Project** | artefact (`instance` + parts), cover, mesh, corpus, title | project owner (or anyone, until locked) | `rw_projects` + R2 |
| **Layer** | conditions, plans/strategies, evidence, renderings, conversations, execution log | one participant | `rw_layers` + R2 |

That split is exactly what your research needs: everyone surveys the same object, each produces their own conditions **and their own strategies**, and you can then diff strategies across participants for the same artefact. The existing "My conditions / All conditions" toggle (`index.html:208-211`) generalises straight into "My strategies / All strategies" — a compare view showing N participants' action graphs side by side for the same artefact is close to free once layers exist, and it's arguably the most interesting output of the whole platform.

The artefact currently gets frozen into `base_workspace` at project creation and never updated. Make it an explicit project-level record with its own `PUT /projects/:id/artefact` route, and decide whether participants may edit it (probably: yes during setup, locked once the first layer has conditions).

**Effort:** medium-large. ~3–4 days for the migration, Worker routes, client sync rewrite, and the identity tier. This is the piece everything else leans on — do it before the corpus.

---

## 7. Feature 4 — image generation as a first-class, consistent representation

This is the most interesting part of what you're proposing, and the part where the current implementation is furthest from the goal.

### Today

Three-stage pipeline, all in `main.js:1859-1997`:

```
photo → /api/describe-photo   → Ist  {subject{parts[]}, scene{}}
Ist + workspace → /api/synthesize-target-json → Soll (same shape) + rationale
Soll + photo → /api/imagine-result (gemini-3.1-flash-image) → PNG
```

Refinement (`main.js:1497`) goes `/api/modify-target-json` → new Soll → `/api/imagine-result` again.

The review modal (`index.html:334`) is **two raw JSON textareas** side by side — `#ist-textarea` readonly, `#soll-textarea` editable.

**The Soll is a sibling of the plan, not a function of it.** That is the architectural problem. Consequences:

- `/api/imagine-result` returns **no commands**. Nothing it produces can ever reach the workspace.
- The model's own accompanying `text` is returned by the endpoint and **discarded** by the client (`main.js:1557, 1961`).
- Editing the Soll in the textarea, or refining with "make the beam spliced instead of replaced", mutates **only the Soll**. The plan that supposedly produced that target state is untouched. Plan and image diverge immediately and permanently.
- Nothing runs `describe-photo` on the generated rendering, so there's no check that the image matches the target.
- On refinement the source photo is **discarded** server-side (`imagine-result.js:56-58`) despite comments in both `imagine-result.js:16` and `main.js:1490` claiming both references are passed. So refined images drift away from the actual artefact — and the client still uploads the unused photo, wasting ~400 KB per call against Vercel's 4.5 MB body limit.
- Renderings sort by `createdAt`, but `newEvidence` sets `capturedAt` (`schema.js:144`). Every comparison is `0 - 0`, so "newest first" is insertion order — the **oldest** rendering displays as active, and thumbnails read 1970.

### Target architecture

**Make the Soll a derived projection, never an independently-edited document.**

```
Soll = project(Ist, artefact, plan, selectedStepId?)
```

Everything follows from that.

#### 7.1 Image generation moves into chat, as tools

Add to `chat-tools.js`:

```js
render_target_state({ planId, upToStepId?, sourcePhotoId?, note? })
revise_rendering({ renderingId, instruction })
```

`render_target_state` recomputes the Soll from the current plan and generates. Straightforward.

`revise_rendering` is the important one, and it must **not** call the image model first. It runs a *reconcile* pass:

> Given this instruction, the current plan, and the current Soll — emit (a) the workspace commands that make the plan express this change, and (b) the Soll implied by the updated plan.

The commands go through the normal command pipeline (undoable, reviewable). Only then does image generation run, from the reconciled Soll. So "make it spliced instead of replaced" edits the action graph first and the picture second — which is the consistency guarantee you're after, and it inverts the current causality.

#### 7.2 Provenance and staleness — this is your token answer

Stamp every rendering with what it was derived from:

```js
{
  kind: 'rendering',
  createdAt,                    // ← fix: currently capturedAt
  basedOn: {
    planId, planRev,            // planRev = hash of steps + edges + mutexGroups
    sollHash,
    sourceEvidenceId,
    previousRenderingId,
    upToStepId
  },
  review: { status: 'pending'|'accepted'|'rejected', by, note, at },
  stale: false
}
```

On every render, recompute `planRev` and compare. Mismatch → set `stale: true`, show a badge and a **Regenerate** button.

**Never auto-regenerate.** You raised exactly this concern and the answer is: track staleness, don't chase it. The user sees "this picture is 3 plan edits out of date" and decides whether it's worth the tokens. That's honest, cheap, and it makes divergence *visible* rather than silent — which is arguably a better research instrument than automatic consistency would be.

#### 7.3 The review step you asked for

Two layers, and they're complementary:

**Human review** — after generation, a card with Accept / Reject / Revise. Store `review.status`, `review.by`, `review.note`. Rejected renderings stay in history, dimmed. This gives you a dataset of which AI-proposed visualizations practitioners accepted and why — a genuinely publishable artefact.

**Automatic verification** — feed the generated image back through `describe-photo` to get `Ist'`, then diff `Ist'` against the Soll. Report "the target said the beam is spliced with a scarf joint; the render shows a full replacement." One flash call, no image generation, ~2k tokens. Cheap enough to run on every render, and it closes the loop you described.

#### 7.4 The consistency triple

You want spatial/assembly model ↔ action model ↔ image always coherent. Make the dependency direction explicit and one-way:

```
artefact (parts, geometry)
        ↓
    conditions
        ↓
   plan / strategy  ←──── chat tools mutate here
        ↓
       Soll         ←──── derived, never hand-edited
        ↓
     rendering      ←──── stamped with planRev; goes stale, never silently wrong
```

Edits always enter at the plan level. The Soll and the image are downstream projections. When an edit *arrives* at the image level (a refine instruction), it is **translated upstream into plan commands first** — that's `revise_rendering`. There is then only one place state can change, and consistency is structural rather than maintained by convention.

If you later want the image to influence the *spatial* model too (e.g. the render reveals a joint geometry the box model doesn't have), that's the same pattern one level up: an `update_artefact` tool that emits `upsert-part` commands. The `design-joinery` endpoint (currently orphaned — only reachable from `tests/test-design-joinery.mjs`, 305 lines + a 135-line prompt) is already most of the machinery for that, and it's the **only** endpoint that reads intent from the correct place (`design-joinery.js:187`). Worth reviving rather than deleting.

**Effort:** medium-large. ~3–4 days for tools + reconcile + provenance + review UI. The reconcile prompt is the hard part and will need iteration.

---

## 8. On "it is quite large"

It's ~15.8k lines, and a meaningful fraction is dead or duplicated.

**Delete or revive (~1,300 lines):** the entire propose stack — `views/propose-review.js`, `views/quick-actions.js`, `views/justification-panel.js` (never imported), `runPropose`, `isPlanGenerationIntent`, `enrichPlanInBackground`, and `/api/propose`, `/api/generate-plan`, `/api/enrich-plan`. See §3. My recommendation: revive `propose-review.js` onto the chat path for destructive commands, delete the rest.

**Delete outright (~400 lines):** `api/chat.js.bak` (still references `ws.hypotheses`, the v1 field name), `src/ai/prompts/chat.md.bak`, `streamGeminiWithTools` (`gemini.js:356-494`, zero callers), the unreachable viewer-3D re-init branch (`main.js:522-542`, a verbatim copy of `195-213`), `main.js:994` `escapeHtml` (unused), `state.js`'s `setWorkspace`/`clearPersisted`/`notify` (no callers).

**Deduplicate:** `escapeHtml` is defined **7 times** across `main.js`, `entity-list.js`, `propose-review.js`, `execution-log.js`, `justification-panel.js`, `chat-sheet.js`, `detail-editor.js`. `leanWorkspace`/`redactWorkspace`/`slim` exists **5 times** with five different field sets that disagree about where `intent` lives and whether parts are `name` or `label` — that disagreement is the direct cause of bug #8 in §3. One shared `src/core/dom-utils.js` and one shared `buildAiPayload(workspace, {scope, include})` would remove both classes of bug permanently.

**Split `main.js`.** 2267 lines, 136 `$('...')` calls against ~95 distinct DOM ids, and it's simultaneously the DI container, the DOM controller, the AI HTTP client, the image pipeline, the example loader and the collaboration client. Nothing is exported except one function that's also stapled onto `window`. Suggested split, no framework needed:

```
src/app/
  boot.js            wiring + boot sequence
  workspace-io.js    load / save / examples / reset
  ai-client.js       all fetch() calls to /api/*
  imagine.js         the Soll/Ist pipeline
  collaboration.js   project + layer sync (client side)
  render.js          renderAll and its sub-renders
```

Also: there are **two competing mutation channels**. The sanctioned `apply(state, cmd)` (undoable, validated) and direct `state.workspace = ...` + hand-fired listeners in **9 places** (`main.js:685, 774, 1208, 1281, 1720, 1793, 1850, 2039, 2078`). The second kind is un-undoable and bypasses validation — and Ctrl+Z after one of them replays an older command against a workspace that changed out-of-band. Every one of those nine should become a command.

---

## 9. Security, before this is public

Currently: **no auth, no rate limiting, no origin enforcement** on any of the 9 Vercel endpoints or any of the 10 Worker routes.

| Risk | Detail |
|---|---|
| Unbounded Gemini spend | Anyone with the URL can drive `/api/chat`, which runs up to 12 model calls at 32k output tokens each, plus up to 3 more from retry paths. `/api/imagine-result` bills image generation per call. |
| Free Gemini proxy | `userMessage` and `soll.subject`/`soll.scene` are unconstrained free text interpolated into prompts with no sanitisation (`imagine-result.js:113-130`). |
| Anyone can overwrite any project | `PUT /projects/:id` has no auth (`worker.js:102`). `example:<slug>` ids are derivable. |
| `PUT /projects/:id/model` has **no size limit at all** | `worker.js:325-339` — unlike evidence's 6 MB cap. Reachable by anyone. Unused by the UI. |
| Error responses leak upstream detail | 500s return Gemini's raw error body (`gemini.js:52`); 502s echo the model's full unvalidated output. |
| CORS defaults to `*` | `worker.js:27`, and a request with no `Origin` header is always allowed (`:32-34`) — `curl` bypasses it entirely. |
| Prompt injection into 14 mutating tools | `chat.md` has no data-vs-instructions guard, chat accepts user images, and chat commands are applied **without review**. `design-joinery.md:23` is the only prompt with such a guard. Once a corpus exists — user-uploaded PDFs going into the same context — this stops being theoretical. |
| Unbounded chat history | `payloadForChat` truncates to 8 messages, but `leanWorkspace` discards that and the engine builds history from the raw `thread` with no slice (`chat-engine.js:181`). A 200-message thread ships 200 turns × 12 loop iterations. Base64 photos ride along in the thread and will hit Vercel's 4.5 MB body limit at ~8 attached photos. |

Minimum before a public URL: a shared-secret header or Vercel Password Protection on `/api/*`; per-IP rate limits on `chat` and `imagine-result`; a body-size cap; server-side `thread.messages` truncation; and generic error messages with detail logged rather than returned.

Also worth noting: `vercel.json` has no `functions` block, so the prompt `.md` files are reached via `fs.readFileSync(process.cwd() + '/src/ai/prompts/...')` (`prompts.js`) with **no `includeFiles` directive**. This works under `vercel dev` (cwd is the repo root) and may work in production by accident via `@vercel/nft` tracing heuristics — but if tracing misses, six of nine endpoints 500 immediately while the three with inline prompts keep working. Add `"functions": {"api/**/*.js": {"includeFiles": "src/ai/prompts/**"}}`, or switch to `import.meta.dirname`. Also: `maxDuration: 90` on three endpoints exceeds Vercel's Hobby-plan 60 s ceiling.

---

## 10. Sequenced roadmap

**Phase 0 — stop the bleeding (2–3 days)**
Fix §3 items 1–10. Especially: reload data loss, ID collision, ZIP dropping renderings, and the `intent`/`constraints` misread that has been silently degrading every plan the platform has ever generated. Decide the propose-review question.

**Phase 1 — server-side layers (3–4 days)**
`rw_layers` migration, R2 layer bodies, `rev`-based concurrency, name+PIN identity, session token, auth on mutating routes, persisted session. **This is the keystone** — the corpus and the image loop both want authenticated per-author server state. Do it first.

**Phase 2 — bundle format (1–2 days)**
Manifest, both export scopes, all blob kinds, always-ZIP. Cheap once layers exist, and it's what makes the workshop output archivable.

**Phase 3 — corpus (3–4 days)**
`rw_corpus_docs` + R2 + routes, `POST /api/ingest-document` (Gemini-native extraction), index-in-context, `search_corpus` / `read_corpus_document` tools, upload UI. Add the prompt-injection guard to `chat.md` in the same pass — this is the change that makes it necessary.

**Phase 4 — image consistency loop (3–4 days)**
`render_target_state` / `revise_rendering` tools, the reconcile pass, `basedOn` provenance + `planRev` staleness, review card with accept/reject, automatic Ist′-vs-Soll verification. Fix the discarded source photo and the `createdAt`/`capturedAt` sort bug on the way in.

**Phase 5 — cleanup (2–3 days, can run in parallel)**
Delete the dead ~1,700 lines, deduplicate `escapeHtml` and the five payload slimmers, split `main.js`, convert the 9 direct mutations to commands.

**Roughly 15–20 focused days** for all five phases. Phases 0 and 1 are the ones that unblock everything; 2–4 can be reordered to suit whatever the next workshop needs.

---

## 11. Two things worth reconsidering

**Compare-strategies view.** Once layers are server-side, showing N participants' action graphs for the same artefact side by side is nearly free — the data is already there, `action-graph.js` already renders a plan, and the "All conditions" toggle is the pattern. Given that your stated goal is to "plan and visualize diverse repair strategies on a shared platform", this may be the single highest-value feature that isn't on your list. It's also the view that makes the platform's output legible in a paper.

**Divergence as a feature, not a bug.** The instinct in §7 is to keep the image consistent with the plan. But a visible, tracked divergence ("this render is 3 edits out of date") is arguably more interesting than an enforced consistency: it makes the gap between *what was intended*, *what was planned*, and *what was imagined* into an observable, timestamped quantity. That gap is the thing your framework is about. Keeping the staleness marker rather than auto-reconciling turns an implementation compromise into an instrument.
