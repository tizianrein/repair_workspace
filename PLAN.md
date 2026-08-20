# Repair Workspace — Decisions & Plan

Compiled from the design discussion, 19 Aug 2026. Supersedes the roadmap section of `ANALYSIS.md`; the findings in that document still stand.

---

## Part 1 — What you decided

### D1. No blanket review gate. Interaction moves upstream.

The user should **not** review everything the AI proposes. Approval-after-the-fact is a gate, not a dialogue, and it produces the click-through behaviour we're trying to avoid.

But there must be substantive interaction — not clicking until a strategy appears. So engagement happens **before** generation (elicitation, choice, commitment), not after it (approval).

*Consequence:* the orphaned propose/review stack is confirmed dead, not to be revived. See W0.11.

### D2. Diversity must be earned through engagement.

Explicitly rejected: a "generate N contrasting strategies" button. Model-generated variance measures sampling temperature, not human reasoning, and is worthless as research data.

A strategy may only be as divergent as the commitments it was derived from. The work is making those commitments expensive to skip and specific enough to differ.

### D3. Corpus is user-independent at project level.

One shared base corpus per project. Every participant reads the same material. Divergence must come from what people *do* with the material, not from having different material.

### D4. Corpus is **also** strategy-specific.

A second tier attached to each plan, scoped exactly as `intent` and `constraints` already are in v2.1.

Strategy corpora are **isolated from each other** — strategy A cannot see strategy B's documents. This isolation is the mechanism that produces genuinely different repairs. `search_corpus` resolves against project corpus + the current strategy's corpus, never across strategies.

### D5. Intent co-evolves with the corpus.

As a strategy's corpus grows, the AI should propose changes to the intent: re-weight existing axes, rename them, and **add new axes**. The evaluation framework emerges from engagement with the material instead of being fixed a priori.

Two strategies can end up with different axes — not two points in one space, but two different spaces.

*Guard:* the AI **proposes**; the human decides. Values and axes move only by human hand or explicit acceptance. Silent AI rewriting of intent would destroy the earned divergence in D2. This is the one place a proposal gate belongs — and engaging with a proposed axis *is* the interaction D1 asks for.

### D6. The radar is the authoring surface for axes.

Add, rename, re-weight and remove axes directly on the radar. (Already implemented — see W3 for the six gaps.)

### D7. Name-only login.

A typed name identifies a participant within a project. No PIN, no password, no session token, no accounts. The name must persist across reloads.

### D8. Export is per-strategy.

Downloading opens a **strategy picker** first. One ZIP per strategy — no whole-workspace bundles. Filenames are generated automatically and are individually meaningful.

---

## Part 2 — Design consequences

### The scoping model

| Scope | Contents | Shared? |
|---|---|---|
| **Project** | artefact (instance + parts), cover, mesh, **project corpus**, title | shared, user-independent |
| **Participant layer** | conditions, evidence, execution log | one participant |
| **Strategy (plan)** | intent + axes, constraints, steps, edges, mutexGroups, **strategy corpus**, conversations, renderings | one strategy, isolated from other strategies |

v2.1 already put intent and constraints on the plan. D4 adds the corpus to that same scope. The pattern is consistent: *anything that should differ between strategies lives on the plan.*

### Axis schema

```js
axis = {
  id,                       // crypto.randomUUID(), not Date.now()
  label,
  description,
  value,                    // 0..1
  origin: 'base' | 'derived',
  sourceRefs: [docId],      // corpus documents that motivated it
  addedAt,
  deprecated: false
}
```

The original six stay as a persistent **base set** so cross-strategy comparison remains possible; derived axes sit on top and are flagged. An axis referenced by any step's `justification.drivingIntentAxes` is **deprecated, never deleted**.

### The traceable chain

```
corpus document → axis proposed → human accepts / re-weights
                → intent → step justification → step → rendering
```

Every link is recorded. This is what lets you show that two participants diverged *because* they read different material and drew different criteria from it — rather than because the model sampled differently.

---

## Part 3 — Open questions

Not blocking Phase 0 or 1. Needed before Phase 3 and Phase 5.

