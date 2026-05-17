# Workshop Hotfix: add_edge step-ref resolution

## What this fixes
The workshop bug where Gemini calls `add_edge` with a step name that doesn't
exist in the plan — typically a snake_case slug it invented (e.g.
`repair_feet_ends`), or a step title verbatim (e.g. `Grundierung auftragen`),
or a reference to a step it created earlier in the same turn but whose
server-generated id it cannot know. The whole batch failed at apply-time and
the user saw "Den Schritt sehe ich aber nicht".

## What it doesn't change
- Storage format (no migration needed)
- Client code (no rebuild needed)
- The vocabulary of tools the model can call
- Existing tests (`test:commands` still passes)

## How to apply

Drop these 5 files over the corresponding files in your repo (3 modified, 1
new, 1 modified):

```
api/_shared/chat-engine.js      ← modified (main fix: alias map + resolver)
api/_shared/chat-tools.js       ← modified (hardened tool descriptions)
src/ai/prompts/chat.md          ← modified (added "Step ids" rules section + worked example)
tests/test-step-resolution.mjs  ← NEW (20 unit tests for the resolver)
package.json                    ← modified (one new npm script: test:step-resolution)
```

Then redeploy:

```
vercel --prod
```

No `npm install` needed.

## Verify locally before deploying

```
npm run test:commands          # existing tests, should still pass
npm run test:step-resolution   # new tests, should be 20/20 green
```

## How the fix works (one paragraph)

The chat engine now tracks every step the model creates within a single chat
turn — keyed by its server-assigned real id AND by every alias the model
might plausibly reference it by (its title, the snake_case slug of its
title, any `slug` it requested). When `add_edge` runs, source/target are
resolved against (a) the live workspace plan and (b) the in-turn pending-
steps registry. If resolution succeeds, the real ids are substituted. If it
fails, the tool returns `{ error: ... }` instead of producing a broken
command — Gemini sees the error in the functionResponse and gets to fix
itself in the same turn. The whole batch no longer dies on the client.

Also: `create_plan` now silently drops internal edges that don't resolve
(better a partial plan than no plan), and `add_step`'s afterStepId /
beforeStepId now resolve via the same logic (so the model can pass either
a real id or a title there).

## Behavioural rollback

If for some reason this breaks something in the workshop, revert just
`api/_shared/chat-engine.js` and `api/_shared/chat-tools.js` from your git
history and redeploy. The prompt change is harmless on its own.
