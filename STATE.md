# Repair Workspace — current state

Written 20 Aug 2026, at the end of the session that did Phases 0–2.
Read this first; it is the handoff.

**Workshop: Monday 24 Aug.** Ten participants, one shared artefact.

---

## What this is

A platform where practitioners survey a damaged structure, record conditions on
it, and develop *divergent* repair strategies with AI assistance — the research
question being whether that divergence comes from the participants' engagement
or merely from the model's variance.

Vanilla ES modules + Vite. Two backends: Vercel serverless functions for Gemini,
a Cloudflare Worker (D1 + R2) for collaboration. No framework.

---

## Locked decisions

These were argued out and settled. Do not silently revisit them.

1. **No blanket review gate.** Users should not approve every AI action.
   Approval-after-the-fact is a gate, not a dialogue, and it trains
   click-through. Interaction belongs *before* generation.
2. **Diversity must be earned through engagement.** A "generate N contrasting
   strategies" button was explicitly rejected: model-generated variance measures
   sampling temperature, not human reasoning, and is worthless as research data.
3. **Project corpus is user-independent.** Everyone reads the same base
   material, so divergence comes from what people do with it.
4. **Strategy corpus is isolated per plan.** Enforced in SQL, not by convention.
   This is the mechanism that makes strategies reason from different evidence.
5. **Intent co-evolves with the corpus** — the AI proposes axes, the human
   decides. Values never move without human acceptance. (Phase 3, not built.)
6. **The radar is the authoring surface** for axes.
7. **Name-only login.** No PIN, no accounts.
8. **Export is per-strategy**, with meaningful auto-generated filenames.

Also settled: the AI may propose axes that *contradict* existing ones; AI-authored
axes are **not** visually flagged (provenance stays in the data); the six seed
axes are examples, not protected; strategies are **private while working,
comparable after**; participants may edit the parts model but only **their own
copy** (which is why the parts model lives in the layer, not the project).

---

## Built and deployed

**Phase 0 — correctness.** Reload no longer destroys strategies; identity
persists; schema bumps migrate instead of wiping; `crypto.randomUUID()` ids
(two participants could previously collide and one could take over the other's
condition); `PUT /projects/:id` is create-if-not-exists; radar commits one
command per gesture instead of hundreds; ZIP carries renderings; ~1,300 lines of
dead propose-stack deleted. Four AI endpoints were reading `ws.intent`, which
stopped existing in schema 2.1 — **every plan the platform generated before this
was produced blind to intent.**

**Phase 1 — participant layers.** `rw_layers` (metadata in D1, body in R2). A
layer is one participant's whole workspace: parts, conditions, strategies,
evidence, conversations, execution log. `rev`-based concurrency, 409 on stale
writes, retry with backoff, flush on `visibilitychange`. `rw_conditions` is not
dropped — participants with only old-schema data migrate themselves on first
save.