1. **Contradictory axes.** May the AI propose an axis that *conflicts* with an existing one, forcing the human to resolve the tension — or only additive suggestions? Contradiction is better research and worse UX.
2. **Corpus in the ZIP.** Does the strategy corpus travel inside a single-strategy bundle? (Recommend yes — without it the derived axes have no provenance and the bundle isn't self-explaining.)
3. **Merge on import.** Should importing a single-strategy ZIP into a workspace with a matching `artefactId` *add* the strategy alongside existing ones rather than replacing the workspace? (Recommend yes — it makes the ZIP the interchange unit between participants and enables comparison without a server round-trip.)
4. **AI-authored axes visually marked** on the radar — dashed spoke, different label colour — so participants can see which criteria they authored and which came from the material?
5. **Base-set protection.** May a participant delete one of the six base axes, or only deprecate it?

---

## Part 4 — The plan

### Phase 0 — Correctness (2–3 days) · blocks everything

| # | Item | Where |
|---|---|---|
| W0.1 | Reload from `?project=` no longer replaces the workspace — restore local first, fetch template only when there is no matching local `collaboration.projectId` | `main.js:2246-2265`, `2095-2120` |
| W0.2 | Persist `{projectId, authorName, authorKey}` across reloads | `state.js:21-29` |
| W0.3 | `restore()` routes through `migrateV1ToV2` instead of discarding on version mismatch | `state.js:63-79` |
| W0.4 | `uid()` → `crypto.randomUUID()`; add `author_key` to the conditions primary key | `schema.js:315`, `0001_collaboration.sql:24` |
| W0.5 | **Four endpoints read `ws.intent` / `ws.constraints`, which don't exist in v2.1** — fix to read from the current plan | `generate-plan.js:188`, `enrich-plan.js:117`, `synthesize-target-json.js:128`, `modify-target-json.js:48` |
| W0.6 | Radar drag commits **one** command on `pointerup`, not one per `pointermove` | `main.js:121`, `radar.js:201-209`, `:127` |
| W0.7 | ZIP export includes renderings; always ZIP, never bare JSON | `workspace-bundle.js:33`, `main.js:695` |
| W0.8 | `+ New condition` tab switch — selector is `data-tab`, markup uses `data-pane` | `main.js:292` |
| W0.9 | Revoke object URLs; stop leaking one per rendering per render | `main.js:1370, 1444, 1473, 1838` |
| W0.10 | Renderings sort by `createdAt` but `newEvidence` writes `capturedAt` — oldest shows as active | `schema.js:144`, `main.js:1412` |
| W0.11 | Delete the dead propose stack: `propose-review.js`, `quick-actions.js`, `justification-panel.js`, `runPropose`, `isPlanGenerationIntent`, `/api/propose`. **Keep `/api/enrich-plan`** and rewire it to run after a chat-created plan — the enrichment (tools, materials, minutes, safety) is real functionality the chat path doesn't do. `/api/generate-plan` is redundant with the chat tools | ~1,300 lines |

W0.5 matters more than its size suggests: intent is now the central mechanism of the whole design, and the planner has never actually seen it.

### Phase 1 — Persistence with name-only identity (3–4 days)

- `rw_layers` table replacing `rw_conditions`: `(project_id, author_key)` PK, `author_name`, `layer_r2_key`, `rev`, counts, `updated_at`.
- **Layer body in R2**, metadata in D1. Removes the 1.8 MB D1 cap that conversations will otherwise blow through immediately.
- Widen sync from conditions-only to the full layer: conditions + **plans** + evidence + conversations + execution log.
- `rev`-based optimistic concurrency; 409 on mismatch, so two tabs fail loudly instead of silently clobbering.
- Save on `visibilitychange` and `beforeunload`; retry with backoff; visible "unsaved changes" indicator. A failed save is currently one status line and then silence.
- Artefact becomes an explicit project-level record with its own route, instead of a snapshot frozen at project creation.

This is the phase that actually fixes *"if the site is reloaded their repair strategies are gone."*

### Phase 2 — Two-tier corpus (3–4 days) · can run parallel to Phase 1

- `rw_corpus_docs` with a `scope` column: `'project'` or a `plan_id`. Blobs in R2.
- Worker routes: list / PUT / GET / DELETE corpus documents.
- `POST /api/ingest-document` — send the document to Gemini directly (it reads PDFs natively, OCR included) and store `{summary, plainText, extractedFacts}`. One call replaces an entire extraction pipeline.
- `doc_kind` on upload: `structure` | `goal` | `technique` | `reference`. One dropdown that removes a lot of prompt ambiguity later.
- Tools `search_corpus` and `read_corpus_document`, scoped to project + current strategy. Default context carries only the **index** (filename + kind + one-line summary, ~40 tokens/doc); full documents load on demand. A 50-document corpus costs ~2k tokens instead of ~500k.
- Upload UI: project corpus in the left drawer, strategy corpus in the strategy panel.
- **Add a data-vs-instructions guard to `chat.md`.** User-uploaded PDFs are about to enter the same context as 14 workspace-mutating tools. `design-joinery.md:23` is currently the only prompt with such a guard.

### Phase 3 — Co-evolving intent (3–4 days) · needs Phase 2

- Axis schema per Part 2. Migration fills `origin: 'base'` for the existing six.
- Axis-level commands — `add-intent-axis`, `update-intent-axis`, `deprecate-intent-axis` — replacing whole-object `set-intent` merges, so the audit trail can name the document that caused an axis.
- Widen the `set_intent` tool schema: it currently accepts axis items of `{id, value}` with both required and **no `label` field**, so the model can re-weight and nothing else (`chat-tools.js:76-87`).
- New tool `propose_intent_axis({label, description, rationale, sourceRefs})` — proposes, does not apply.
- Radar: provenance badges, deprecate-not-delete when a step references an axis, `crypto.randomUUID()` ids, and a `↺ reset` that warns before discarding derived axes (`main.js:613` currently applies the hardcoded six).

### Phase 4 — The engagement model (4–5 days) · needs Phases 2 and 3

This is where D1 and D2 become real. It's design work as much as implementation.

- `computeGaps` (`chat-engine.js:385`) becomes a **hard precondition** on plan generation rather than passive context. No plan while intent is at defaults and conditions are thin.
- Replace free 0.5 sliders with a **forced allocation** — a fixed point budget, or pairwise "which of these loses here" — so a participant cannot claim everything matters. Divergence comes from what they gave up.
- The AI emits **mutex branches by default** at decision points, with the consequence of each expressed on the axes the participant said they cared about. `mutexGroups` is already in the schema and is essentially never used.
- Corpus-grounded elicitation. Generic questions produce noise; *"the survey documents a 1987 sill replacement — does that change how you weigh original fabric?"* produces divergence.
- Forking a strategy requires stating what it diverges on and why. That record is the research data.
- Rewrite `chat.md` around interviewing rather than answering.

*Watch:* friction that produces articulation is good; friction that produces abandonment is not. Front-load it once per artefact, not once per strategy.

### Phase 5 — Single-strategy export / import (2 days)

- Strategy picker modal: colour chip, label, step / condition / rendering counts, last updated; current pre-selected.
- Bundle contents — the plan alone is meaningless, so: `manifest.json` (bundleVersion, schemaVersion, artefactId, planId, authorName, exportedAt) + artefact & parts + the one plan + the conditions it addresses + its chat thread + its execution entries + project & strategy corpus + referenced photos + its renderings + mesh & cover.
- Auto-naming, sorted artefact → author → strategy:
  `nordportal__anna-mueller__splice-and-consolidate__2026-08-19.zip`
  German transliteration (ö→oe, ü→ue, ä→ae, ß→ss — the ß fold already exists at `chat-engine.js:50`), lowercase, capped segments, `untitled-strategy` fallback, 4-char plan-id suffix on collision.
- Merge-on-import when `artefactId` matches (pending Q3); refuse and offer a separate workspace when it doesn't.

Builds on `exportStrategy` (`main.js:488`), which already scopes to one plan — it just needs blobs, condition filtering and naming.

### Phase 6 — Image consistency loop (3–4 days)

- Tools `render_target_state` and `revise_rendering`. The latter does **not** call the image model first: it translates the instruction into plan commands, recomputes the Soll from the updated plan, and only then renders. Edits enter at the plan level; the Soll and image are downstream projections.
- `basedOn: {planId, planRev, sollHash, sourceEvidenceId}` on every rendering. `planRev` is a hash of steps + edges + mutexGroups. Mismatch → **stale badge, never auto-regeneration**. Tracked divergence is cheaper than enforced consistency, and more interesting.
- Accept / reject / revise card with `review.status`, `review.by`, `review.note`.
- Automatic verification: run the generated image back through `describe-photo` and diff the result against the Soll. One flash call, ~2k tokens, cheap enough for every render.
- Fix: the source photo is discarded on refinement (`imagine-result.js:56-58`) despite comments claiming both references are passed, so refined images drift from the artefact — and the client uploads it anyway, wasting ~400 KB per call.

### Phase 7 — Cleanup (2–3 days) · parallel, anytime

- ~1,700 lines of dead code: `chat.js.bak`, `chat.md.bak`, `streamGeminiWithTools`, the unreachable viewer-3D re-init branch (`main.js:522-542`), unused `state.js` exports.
- `escapeHtml` is defined **7 times**; the AI payload slimmer exists **5 times** with five different field sets that disagree about where `intent` lives — which is the direct cause of W0.5. One `dom-utils.js` and one `buildAiPayload()` remove both bug classes permanently.
- Split `main.js` (2267 lines, 136 `$()` calls against ~95 DOM ids) into `boot / workspace-io / ai-client / imagine / collaboration / render`.
- Convert the 9 direct `state.workspace = …` mutations (`main.js:685, 774, 1208, 1281, 1720, 1793, 1850, 2039, 2078`) into commands. They're currently un-undoable and bypass validation.

---

## Part 5 — Sequence

```
Phase 0  Correctness            2–3 d   ████
Phase 1  Layers + name login    3–4 d       ██████
Phase 2  Two-tier corpus        3–4 d       ██████        (parallel to 1)
Phase 3  Co-evolving intent     3–4 d             ██████
Phase 4  Engagement model       4–5 d                   ████████
Phase 5  Single-strategy ZIP    2 d                             ███
Phase 6  Image loop             3–4 d                              ██████
Phase 7  Cleanup                2–3 d   ─── parallel, anytime ───
```

Roughly **20–26 focused days**. Phases 0 and 1 unblock everything else; 2 shares almost no code with 1 and can run alongside it.

## Start here

The first four items of Phase 0 are about a day's work and remove the two things actively destroying data today:

1. **W0.1** — reload no longer wipes strategies
2. **W0.2** — name survives a reload
3. **W0.4** — `crypto.randomUUID()` ids, so one participant's conditions can't overwrite another's
4. **W0.5** — the planner finally sees the intent

W0.5 is worth doing before anything else that touches AI behaviour: every plan the platform has generated so far was produced with an empty intent, so any judgement about how well the planning works is currently based on a broken baseline.
