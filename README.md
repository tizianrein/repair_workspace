# Repair Workspace v2

A representation-based workflow for repair design. Coupling spatial models, condition cataloguing, and procedural action graphs with multimodal AI assistance — without giving up human authorship.

Built for a workshop deploy on Vercel. Each participant works on a different object on their own laptop or phone. All workspace data lives in browser `localStorage`; AI calls go through Vercel serverless functions to Google Gemini.

## What works now (pass 2b complete)

- **Shell**: three-tab viewer (Action / Spatial / 3D), FAB-driven layout that collapses to drawers on mobile, workshop typography (Inter Tight / Fraunces / JetBrains Mono).
- **Data model**: parts, conditions with suspected/confirmed/refuted lifecycle, plans with steps + prerequisites + mutex groups for alternatives, execution log, conversation threads.
- **Command pattern**: every mutation is reversible, full undo via Ctrl+Z.
- **AI loop**: one conversational endpoint with tool calling. The model calls workspace tools; the resulting commands are applied as a single undoable batch, and each assistant message carries an audit card listing exactly what was changed.
- **Step enrichment**: after the AI creates a plan, a background pass fills in tools, materials, time estimates, expected outcomes, safety notes and per-step rationale.
- **Execution log**: marking a step complete opens a form for actual time, deviation, and rationale.
- **Photo attachments**: snap or upload, attached as multimodal input to chat or propose.
- **Migration**: v1 workspace JSON loads and converts automatically.

## What didn't make pass 2b (deferred to v1.1 post-workshop)

- Drag-to-connect in the action graph (currently you edit via detail modal)
- Execution log *viewer* (entries are recorded from the step detail modal; a chronological view is missing)
- Cleanup and deletion controls for shared photos stored in Cloudflare R2
- Approval workflow on plans
- Template / instance split
- The repair-pattern library (RAG)

See `docs/known-issues.md` for the full list.

## Setup

```bash
npm install
npm run verify       # checks layout + that every prompt an endpoint loads exists
npm test             # full suite
```

### Running it locally

The app is three processes. `vite.config.js` proxies `/api/collaboration` to the
worker and everything else under `/api` to the Vercel functions, so the browser
only ever talks to :5173.

```bash
npm run cloudflare:migrate:local   # once: create the local D1 tables
npm run dev:all                    # starts all three, prefixed output
```

Or in three terminals, if you prefer to see them separately:

| Terminal | Command | Port | Owns |
|---|---|---|---|
| 1 | `npm run dev` | 5173 | frontend — **open this one** |
| 2 | `npm run cloudflare:dev` | 8787 | projects, layers, corpus (local D1 + R2) |
| 3 | `vercel dev --listen 3000` | 3000 | Gemini endpoints (chat, ingest, imagine) |

Each degrades rather than breaks. Without the worker you work locally with no
sync and a visible "offline" status; without `vercel dev` the AI features fail
but everything else works.

**Leave `VITE_COLLAB_API_URL` unset in `.env.local`.** Unset means the browser
calls `/api/collaboration`, which the Vite proxy sends to your *local* worker —
which is what you want for testing. Setting it points local development at
production data. It belongs in the Vercel environment, not in `.env.local`.

`.env.local` needs only:

```
GEMINI_API_KEY=your-key
```

For AI endpoints during local dev:

```bash
npm install -g vercel
echo "GEMINI_API_KEY=your-key-here" > .env.local
vercel dev           # serves /api on :3000, vite proxies
```

