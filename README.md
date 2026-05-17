# Repair Workspace v2

A representation-based workflow for repair design. Coupling spatial models, condition cataloguing, and procedural action graphs with multimodal AI assistance — without giving up human authorship.

Built for a workshop deploy on Vercel. Each participant works on a different object on their own laptop or phone. All workspace data lives in browser `localStorage`; AI calls go through Vercel serverless functions to Google Gemini.

## What works now (pass 2b complete)

- **Shell**: three-tab viewer (Action / Spatial / 3D), FAB-driven layout that collapses to drawers on mobile, workshop typography (Inter Tight / Fraunces / JetBrains Mono).
- **Data model**: parts, conditions with suspected/confirmed/refuted lifecycle, plans with steps + prerequisites + mutex groups for alternatives, execution log, conversation threads.
- **Command pattern**: every mutation is reversible, full undo via Ctrl+Z.
- **AI loop**: chat for thinking, propose for state changes. Review modal with collapsible per-command checkboxes — partial acceptance is one click away.
- **Quick-action chips**: scope-aware verbs that bundle the chat input with a propose call.
- **Justification panel**: tap any step → traces back to the driving conditions (clickable), intent axes (with current values), and rationale.
- **Execution log**: marking a step complete opens a form for actual time, deviation, and rationale.
- **Photo attachments**: snap or upload, attached as multimodal input to chat or propose.
- **Migration**: v1 workspace JSON loads and converts automatically.

## What didn't make pass 2b (deferred to v1.1 post-workshop)

- Drag-to-connect in the action graph (currently you edit via detail modal)
- Execution log *viewer* (entries are recorded; chronological view is missing)
- Vercel Blob for photos — currently photos travel inline as base64 (heavier payloads)
- Approval workflow on plans
- Template / instance split
- The repair-pattern library (RAG)

See `docs/known-issues.md` for the full list.

## Setup

```bash
npm install
npm run verify       # checks layout
npm run test:migrate # round-trips v1 example
npm run test:commands
npm run dev          # vite on :5173
```

For AI endpoints during local dev:

```bash
npm install -g vercel
echo "GEMINI_API_KEY=your-key-here" > .env.local
vercel dev           # serves /api on :3000, vite proxies
```

Get a Gemini API key from [Google AI Studio](https://aistudio.google.com/apikey) — free tier is enough for a workshop with a dozen participants.

## Deploy to Vercel

```bash
vercel               # first time: link the project
vercel --prod        # deploy to production URL
```

In Vercel project settings → Environment Variables, add `GEMINI_API_KEY`. Every deploy gets a unique URL; share it with participants.

## Repo layout

```
repair-workspace-v2/
├── src/
│   ├── index.html               shell with three tabs + FABs + chat sheet
│   ├── main.js                  orchestrator: state, views, AI flow
│   ├── core/                    schema, commands, state, migration
│   ├── ai/prompts/              propose.md, chat.md (version-controlled)
│   ├── views/                   one file per UI surface
│   │   ├── viewer-3d.js
│   │   ├── action-graph.js      cytoscape, mutex groups visualized
│   │   ├── spatial-graph.js
│   │   ├── radar.js             intent editor
│   │   ├── entity-list.js       right-drawer parts & conditions
│   │   ├── chat-sheet.js        ← pass 2b
│   │   ├── quick-actions.js     ← pass 2b
│   │   ├── propose-review.js    ← pass 2b
│   │   ├── justification-panel.js ← pass 2b
│   │   └── execution-log.js     ← pass 2b
│   ├── styles/                  tokens, shell, components
│   └── public/examples/         worked example (old wooden door)
├── api/
│   ├── propose.js               unified state-change endpoint
│   ├── chat.js                  conversational endpoint
│   └── _shared/                 gemini client, prompt loader
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
3. **Open chat** (💬 button). Type "Generate a plan that preserves as much of the original as possible." Wait 10–30s for the propose modal. Accept. Action graph should fill with steps.
4. **Tap a step in the Action graph.** Justification panel slides in on the right showing rationale.
5. **Tap "✓ Mark complete"** chip. Fill the form. Step turns green.
6. **Press Ctrl+Z.** The completion undoes.
7. **Hit "Save JSON"** in the left drawer. A `.json` file downloads.
8. **Refresh the page.** Your work survives via localStorage.

If any step fails on a participant device but works on your laptop, that device probably has Safari quirks or aggressive privacy settings. iOS Safari is the most fragile.

## A note about the AI

The AI proposes. The human disposes. Every state-changing AI output goes through the review modal where you can reject or accept individual commands. This is not optional — it's the whole point of the paper's framework. Train participants to read what they're accepting.