**Phase 2 — two-tier corpus with semantic retrieval.** Upload → Gemini reads it
natively (PDFs, images, scans; no extraction pipeline) → summary, key facts,
figure descriptions, and **indications** (what problems it solves, in the
problem's vocabulary). Chunked and embedded with `gemini-embedding-001`, int8
quantised in D1, brute-force cosine in the Worker. Retrieval is **hybrid**
(semantic + lexical, fused with RRF). `read_corpus_document({view: true})`
returns the original pages so the model can look at drawings. `save_to_corpus`
files what a user pastes into chat.

**Export (was Phase 5, done early).** Strategy picker, per-strategy ZIP,
`artefact__author__strategy__date.zip` with German transliteration, corpus
included.

**Live:** migrations 0001–0004 applied remotely, Worker deployed.

---

## Verified at runtime — 20 Aug, second session

The Gemini surface has now executed. It had never run: the sandbox that wrote
Phases 0–2 could not reach `generativelanguage.googleapis.com`, and this one
can. Two harnesses were added, both re-runnable, both making real API calls:

- `npm run verify:live` — models, ingest, embeddings, retrieval, in-process or
  against a deployment with `--endpoint`.
- `npm run verify:worker` — the same corpus round trip through a running
  Worker with real D1 and R2, plus scope isolation, concurrency and spend
  limits. Needs `wrangler dev` (or `--worker <url>` for the deployed one).

What they establish. Ingest reads a PDF's prose, its drawing and its table,
transcribes dimensions verbatim, and returns figures and problem-vocabulary
indications. A photograph ingests too. Retrieval bridges vocabulary: *"the sill
end is rotten over 400mm"* reaches a text on stop-splayed scarf joints sharing
none of its words, the same question in German reaches the English document,
*"how long should the joint be for a 160mm timber"* lands on the table, and a
mortar question does **not** return the joinery text. Strategy corpus isolation
holds against a sibling strategy, another participant, and an unscoped search.
Two clients writing at once produce one winner and one 409.

**Two bugs were found by running it, both silent.**

1. *Semantic search returned arbitrary documents.* `embedQuery` returns floats;
   the Worker read the query with `Int8Array.from()`, which truncates every
   component of a unit-length vector to zero. Every chunk scored exactly 0, the
   sort did nothing, and search returned whatever order D1 supplied. Nothing
   threw. Because retrieval is hybrid, lexical hits still arrived, so the
   feature looked alive while the half this project is *about* — reaching a
   document phrased in a vocabulary the query does not share — was noise. Fixed
   on both sides: the API quantises before posting, and the Worker normalises a
   float vector if it receives one, so a version skew between the two
   deployments cannot resurrect it. `npm run test:vector-search` pins the
   arithmetic offline against known answers.

2. *A layer conflict could not be recovered from.* The status bar said "save
   again to overwrite", but every ordinary save carries the same stale
   `baseRev`, so it conflicted again — permanently. A participant who opened a
   second tab would spend the rest of the session unable to reach the server,
   while being told the fix was something that did not work. Overwriting is now
   a real, deliberate action: the status pill becomes clickable and asks. It is
   never automatic, per the rule that picking a winner silently is how the old
   sync destroyed work.

Still unexercised: the chat loop's own tool calls (`search_corpus`,
`save_to_corpus`, `read_corpus_document` with `view: true`) have not been
driven through a real conversation — the retrieval *beneath* them is verified,
the model's use of them is not. Nothing has run in a browser, on a phone, or on
the deployed environment. `WORKSHOP-CHECKLIST.md` remains the plan for those.

---

## Outstanding before Monday

Only you can do these — they need credentials, a browser, or a decision.

- [ ] **Rotate `GEMINI_API_KEY`** — it was exposed in a conversation transcript.
      Regenerate at <https://aistudio.google.com/apikey>, update `.env.local`
      **and** the Vercel variable. Still outstanding; the key in `.env.local`
      is the exposed one and was used for the verification runs above.
- [ ] **Vercel env:** `GEMINI_API_KEY`, `VITE_COLLAB_API_URL` (build-time — set
      it before the build). `COLLAB_API_URL` is optional; functions can read
      the `VITE_`-prefixed one at runtime.
- [ ] **Apply migration 0005 remotely** — `npm run cloudflare:migrate:remote`.
      New: the spend-limit table. Until it is applied the limiter fails open,
      which is safe but unprotected.
- [ ] **Deploy both halves** — `npm run cloudflare:deploy` and `vercel --prod`.
      Order does not matter: each half tolerates the other being a version
      behind.
- [ ] Run `npm run verify:live -- --endpoint https://<prod>` against the
      deployment. Prompt files load from disk at runtime and are the thing most
      likely to differ from local.
- [ ] Upload the project corpus and check each summary and `indications` read
      sensibly. Retrieval built on a wrong summary is wrong retrieval.
- [ ] Two browsers, two names, one project link. Then the same name in two tabs
      deliberately — you should get the conflict pill, and clicking it should
      offer to overwrite.
- [ ] Agree distinct participant names in advance.

### Done this session

- `phase0` → `main`: already merged. `main` also carries a later commit that
  makes corpus indexing and search degrade gracefully when the chunk table is
  missing. Nothing to merge; production is not stale.
