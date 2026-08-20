# Workshop readiness — Monday

Four working days. The build is feature-complete for Monday; what remains is
verification and two pieces of hardening. **No new features from here.**

Everything below Phase 2 in `PLAN.md` — co-evolving intent axes, the engagement
model, the image consistency loop — is deferred until after the workshop. They
are the interesting work, and none of it is worth the risk of shipping
unexercised code into a room with ten people in it.

---

## The honest risk assessment

**Updated 20 Aug, after a session that could reach Gemini.**

What is now verified at runtime, not merely structurally: ingest of a PDF (its
prose, its drawing and its table), ingest of a photograph, ingest of plain
text, embeddings, and semantic retrieval end to end through a running Worker
with real D1 and R2 — including that a problem-vocabulary query reaches a
solution-vocabulary document, that a German query reaches an English one, and
that an unrelated query does *not*. Strategy corpus isolation, project
idempotency, two simultaneous clients, and the spend limits are covered too.
Two harnesses do it, both re-runnable:

```bash
npm run verify:live
```

```bash
npm run verify:worker
```

Running it found two bugs that no unit test would have. Semantic search was
returning arbitrary documents — silently, because the query vector collapsed to
zeros and the ranking sort became a no-op. And a layer conflict could not be
recovered from: the UI said "save again to overwrite" and every save carried the
same stale revision, so a participant with two tabs open would be locked out of
the server for the rest of the session. Both are fixed and both are now pinned
by tests.

What has **still never run**: anything in a browser. The chat loop's own tool
calls (`search_corpus`, `save_to_corpus`, `read_corpus_document` with
`view: true`) have not been driven through a real conversation — the retrieval
beneath them is verified, the model's use of them is not. Nothing has run on a
phone, and nothing has run on the deployed environment, where the prompt files
load from disk at runtime.

That is what the rest of this document is for.

---

## Thursday — verify

Start with the harnesses — they cover the corpus pipeline end to end in about
two minutes and cost a few cents, which is cheaper than finding a format problem
in front of ten people.

```bash
npm run cloudflare:migrate:local
```

```bash
npm run verify:live
```

Then, in a second terminal, the Worker half:

```bash
npx wrangler dev --config cloudflare/wrangler.jsonc --port 8787
```

```bash
npm run verify:worker
```

Both were green on 20 Aug. If either fails, that is the thing to fix before
anything else on this page.

What they do **not** cover is the browser — everything below. Run it:

```bash
npm run dev:all
```

Then, at http://localhost:5173:

- [ ] Load `timber_corner`. Panel shows PROJECT / Working as / My + All conditions.
- [ ] Enter your name. Reload the page. Name and strategies still there.
- [ ] Place a condition on a part. Coordinates show 3 decimals.
- [ ] Drag the intent radar, then Ctrl+Z **once** — the whole drag undoes as one step.
- [ ] **Upload a real PDF** to the project corpus — ideally the joinery
      reference. `verify:live` proves the pipeline works on a document built
      for it; this proves it works on *yours*. Watch the console: it should log
      "Read …" not "could not read it".
- [ ] Open the document row. Does the summary read sensibly, and do the
      `indications` describe the *problem* rather than the technique? A wrong
      summary makes every retrieval built on it wrong.
- [ ] Ask the chat something the PDF answers, phrased in your own words and
      **without naming the technique** — "the sill end is rotten over 400mm, what
      are my options?" Does it cite the document?
- [ ] Ask something that needs the drawings — "what proportions for the scarf?"
      Does it call `read_corpus_document` with `view: true`?
- [ ] Paste a specification into the chat. Does it offer to file it?
- [ ] Ask for a repair plan. Does the action graph fill?
- [ ] Mark a step complete from the step detail modal.
- [ ] Save. You get one ZIP per strategy, meaningfully named.
- [ ] Open the ZIP: `manifest.json`, `workspace.json`, `corpus/index.json`.

**If ingest or search fails, stop and send me the error.** Everything else is
cosmetic by comparison — the corpus is the feature this workshop is testing.

---

## Thursday — the two hardening items

### 1. Rotate the Gemini key — STILL OUTSTANDING

It is in a conversation transcript, and it is the key that ran the verification
above. Regenerate at <https://aistudio.google.com/apikey>, update `.env.local`
**and** the Vercel environment variable.

### 2. Protect the API endpoints — DONE

Every AI endpoint is now wrapped in `withRateLimit` (`api/_shared/rate-limit.js`)
and checks a shared counter in D1 before spending anything. Two buckets per
request: a per-caller limit, and a global ceiling across all callers — the
second is the one that actually bounds the bill, since a leaked URL does not
arrive from one address. Costs are weighted, so an `/api/imagine-result` call
consumes three times what a chat turn does.

