# Workshop Hotfix v5 — minimal

Built by stripping v4 back to its essentials. **The base is your old well-
behaved repo** (the `repair_workspace_23.zip` version you said felt good)
plus only the changes that fix actual bugs — nothing that tries to "improve"
model behaviour by adding more retries, escalations, or guards.

## Why this exists

v1 → v2 → v3 → v4 each added safety nets that turned out to make things
worse, not better:

- **v2 switched default to Pro.** Pro is more conversational, less action-
  oriented. That's where the "says it did things but didn't" problem came
  from. v3 partially walked it back; v4 left the machinery in place anyway.
- **v3 added a 'design process / snowflake' prompt section.** Intended to
  encourage engagement; in practice it produced wall-of-text replies with
  enumerated lists and `**bold**` markdown leaks.
- **v3 added the honesty guard with retry-on-Pro.** Net effect: 10s slower
  per turn on the failure path, and the underlying lying behaviour was
  itself caused by the v2 Pro-switch.
- **v2 added a tool_code stripper in gemini.js.** Tool_code leaks are
  basically a Flash-as-Pro problem; rare on Flash-as-default.

The old version had none of that and felt fast and engaging. v5-minimal
goes back to that baseline and adds only:

## What v5-minimal adds vs. the old baseline

1. **Step-reference resolution** (the v1 fix).
   Fixes the `add_edge` failures where Gemini referenced step ids it had
   invented (e.g. `repair_feet_ends`) or that don't exist verbatim. The
   server now resolves source/target against the live plan AND any steps
   created earlier in the same turn, normalizing for German diacritics
   and snake_case slugs.

2. **`pendingPlanId` turn-context** (the v2 fix).
   When the model creates a plan and adds steps to it in the same chat
   turn, the steps now actually go into the new plan — not the previously
   active one. The client's `currentPlanId` only updates after the whole
   batch applies, so without this the model worked on stale data.

3. **`add_condition` coordinates default** (the v4 fix).
   AI-added conditions now get default coordinates at the centre of the
   referenced part's bounding box, so they show as red spheres in the 3D
   viewer instead of being invisible there (only visible in the right-side
   list and detail modal).

4. **Server-side markdown stripper**.
   Strips `**bold**`, `## headings`, `- bullets`, `` `code` `` from chat
   replies before they reach the UI. Safety net for when the prompt rule
   "no markdown" isn't followed. Critically, leaves `snake_case` identifiers
   like `front_left_leg` untouched.

5. **Hardened tool descriptions** (chat-tools.js).
   `add_step` and `add_edge` descriptions now tell the model explicitly:
   pass exact ids, use `afterStepId`/`beforeStepId` when wiring a fresh
   step in. Reduces the rate at which step-resolution errors happen in
   the first place.

6. **Subtle step-id reminder in chat.md** (one paragraph after "Big plans").
   Same idea as point 5 but in prose form in the prompt. Not a heavy
   `CRITICAL` block — just one paragraph.

7. **Version badge `hotfix-v5`** in top-left.

## What v5-minimal does NOT have (intentionally removed from v2/v3/v4)

- Pro escalation on Flash failure
- Pro cool-down tracking
- Honesty-guard action-claim detection
- Honesty-retry with model escalation
- `tool_code` stripping in gemini.js (still in chat-engine via stripChatMarkdown's broader pass, but no dedicated detector + retry path)
- `CRITICAL — output format`, `CRITICAL — no markdown`, `CRITICAL — say-do alignment` prompt sections
- `The design process — what this conversation actually is` prompt section
- `Say/do alignment — worked examples` prompt section
- Modified Tone bullets (restored to the old wording you said was good)

## Sizes

| | chat-engine | gemini | chat-tools | chat.md | total |
|---|---|---|---|---|---|
| Old (worked well) | 365 | 536 | 261 | 153 | 1315 |
| v5-minimal | 581 | 536 | 261 | 156 | 1533 |
| v4 (overloaded) | 767 | 618 | 261 | 270 | 1916 |

v5-minimal adds 218 lines over the old baseline — all in chat-engine.js
(step resolution + markdown stripper + coordinates fix). gemini.js is
identical to old. chat.md is +3 lines for one paragraph about wiring
new steps.

## How to apply

Drop the seven files over your repo and deploy:

```
api/_shared/chat-engine.js
api/_shared/chat-tools.js
api/_shared/gemini.js
src/ai/prompts/chat.md
src/index.html
tests/test-step-resolution.mjs
package.json
```

Then commit, push (or `vercel --prod`).

## Verify before deploying

```
npm run test:commands           # baseline
npm run test:step-resolution    # 34 tests, all green
```

After deploy, badge top-left should read `v2 · graph-driven · hotfix-v5`.
Hard-refresh the browser (`Cmd/Ctrl+Shift+R`) to clear the cached HTML.

## What you should notice

- **Faster replies again.** No Pro escalation, no honesty retry. Single
  Flash call per turn, just like the old version felt.
- **Engaging follow-ups.** Old prompt restored. Flash should resume the
  "and one more thing" energy: act, then offer the next observation or
  question that a thoughtful colleague would raise.
- **3D conditions visible.** AI-added conditions now show as spheres in
  the 3D proxy.
- **Step wiring works.** The `repair_feet_ends`-style failures are gone.
- **No `**bold**` literals.** The stripper catches markdown leaks.

## Honest caveats

- If "AI says it did X but didn't" returns, it's because we removed the
  honesty guard. The old version had this issue rarely (Flash was act-
  freudig). If it shows up significantly in the workshop, we can add a
  minimal guard back post-workshop, but it always slows things down.
- The "tool_code" leak (the Python-like code blob in chat) can in theory
  still happen on Flash. It was rare before; if it shows up, the markdown
  stripper catches most of it via the inline-code regex but not all of it.
- Plan-edit edge cases (the "Update the plan → mager result"-thing) come
  from the model treating "update" as "delete and recreate". Old prompt
  doesn't fully address this either. Best fix is conversation: tell the
  model "update, don't replace" if it does the wrong thing.

## Rollback

If anything breaks: the old version is at `repair_workspace_23.zip` in
your downloads. Restore those four files (`chat-engine.js`, `gemini.js`,
`chat-tools.js`, `chat.md`) and you're back to where you were before.
