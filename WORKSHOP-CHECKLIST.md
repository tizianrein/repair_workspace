# Workshop readiness — Monday

Four working days. The build is feature-complete for Monday; what remains is
verification and two pieces of hardening. **No new features from here.**

Everything below Phase 2 in `PLAN.md` — co-evolving intent axes, the engagement
model, the image consistency loop — is deferred until after the workshop. They
are the interesting work, and none of it is worth the risk of shipping
unexercised code into a room with ten people in it.

---

## The honest risk assessment

What has been verified: schema, persistence, layer sync against real D1 and R2,
corpus scoping and isolation, bundle round-trips, conflict handling, the local
build. Every automated test passes.

What has **never executed**: anything that calls Gemini. My sandbox blocks that
host, so `/api/ingest-document`, the embeddings, `search_corpus`'s semantic
path, `save_to_corpus`, and the chat loop with the three new tools have been
verified structurally and not once at runtime. That is the single largest
unknown, and it is entirely testable in about thirty minutes.

Second largest: nothing has been exercised by two clients at the same time.
The 409 conflict path is unit-tested but has never seen two real browsers.

---

## Thursday — verify

Run everything locally and confirm it actually works.

```bash
npm run cloudflare:migrate:local
npm run dev:all
```

Then, at http://localhost:5173:

- [ ] Load `timber_corner`. Panel shows PROJECT / Working as / My + All conditions.
- [ ] Enter your name. Reload the page. Name and strategies still there.
- [ ] Place a condition on a part. Coordinates show 3 decimals.
- [ ] Drag the intent radar, then Ctrl+Z **once** — the whole drag undoes as one step.
- [ ] **Upload a real PDF** to the project corpus — ideally the joinery reference.
      Watch the console: it should log "Read …" not "could not read it".
- [ ] Open the document row. Does it show a sensible summary?
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

### 1. Rotate the Gemini key

It is in a conversation transcript. Regenerate at
<https://aistudio.google.com/apikey>, update `.env.local` **and** the Vercel
environment variable.

### 2. Protect the API endpoints

`/api/*` has no auth and no rate limiting, on a pay-as-you-go key. Ten
participants are not the risk; a leaked URL is. One `/api/chat` request can
drive a dozen model calls, and `/api/imagine-result` bills image generation per
call.

---

## Friday — rehearse on production

Local success does not imply deployed success. Different environment, different
failure modes — particularly the prompt files, which are loaded from disk at
runtime and which `npm run verify` now checks are declared for the bundle.

```bash
npm run cloudflare:migrate:remote     # 0003 and 0004 if not yet applied
npm run cloudflare:deploy
vercel --prod
```

Vercel environment variables — all three:

| Variable | Why |
|---|---|
| `GEMINI_API_KEY` | the new one |
| `VITE_COLLAB_API_URL` | build-time, so the browser can reach the worker |
| `COLLAB_API_URL` | runtime, so `/api/chat` can fetch corpus text |

Then on the deployed URL:

- [ ] Repeat the corpus test above. Prompt loading is the thing most likely to
      differ between local and deployed.
- [ ] **Two browsers at once**, two different names, same project link. Each
      records conditions. Each sees only their own under "My conditions" and
      both under "All conditions".
- [ ] **Same name in two tabs**, deliberately. You should get a conflict, not
      silent data loss.
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