It **fails open**. If the Worker is unreachable the request proceeds and the
reason is logged: during a workshop, an outage of the collaboration backend must
not also take out the assistant. A credit balance is worth less than the
session.

Limits sit far above what ten people generate in an afternoon, so the first
thing to trip one should be abuse. If a participant does see "too many
requests", the limits are in `COSTS` at the top of that file and take effect on
the next `vercel --prod`.

This bounds cost. It is not authentication, and there still is none.

**It needs migration 0005 applied remotely** — until then the table is missing,
the limiter fails open, and you are unprotected but working.

---

## Friday — rehearse on production

Local success does not imply deployed success. Different environment, different
failure modes — particularly the prompt files, which are loaded from disk at
runtime and which `npm run verify` now checks are declared for the bundle.

```bash
npm run cloudflare:migrate:remote
```

0003, 0004 and **0005** (the spend-limit table) if not yet applied. Then deploy
both halves — the order does not matter, each tolerates the other being a
version behind:

```bash
npm run cloudflare:deploy
```

```bash
vercel --prod
```

Vercel environment variables — all three:

| Variable | Why |
|---|---|
| `GEMINI_API_KEY` | the new one |
| `VITE_COLLAB_API_URL` | build-time, so the browser can reach the worker |
| `COLLAB_API_URL` | runtime, so `/api/chat` can fetch corpus text |

Then on the deployed URL:

- [ ] Run the live harness against the deployment. This is the fastest way to
      find out whether the prompt files loaded, and it is the difference most
      likely to bite:

      ```bash
      npm run verify:live -- --endpoint https://repair-workspace.vercel.app
      ```

- [ ] And the Worker half, against the deployed Worker:

      ```bash
      npm run verify:worker -- --worker https://repair-workspace-collaboration.familie-rein.workers.dev
      ```

      It leaves one disposable project row behind. If the spend-limit checks
      fail, migration 0005 has not been applied.

- [ ] **In the browser**, the part no harness covers: ask the chat something
      the corpus answers, phrased in your own words and *without naming the
      technique*. Does it cite the document? Then ask something that needs a
      drawing — does it call `read_corpus_document` with `view: true`? Then
      paste a specification into the chat and see whether it offers to file it.
- [ ] **Two browsers at once**, two different names, same project link. Each
      records conditions. Each sees only their own under "My conditions" and
      both under "All conditions".
- [ ] **Same name in two tabs**, deliberately. You should get a conflict, not
      silent data loss — the status line reads "Changed elsewhere — click to
      resolve". Click it: it must offer to overwrite, and cancelling must do
      nothing at all. (Before this week that message said "save again to
      overwrite" and saving again could never work.)
- [ ] One participant on a phone. iOS Safari if any participant will use one.
- [ ] Close a tab mid-edit, reopen. The pending save should have flushed.

---

## Friday — prepare the workshop project

- [ ] Decide the artefact. `timber_corner` unless you have something better.
- [ ] Create the project once, from your machine. Copy the link.
- [ ] **Upload the project corpus before Monday** — the survey, the drawings,
      the brief, the joinery references. This is shared by everyone and it is
      what the whole exercise leans on. Ingest takes ~10 seconds per document;
      doing it live in front of ten people is not the moment to discover a
      format problem.
- [ ] Check each document's summary and `indications` read sensibly. If a
      summary is wrong, the retrieval built on it will be wrong too.
- [ ] Agree distinct names in advance. Two participants typing "Anna" share one
      layer. The roster in the name prompt warns, but only if someone reads it.

---

## Weekend — buffer

Deliberately empty. Whatever the rehearsal turns up goes here.

---

## Monday — running it

**Have a fallback.** If the worker or Gemini fails mid-session, the app keeps
working locally: participants see "offline, kept on this device" and carry on.
Their work is not lost. Collect it as ZIPs at the end — one per strategy, from
the Save button — rather than trying to fix infrastructure in the room.

Tell participants at the start:

- Their name is their identity. Pick a distinct one and reuse it exactly.
- The corpus is shared; the assistant reads it. Ask it things the documents
  cover and expect it to cite them.
- Ctrl+Z undoes anything the AI did, as one step.
- Save before leaving. One ZIP per strategy.

**Collect at the end:** every participant's ZIP, plus your own export of each
layer. The layers are on the server, but a ZIP is proof against every kind of
infrastructure problem — including the ones nobody predicted.

---

## After the workshop

`PLAN.md` phases 3, 4 and 6, informed by what actually happened. The most
valuable thing you can bring back is not a bug list but an answer to: *did
divergence between participants come from their engagement, or from the model?*
That is the question the whole design is arranged around, and Monday is the
first time it can be observed.