- `ALLOWED_ORIGINS` now accepts a single-label wildcard, and
  `https://repair-workspace-*-tizian-reins-projects.vercel.app` is listed — so
  preview deployments no longer fail CORS silently. The wildcard cannot cross a
  dot; `isOriginAllowed` is tested.
- The 62 MB of `*.glbbak` are gone from the tree and from `dist`, and
  `.gitignore` keeps them out. They remain in git history if you want one back:
  `git checkout 7799321 -- src/public/examples/timber_corner/mesh.glbbak`.
- **Spend limits on `/api/*`** — the second hardening item. Every AI endpoint
  is wrapped in `withRateLimit`, which checks a shared counter in D1 before
  spending anything: a per-caller limit and a global ceiling, weighted by cost
  so an image generation counts for more than a chat turn. It **fails open** —
  an unreachable Worker must not take the assistant down mid-workshop — and the
  limits sit far above what ten people generate, so the first thing to trip one
  is abuse. This bounds cost; it is not authentication, and there still is none.

---


## Next phases

**Freeze the workshop build.** Merge `phase0` → `main`, then branch from there.
Nothing below should reach the Monday deploy.

**Phase 3 — co-evolving intent axes** (3–4 days). Now unblocked: it needed the
corpus. Axis schema gains `id, label, description, value, origin, sourceRefs,
addedAt, deprecated`; axis-level commands replace whole-object `set-intent`; the
`set_intent` tool schema currently accepts `{id, value}` with both required and
**no label field**, so the model can re-weight and nothing else — widening that
is the change that unlocks the feature. Never hard-delete an axis a step's
`justification.drivingIntentAxes` references; deprecate it.

**Phase 4 — the engagement model** (4–5 days). Where decisions 1 and 2 become
real. `computeGaps` (`chat-engine.js`) becomes a hard precondition on planning
rather than passive context. Forced trade-off allocation instead of free 0.5
sliders. Mutex branches emitted by default — `mutexGroups` is in the schema and
essentially never used. Forking a strategy requires stating what it diverges on.

**Phase 6 — image consistency loop.** Today the Soll is a *sibling* of the plan,
so refining an image mutates only the Soll and the plan silently diverges. Make
it a *function* of the plan: a refine instruction translates into plan commands
first, then the Soll recomputes, then the image regenerates. Stamp renderings
with a `planRev` hash and mark them **stale** rather than auto-regenerating.

**Also outstanding:** merge-on-import (approved, never built — importing a
strategy ZIP still replaces the workspace instead of adding the strategy
alongside, which defeats the point of per-strategy export).

**Phase 7 — cleanup.** `escapeHtml` defined 7 times; `main.js` is ~2,400 lines
doing six jobs; nine direct `state.workspace =` mutations bypass the command
pipeline and are un-undoable.

---

## Working notes for whoever picks this up

- `npm test` — 11 suites, all offline. `npm run verify` checks layout, that
  every prompt an endpoint loads exists, and that Vercel bundles them.
- The two live harnesses cost a few cents each and are the only things that
  touch Gemini: `npm run verify:live` (add `-- --endpoint <url>` for a
  deployment) and `npm run verify:worker` (needs `wrangler dev`, or
  `-- --worker <url>`). Run both after any change to embeddings, ingest or
  the search route.
- Similarity code needs known answers, not smoke tests. Both silent bugs this
  session were found by asking "is the top hit the *right* document", never by
  asking "did it return results" — which it always did.
- `npm run dev:all` runs all three processes. Leave `VITE_COLLAB_API_URL` unset
  locally or you point development at production data.
- The command pattern in `core/commands.js` is the good part of this codebase.
  Every mutation returns `{workspace, inverse}`. Build on it; don't work around it.
- Real integration tests beat mocks here. The layer and corpus work was verified
  against actual `wrangler dev` with local D1 and R2, which caught things unit
  tests would not have.
- The user is a domain expert and pushes back well. When he says a design is
  wrong, it usually is — the "diversity button" and the missing corpus index in
  the snapshot were both his catches.
