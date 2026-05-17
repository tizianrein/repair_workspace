# Workshop Hotfix v4

Builds on v3. Three new fixes from the latest workshop preview:

## What v4 fixes

### 1. AI-added conditions now show as red spheres in the 3D viewer
**Bug:** When the AI called `add_condition`, the resulting hypothesis had no
`coordinates` field. The 3D viewer skips rendering spheres for any
hypothesis without coordinates (line 127 in `viewer-3d.js`:
`if (!h.coordinates) return;`). So AI-added conditions appeared in the
right-side list and the detail modal, but were invisible in the 3D proxy.

**Fix:** Server-side, `add_condition` now computes default coordinates at
the centre of the referenced part's bounding box (origin + dimensions/2).
Tested with the exact backrest case from the screenshot.

### 2. Server-side markdown stripping
**Bug:** Despite the prompt forbidding markdown, Flash (and sometimes Pro)
still leaks `**bold**`, `## headings`, `- bullets`, and `` `inline code` ``
into chat replies. The UI doesn't render them, so the user sees literal
asterisks and hashes.

**Fix:** Added a `stripChatMarkdown()` function that runs on every reply
before it's returned to the client. Removes:
- `**bold**` and `__bold__` (keeps the words)
- `*italic*` and `_italic_` (carefully — does NOT eat snake_case identifiers)
- `#`/`##`/`###` heading markers
- `-` and `*` bullet list markers at line starts
- `` `inline code` `` backticks

Tested against real strings from the workshop screenshots. Crucially,
`front_left_leg` and similar snake_case ids survive untouched.

### 3. Stronger anti-markdown prompt rule
Added a new "CRITICAL — no markdown in chat replies" section at the very
top of `chat.md`, alongside the existing CRITICAL output-format and
say-do-alignment sections. The model now gets the rule three times
(prompt section, examples, server-side strip as safety net).

## What this does NOT change

- Data model / storage
- Client code (only `src/index.html` for the version badge update)
- Vocabulary of tools
- The v1/v2/v3 fixes (step resolution, pendingPlanId, honesty guard,
  Flash-first model strategy)

## Files in this patch

```
api/_shared/chat-engine.js      ← modified (add_condition coordinates, markdown stripper)
api/_shared/chat-tools.js       ← unchanged from v3
api/_shared/gemini.js           ← unchanged from v3
src/ai/prompts/chat.md          ← extended (anti-markdown CRITICAL section)
src/index.html                  ← version bump (hotfix-v3 → hotfix-v4)
tests/test-step-resolution.mjs  ← 43 tests now (was 33)
package.json                    ← unchanged
```

## How to apply

Drop the seven files over your repo, commit, push (or `vercel --prod`).
Hard-refresh the browser after deploy (`Cmd/Ctrl+Shift+R`) so the
version badge updates.

## Verify locally

```
npm run test:commands           # baseline
npm run test:step-resolution    # 43 tests, all green
```

The badge top-left should now read `v2 · graph-driven · hotfix-v4`.

## Known issues NOT fixed in v4

- **Long response times (~10-15s) when honesty guard triggers + Pro
  escalation.** That's the cost of the safety net. Acceptable for the
  workshop; can be optimized later by tightening the action-claim regex
  to fire less often on false positives.
- **AI sometimes still claims to do things and doesn't.** The honesty
  guard catches it most of the time, but not 100%. When it slips through,
  the user sees a warning footer "— Hinweis: Ich habe oben Änderungen
  beschrieben, aber im Workspace ist nichts angepasst worden..."
- **The Plan-update-results-in-thin-plan behaviour.** Still a Gemini
  modelling quirk. The prompt nudges against it; full fix would need
  prompt + tool surgery, deferred post-workshop.

## Rollback

Revert `chat-engine.js` and `chat.md` to v3 if needed. `src/index.html`
is just a label change, harmless.
