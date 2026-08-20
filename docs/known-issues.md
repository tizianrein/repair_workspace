# Known issues and deferred work

Living list. Add to it freely. Items removed only when shipped or formally cut.

## Fixed in Phase 0 (see PLAN.md)

- ~~Reloading a page with `?project=` replaced the workspace with the project's
  frozen template, destroying every strategy, intent, constraint set and chat
  thread created since the project was started.~~ The stored workspace is now
  authoritative when it belongs to the same project; the template is only
  fetched when this browser has nothing for it.
- ~~The participant name had to be retyped on every reload.~~ Identity is
  remembered per project in localStorage.
- ~~Bumping `SCHEMA_VERSION` silently wiped every participant's stored work,
  because `restore()` discarded a mismatched version instead of migrating.~~
- ~~Condition IDs were `Date.now()` plus a counter starting at zero, with no
  randomness. Two participants creating their first condition in the same
  millisecond produced the same id, and the shared table's upsert reassigned
  ownership — so one person's condition silently became another's.~~ IDs now
  carry 96 bits of CSPRNG entropy, and the upsert no longer reassigns authors.
- ~~Every participant loading the same example overwrote the shared project
  template, because `PUT /projects/:id` was a blind upsert.~~ It is now
  create-if-not-exists; deliberate replacement requires `?replace=true`.
- ~~Four AI endpoints read `intent` and `constraints` off the workspace root,
  which stopped existing in schema 2.1 when they moved onto each plan. All four
  received `undefined`, so the planner ran with its primary directive empty.~~
  Fixed, with a test that fails if any endpoint reads them off the root again.
- ~~Dragging the intent radar fired one `set-intent` command per `pointermove`,
  flooding the undo stack and re-serialising the whole workspace to
  localStorage hundreds of times per gesture.~~ One command per interaction.
- ~~ZIP export dropped every AI-generated image, and a workspace whose only
  images were renderings exported as bare JSON.~~ Export is always a ZIP and
  carries photos and renderings alike, with a round-trip test.
- ~~A full localStorage quota failed silently, leaving the app running against
  a stale stored copy.~~ Failures surface; under pressure, chat transcripts are
  trimmed in storage (never in memory) so strategies survive.
- ~~"+ New condition" armed place mode on a hidden canvas when the 3D tab
  wasn't active, because the tab lookup used the wrong attribute.~~
- ~~The imagine panel leaked an object URL per image on every render, and
  `renderAll` runs on every state change.~~ URLs are revoked between passes.
- ~~Marking a step complete had no reachable entry point at all: its only
  trigger was a quick-action chip whose container was hidden with an inline
  style. The execution-log feature was documented but unusable.~~ The button
  now lives in the step detail modal.
- ~~`verify-setup.mjs` checked two prompt files by hand and missed four others,
  and `vercel.json` never declared the prompt directory for the serverless
  bundle — a tracing miss would have 500'd most endpoints in production.~~

## Open — workshop concurrency (10 participants, one shared artefact)

- **Strategies are still not synced to the server.** They survive reload now,
  but they live only in this browser. A participant switching devices, or
  clearing site data, loses them. Phase 1 moves the whole participant layer
  server-side.
- **Names are unauthenticated.** Two participants who type the same name share
  one layer and snapshot-replace each other. Mitigation for now: agree on
  distinct names, and show the existing roster before someone picks.
- **The artefact is frozen at project creation.** Edits to parts made after the
  project started are not shared with anyone.
- **No rate limiting on the AI endpoints.** With a paid Gemini tier the quota
  is workable, but ten participants generating images at once is both slow and
  expensive, and nothing throttles it.
- **Photo uploads are still not retried** on flaky networks.

## v1.0 — Workshop release

### Won't fix before workshop
- **Redo across ID-regenerating commands.** Undo always works. Redo works for single commands but breaks if you undo `add-condition` (which generated id `hyp_X`) and then redo: the redo creates a new condition with id `hyp_Y`, but any subsequent commands in the history that referenced `hyp_X` still point to the deleted one. *Workaround:* tell participants undo is reliable, redo is best-effort. **To fix later:** commands should preserve generated IDs from their first application, replaying them on redo instead of regenerating.
- **Concurrent edits across browser tabs.** localStorage isn't synchronized across tabs. If a participant opens two tabs on the same machine, they fight. *Workaround:* one tab per workspace. Phase 1 adds a revision check so the loser fails loudly instead of silently clobbering.
- **Photo uploads on flaky networks.** Uploads aren't retried. *Workaround:* take photos before generating plans when bandwidth is best.

### Deferred to v1.1
- Template / instance split (currently every workspace has one ad-hoc instance; no shared typologies yet)
- Approvals workflow on plans (status enum exists, no UI yet)
- Time tracking: actual vs estimated, critical path computation
- Tags on steps
- Structured measurements on evidence

### Deferred to v2
- Repair-pattern library + RAG grounding
- Collaboration: presence, locking, conflict resolution
- AR overlay
- Offline mode + service worker

## Performance notes
- Cytoscape with >100 nodes gets sluggish on mobile. Plans rarely exceed 15 steps, so fine for now.
- Three.js viewer on iOS Safari occasionally drops frames during explode animation. Cosmetic only.
- Gemini calls take 10–30s. We show a progress indicator, but participants should be warned.
- Textured mesh overlays (`/examples/<slug>/mesh.glb`) add 5–50 MB to the example asset load and meaningful triangle counts to the viewer. Mobile performance with the mesh visible may be marginal; the user can hide it via the HUD toggle.

## Textured mesh overlay
- Optional per example. Drop `mesh.glb` (glTF binary, embedded textures) into the example folder; it is auto-loaded on example load.
- **Must be pre-aligned** to the workspace's coordinate system. There is no in-app alignment editor — that's the example author's job in Blender / MeshLab / etc.
- Slug is remembered in localStorage so the mesh re-loads after a page reload. Sharing a workspace JSON does NOT transfer the mesh — recipients see only the box model unless they load the same example themselves.
- Condition placement with the mesh visible uses a **nearest-part heuristic**: the click hits the mesh surface, then we assign the click to whichever part's bounding box is closest. Misalignment between mesh and box model → wrong part assignment. Author the example carefully.

## Testing gaps
- No automated end-to-end test. Manual smoke tests in `docs/smoke-test.md`.
- Schema validation runs at migration time, not on every state mutation. Adding it to `apply()` is one line.
