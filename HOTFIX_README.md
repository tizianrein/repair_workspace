# Workshop Hotfix v3

Builds on v2. Inverts the model strategy (Flash first, Pro on failure),
adds an honesty guard against fake action claims, and rewrites the prompt
to encourage proactive design-process behaviour with proper paragraphs.

## What v3 changes

### 1. Model strategy: Flash first, Pro on failure
Flash is now the default. It's more eager to call tools, faster (~2x), and
cheaper (~3-4x). Pro is only invoked when Flash produces a recognizable
failure signal:
- a thrown error (MALFORMED_FUNCTION_CALL, MAX_TOKENS, network)
- an empty response with no tool calls
- a tool_code-as-text leak

This is the inverse of v2 and matches the observed reality of the workshop
preview: Pro consistently produced long descriptive replies with zero tool
calls ("the chat says it changed things but the workspace didn't change").
Flash actually acts.

### 2. Honesty guard
Detects replies that claim past-tense actions ("Ich habe X gemacht",
"I have changed Y") while calling zero tools. Behaviour:
- One retry on Pro (Flash → Pro escalation, or stay on Pro if already there)
  with a sharp "either call the tools or rewrite as a question" instruction
- If retry succeeds (tools called OR claims removed), use the retry
- If retry fails, annotate the original reply with a transparent warning
  telling the user nothing actually happened and asking them to retry

Detector covers German + English action verbs, passive forms, and is
careful not to fire on questions, options-discussion, or short
confirmations. Tested against real strings from the workshop screenshots —
all flag correctly, none false-positive.

### 3. Prompt rewrite
- New "CRITICAL — say-do alignment" section right at the top:
  rules + concrete worked examples for "Ja, konservierung" (the exact
  scenario from your screenshots).
- New "The design process — what this conversation actually is" section:
  encourages the snowflake-growth pattern. After each move, look at what's
  still thin (default intent values? empty constraints? plan with no edges?
  one strategy where two might fit? a part with no condition?) and surface
  ONE next-most-useful question. Not a checklist robot — a workshop master.
- New paragraph rule: replies over ~4 sentences must use blank-line-separated
  paragraphs (`\n\n`) for readability. Walls of text are unreadable.
- Removed the old "NEVER enumerate every change" rule that was too strict —
  it suppressed the engaging "here's what changed and what it means"
  pattern you want.

### 4. Tests
33 tests, all green. New tests cover the honesty detector with exact
strings from the workshop screenshots.

## What this does NOT change

- Storage format / data model (no migration)
- Client code (no rebuild needed)
- Vocabulary of tools the model can call
- The propose endpoint (still uses its own model setting)
- The v1 step-ref resolution
- The v2 pendingPlanId turn-context

## How to apply

Drop these 6 files over the corresponding files in your repo:

```
api/_shared/chat-engine.js      ← modified (Flash-first, honesty guard)
api/_shared/chat-tools.js       ← unchanged from v2
api/_shared/gemini.js           ← modified (tool_code leak surfaced as signal)
src/ai/prompts/chat.md          ← rewritten (say-do, snowflake, paragraphs)
tests/test-step-resolution.mjs  ← extended (33 tests now, was 24)
package.json                    ← unchanged from v2
```

Then commit + push (or `vercel --prod` directly).

## Verify locally before deploying

```
npm run test:commands           # should still pass
npm run test:step-resolution    # 33 tests, all green
```

## What participants will likely notice

- **Faster replies.** Flash is ~2x faster than Pro.
- **More actual changes happening.** Flash actually calls the tools when
  told to act. The "talks about doing it but doesn't" pattern should
  largely disappear on the first try; the honesty guard catches the
  remaining cases.
- **More engaging conversation.** Replies should regularly include a
  "and one more thing" observation or open question instead of just
  "Done." The design feels more like a process, less like a transactional bot.
- **Better-formatted long replies.** Paragraphs with blank lines instead
  of walls of text.
- **Occasional honesty warnings.** If the model still claims something
  it didn't do, you'll see "— Hinweis: Ich habe oben Änderungen
  beschrieben, aber im Workspace ist nichts angepasst worden..." at
  the bottom of the reply. That's the safety net working.
- **Tool_code leaks essentially gone.** Flash rarely leaks tool_code,
  and when it does, the engine escalates to Pro which almost never does.

## Cost / quota note

Flash-first is much cheaper than v2's Pro-first. Per-token Flash is roughly
1/3 the price of Pro. For 12 participants in a 3-4 hour workshop, expect
$3-5 in API cost, well within free tier.

The Pro escalation kicks in only on Flash failure, which is rare.

## Rollback

If something breaks, revert `api/_shared/chat-engine.js`,
`api/_shared/gemini.js`, and `src/ai/prompts/chat.md` from your git
history and redeploy. The other files are unchanged from v2.

## What's NOT in v3 (intentional)

- **Clickable option buttons.** Deferred to post-workshop. Would need new
  tool definition + UI renderer + state handling — too risky 36 hours
  before workshop.
- **"Plan-update results in mager + intent reset" bug.** This is likely
  caused by the model itself when it does remove_plan + add_plan instead
  of update_plan. The new prompt's "take the chance to do it richly"
  guidance addresses it at the model level. If it persists, that's the
  next thing to look at.
