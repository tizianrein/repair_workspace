# Known issues and deferred work

Living list. Add to it freely. Items removed only when shipped or formally cut.

## v1.0 — Workshop release

### Won't fix before workshop
- **Redo across ID-regenerating commands.** Undo always works. Redo works for single commands but breaks if you undo `add-condition` (which generated id `hyp_X`) and then redo: the redo creates a new condition with id `hyp_Y`, but any subsequent commands in the history that referenced `hyp_X` still point to the deleted one. *Workaround:* tell participants undo is reliable, redo is best-effort. **To fix later:** commands should preserve generated IDs from their first application, replaying them on redo instead of regenerating.
- **Concurrent edits across browser tabs.** localStorage isn't synchronized across tabs. If a participant opens two tabs on the same machine, they fight. *Workaround:* one tab per workspace. Detect and warn via `storage` event.
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