Get a Gemini API key from [Google AI Studio](https://aistudio.google.com/apikey) — free tier is enough for a workshop with a dozen participants.

AI text, multimodal analysis, planning, and tool-calling routes use the stable
`gemini-3.7-flash` model with task-specific thinking levels. Image generation
uses the stable `gemini-3.1-flash-image` model (Nano Banana 2).

## Deploy to Vercel

```bash
vercel               # first time: link the project
vercel --prod        # deploy to production URL
```

## Shared condition layers with Cloudflare

Repair Workspace can now keep one shared artefact project with separate
condition layers selected by participant name. The existing interface remains
in place; Cloudflare Workers, D1, and R2 provide the collaboration backend.

See [`docs/cloudflare-collaboration.md`](docs/cloudflare-collaboration.md) for
resource creation, migration, deployment, local development, and workshop
testing instructions.

In Vercel project settings → Environment Variables, add:

| Variable | Why |
|---|---|
| `GEMINI_API_KEY` | all AI endpoints |
| `VITE_COLLAB_API_URL` | inlined into the browser bundle at build time, so the deployed site can reach the worker |
| `COLLAB_API_URL` | the same URL again, without the prefix — `VITE_` variables are build-time only and invisible to serverless functions, and `/api/chat` needs it to fetch a corpus document's full text |

Every deploy gets a unique URL; share it with participants.

## Repo layout

```
repair-workspace-v2/
├── src/
│   ├── index.html               shell with three tabs + FABs + chat sheet
│   ├── main.js                  orchestrator: state, views, AI flow
│   ├── core/                    schema, commands, state, migration
│   ├── ai/prompts/              chat.md, enrich-plan.md, … (version-controlled)
│   ├── views/                   one file per UI surface
│   │   ├── viewer-3d.js
│   │   ├── action-graph.js      cytoscape, mutex groups visualized
│   │   ├── spatial-graph.js
│   │   ├── radar.js             intent editor — axes are addable/removable
│   │   ├── entity-list.js       right-drawer parts & conditions
│   │   ├── chat-sheet.js
│   │   ├── detail-editor.js     part / condition / step editing + mark complete
│   │   └── execution-log.js
│   ├── styles/                  tokens, shell, components
│   └── public/examples/         worked example (old wooden door)
├── api/
│   ├── chat.js                  conversational endpoint (tool calling)
│   ├── enrich-plan.js           background step enrichment
│   ├── describe-photo.js …      Ist/Soll image pipeline
│   └── _shared/                 gemini client, prompt loader, workspace readers
├── tests/
├── docs/
│   ├── workflow.md              three-phase workflow mapped to v2 entities
│   ├── workshop-cheatsheet.md   ← print one per workshop station
│   └── known-issues.md
└── verify-setup.mjs             layout check
```

## What to test before the workshop

A focused smoke test on every device participants will use:

1. **Load the example** (left drawer → 🪑 Load example). 3D view should show a door with red defective parts and a yellow missing pane. Spatial graph should show parts + 1 condition. Action graph should say "No plan yet."
2. **Drag the intent radar.** Bottom-left console should show "set-intent" messages.
3. **Open chat** (💬 button). Type "Generate a plan that preserves as much of the original as possible." Wait 10–30s. The action graph should fill with steps, and the assistant message should carry an "Applied" audit card listing the tool calls.
4. **Tap a step in the Action graph.** The detail modal opens with the AI rationale.
5. **Tap "✓ Mark complete"** in the step detail modal. Fill the form. Step turns green.
6. **Press Ctrl+Z.** The completion undoes.
7. **Hit "Save"** in the left drawer. A `.zip` downloads containing `workspace.json` plus every photo *and* every generated image.
8. **Refresh the page.** Your work survives — including your strategies and your participant name.

If any step fails on a participant device but works on your laptop, that device probably has Safari quirks or aggressive privacy settings. iOS Safari is the most fragile.

## A note about the AI

The AI's changes are **transparent and reversible**, not gated. Every tool call the model makes is applied as one undoable batch and listed in an audit card on the message that caused it, so participants can see exactly what changed and undo it with Ctrl+Z.

An earlier design put every state change behind an approval modal. That modal was unreachable in the shipped build — and on reflection it was the wrong instrument anyway: approval-after-the-fact is a gate, not a dialogue, and it trains people to click through. The engagement this platform needs belongs *before* generation — eliciting priorities, forcing trade-offs, making the participant choose between branches — not after it. That is the subject of the next phase of work; see `PLAN.md`.
