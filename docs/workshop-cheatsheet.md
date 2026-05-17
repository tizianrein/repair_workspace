# Workshop cheat-sheet

A one-page guide for participants. Print one per station.

## Three phases — work through them in this order

### 1 · Tell the system what you're looking at
- Tap 💬 (red button) to open chat.
- Either describe your object ("1960s wooden chair, front leg wobbles, scratches on seat") or tap 📷 to attach photos.
- Hit Send. The AI replies with what it thinks it sees.
- Tap the **🧱 Extract assembly** chip below the chat input. Review the proposed parts in the modal. Accept → 3D view fills in.
- Tap **📍 Catalog conditions** to register what might be wrong.

### 2 · Set priorities and generate a plan
- Open the left drawer (☰). Drag the **intent radar** to weight what matters: authenticity, structure, cost, reversibility, etc.
- Edit constraints (time budget, tools you have, skill level).
- Back in chat, tap **📝 Generate plan**. The AI proposes a plan with steps and alternatives.
- Review carefully. Accept selected commands (use checkboxes for partial acceptance).
- Action graph fills with your plan.

### 3 · Inspect, refine, execute
- Tap a step in the Action graph → justification panel slides in on the right showing **why this step is here**.
- Tap a step → chat scopes to it. Ask "I don't have a chisel — what should I use instead?"
- When you complete a step in real life, tap it and use the **✓ Mark complete** chip. Fill in actual time and any deviations.
- Disagree with the plan? Type your reason in chat and tap **♻️ Replan**.

## Visual cues to know
| Color | Meaning |
|---|---|
| Red (💢) | Defective part / confirmed condition / signal action |
| Yellow | Missing part / suspected condition |
| Purple | New replacement part |
| Green | Repaired part / completed step |
| Blue | Currently selected |
| Dashed red border | Mutex group (pick one alternative) |

## When something goes wrong
- **AI proposed nonsense?** Reject the modal, or uncheck individual commands and accept only what's right.
- **Page seems stuck?** Plan generation takes 10–30 seconds. Wait, or check the bottom-left console message.
- **Made a mistake?** Press **Ctrl+Z** to undo any change.
- **Lost everything?** Tap "Save JSON" often. Browser refresh keeps your work in localStorage.

## What the system does NOT do
- It does not guarantee structural soundness, code compliance, or conservation appropriateness. **A trained expert must validate any real intervention.**
- The AI can hallucinate. Read every proposal carefully before accepting.
- Photos are stored in the workspace JSON — keep file size reasonable.
