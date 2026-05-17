/**
 * Chat sheet view.
 *
 * Wires the bottom-sheet chat input to /api/chat. Maintains conversation
 * threads scoped to global / part / hypothesis / step. Renders message
 * bubbles. Handles attached photos as multimodal input.
 *
 * The chat endpoint never mutates — it returns a reply, optional suggested
 * action, and an uncertainty list. The user takes the suggested action by
 * tapping the corresponding quick-action chip below, which calls propose.
 */

import { newMessage } from '../core/schema.js';
import { payloadForChat } from '../ai/ai-payload.js';

export function createChatSheet(elements, { onScopeChange, getWorkspace, onProposeIntent, onEnsureThread, onAppendMessage, onApplyCommands }) {
  const {
    history, input, sendBtn, scopePill, titleEl, closeBtn, handle, sheet
  } = elements;

  let currentScope = 'global';
  let currentRef = null;
  let pendingPhotos = [];
  // activeThread is always resolved fresh from the workspace at the
  // start of every operation that needs it — never cached across calls.
  // Holding a stale reference was the root cause of the "click anywhere
  // wipes the conversation" bug: re-rendering the workspace produced
  // new conversation objects, and the cached activeThread pointed at
  // garbage.
  let busy = false;

  function setBusy(b) {
    busy = b;
    input.disabled = b;
    sendBtn.disabled = b;
    input.placeholder = b ? 'Waiting for AI response…' : 'Ask, instruct, or describe what you see…';
  }

  function setScope(scope, ref, label) {
    currentScope = scope;
    currentRef = ref ?? null;
    scopePill.textContent = label || scope.toUpperCase();
    scopePill.classList.toggle('global', scope === 'global');
    onScopeChange?.({ scope, ref: currentRef });
    renderTitle();
    // Make sure a thread exists in the workspace for this scope/ref.
    // The callback dispatches start-conversation via apply(), which
    // persists and notifies listeners. We then read it back via
    // currentThread() — never store the reference.
    ensureThread();
    renderHistory();
  }

  function renderTitle() {
    const map = {
      global: 'Discuss the repair',
      instance: 'About the artefact',
      part: `About ${currentRef || 'part'}`,
      hypothesis: `About ${currentRef || 'condition'}`,
      step: `About ${currentRef || 'step'}`
    };
    titleEl.textContent = map[currentScope] || 'Discuss';
  }

  // Resolve the active thread from the workspace on every call. Never
  // cache — the workspace object is replaced on every apply() and stale
  // references silently lose updates.
  function currentThread() {
    const ws = getWorkspace();
    const wantRef = currentRef ?? null;
    return (ws.conversations || []).find(t =>
      t.scope === currentScope && (t.ref ?? null) === wantRef
    ) || null;
  }

  // Ensure a thread exists for the current scope/ref. If one is already
  // there, no-op. Otherwise ask main.js to dispatch start-conversation
  // so the thread is persisted in the workspace and survives re-renders.
  function ensureThread() {
    if (currentThread()) return;
    onEnsureThread?.({ scope: currentScope, ref: currentRef });
  }

  const SCOPE_DISPLAY = {
    global: 'global',
    instance: 'artefact',
    part: 'part',
    hypothesis: 'condition',
    step: 'step'
  };

  function renderHistory() {
    history.innerHTML = '';
    const thread = currentThread();
    const msgs = thread?.messages || [];
    if (!msgs.length) {
      const sys = document.createElement('div');
      sys.className = 'chat-system';
      sys.textContent = currentScope === 'global'
        ? 'Type a message or attach a photo to begin'
        : `Scoped to this ${SCOPE_DISPLAY[currentScope] || currentScope} — questions and changes apply here`;
      history.appendChild(sys);
    } else {
      msgs.forEach(m => appendBubble(m));
    }
    history.scrollTop = history.scrollHeight;
  }

  function appendBubble(msg) {
    const div = document.createElement('div');
    if (msg.role === 'system') {
      div.className = 'chat-system';
      div.textContent = msg.content;
    } else {
      div.className = `chat-bubble chat-${msg.role === 'user' ? 'user' : 'llm'}`;
      div.textContent = msg.content;
      if (msg.uncertainty?.length) {
        const un = document.createElement('div');
        un.className = 'chat-uncertainty';
        un.innerHTML = '<strong>Uncertain about:</strong><ul>' +
          msg.uncertainty.map(u => `<li>${escapeHtml(u)}</li>`).join('') + '</ul>';
        div.appendChild(un);
      }
      // New conversational mode: the AI directly performed tool calls.
      // Render a compact summary card listing what was done. This replaces
      // the old "Suggested action / Propose this →" affordance for tool
      // results — the actions have already been applied, so we just show
      // them as a record.
      if (Array.isArray(msg.toolCalls) && msg.toolCalls.length > 0) {
        const card = document.createElement('div');
        card.className = 'chat-actions-card';
        const summary = msg.plannedSummary
          ? msg.plannedSummary
          : `${msg.toolCalls.length} action${msg.toolCalls.length === 1 ? '' : 's'}`;
        card.innerHTML = `<span class="csa-label">✓ Applied:</span> ${escapeHtml(summary)}`;
        div.appendChild(card);
      }
      // Legacy suggested-action path — only show when there are no tool
      // calls (i.e. the response came from the old propose flow, not the
      // new direct conversational flow).
      else if (msg.suggestedAction && typeof msg.suggestedAction === 'string') {
        const sa = document.createElement('div');
        sa.className = 'chat-suggested';
        sa.innerHTML = `<span class="csa-label">Suggested action:</span> ${escapeHtml(msg.suggestedAction)}`;
        const btn = document.createElement('button');
        btn.className = 'csa-btn';
        btn.textContent = 'Propose this →';
        btn.onclick = () => onProposeIntent?.({ userMessage: msg.suggestedAction, scope: inferScopeFromAction(msg.suggestedAction) });
        sa.appendChild(btn);
        div.appendChild(sa);
      }
    }
    history.appendChild(div);
  }

  async function send() {
    const text = input.value.trim();
    if (!text && !pendingPhotos.length) return;
    setBusy(true);

    // Ensure the thread exists before we push anything — first-message
    // case where setScope ran but no thread was created yet (e.g. if
    // the workspace was empty at that moment).
    ensureThread();
    let thread = currentThread();
    if (!thread) {
      // Defensive: if the host didn't wire the callback, fall back to
      // appending to a transient thread. Messages won't persist but at
      // least the chat doesn't crash.
      console.warn('[chat-sheet] No thread persistence wired; messages are transient.');
    }

    // Persist the user message via the command system. We also build a
    // local copy with the same id/timestamp so we can include it in
    // the API request without round-tripping through the workspace.
    const userMsg = newMessage('user', text);
    if (thread) {
      onAppendMessage?.({ threadId: thread.id, message: userMsg });
      thread = currentThread();  // re-read; now contains the new message
    }
    appendBubble(userMsg);
    input.value = '';
    history.scrollTop = history.scrollHeight;

    const thinking = document.createElement('div');
    thinking.className = 'chat-bubble chat-llm chat-thinking';
    thinking.textContent = '… 0s';
    history.appendChild(thinking);
    history.scrollTop = history.scrollHeight;
    const startedAt = Date.now();
    const tickHandle = setInterval(() => {
      if (!thinking.isConnected) return;
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      thinking.textContent = `… ${elapsed}s`;
    }, 1000);

    // Client-side timeout. Mirrors the runPropose pattern in main.js —
    // without this, a hung server keeps "Waiting for AI response…"
    // forever and the user has no signal of failure.
    const controller = new AbortController();
    // Streaming responses can legitimately take longer than the old
    // single-shot timeout — the AI may stream text for 30s and then
    // do a few tool calls. Use a generous per-event timeout: as long as
    // we receive *something* every 30s, we keep going. The setTimeout
    // below is reset by each incoming chunk.
    const INACTIVITY_MS = 30_000;
    let inactivityHandle = setTimeout(() => controller.abort('inactivity-timeout'), INACTIVITY_MS);
    const resetInactivity = () => {
      clearTimeout(inactivityHandle);
      inactivityHandle = setTimeout(() => controller.abort('inactivity-timeout'), INACTIVITY_MS);
    };

    // We render a single assistant bubble that grows as text deltas
    // arrive, and accumulate tool calls into a sidebar list inside it.
    let liveBubble = null;
    let liveTextSpan = null;
    let liveActionsList = null;
    let liveText = '';
    const liveToolCalls = [];

    function ensureLiveBubble() {
      if (liveBubble) return;
      // Remove the thinking placeholder
      if (thinking.isConnected) thinking.remove();
      liveBubble = document.createElement('div');
      liveBubble.className = 'chat-bubble chat-llm chat-streaming';
      liveTextSpan = document.createElement('span');
      liveTextSpan.className = 'chat-streaming-text';
      liveBubble.appendChild(liveTextSpan);
      history.appendChild(liveBubble);
      history.scrollTop = history.scrollHeight;
    }

    function appendLiveText(delta) {
      ensureLiveBubble();
      liveText += delta;
      liveTextSpan.textContent = liveText;
      history.scrollTop = history.scrollHeight;
    }

    function appendLiveToolCall(event) {
      ensureLiveBubble();
      liveToolCalls.push(event);
      if (!liveActionsList) {
        liveActionsList = document.createElement('div');
        liveActionsList.className = 'chat-actions-card chat-actions-live';
        liveActionsList.innerHTML = '<span class="csa-label">✓ Applying:</span> <span class="csa-items"></span>';
        liveBubble.appendChild(liveActionsList);
      }
      const itemsEl = liveActionsList.querySelector('.csa-items');
      const item = document.createElement('span');
      item.className = 'csa-item';
      item.textContent = friendlyActionLabel(event);
      itemsEl.appendChild(item);
      // Brief pop-in animation
      requestAnimationFrame(() => item.classList.add('csa-item-in'));
      history.scrollTop = history.scrollHeight;
    }

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          thread,
          userMessage: text,
          workspace: payloadForChat({ workspace: getWorkspace(), scope: currentScope, maxMessages: 8 }),
          files: pendingPhotos
        }),
        signal: controller.signal
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        appendError(err.error || `Server returned ${res.status}`);
        return;
      }

      // Consume Server-Sent Events. Each event line: "data: {json}\n\n"
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let streamError = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        resetInactivity();
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const raw = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 2);
          if (!raw.startsWith('data:')) continue;
          const json = raw.slice(5).trim();
          if (!json) continue;
          let ev;
          try { ev = JSON.parse(json); } catch { continue; }

          if (ev.kind === 'text_delta') {
            appendLiveText(ev.text || '');
          } else if (ev.kind === 'tool_call') {
            // Apply the command immediately so the workspace updates live
            if (ev.result?.command) {
              try {
                onApplyCommands?.({
                  commands: [ev.result.command],
                  summary: friendlyActionLabel(ev)
                });
              } catch (err) {
                console.error('[chat-sheet] apply failed during stream:', err);
              }
            }
            appendLiveToolCall(ev);
          } else if (ev.kind === 'turn_complete') {
            // Optional: could indicate "thinking again..." between tool turns
          } else if (ev.kind === 'done') {
            // End of stream; loop will exit when reader is done
          } else if (ev.kind === 'error') {
            streamError = ev.error || 'Unknown server error';
          }
        }
      }

      if (streamError) {
        appendError(streamError);
      }

      // Persist the assistant message with its final text + tool call trace.
      const assistantMsg = newMessage('assistant', liveText);
      assistantMsg.toolCalls = liveToolCalls.map(t => ({
        name: t.name, args: t.args, result: t.result
      }));
      assistantMsg.plannedSummary = liveToolCalls.length
        ? liveToolCalls.map(friendlyActionLabel).join(', ')
        : '';
      const t2 = currentThread();
      if (t2) onAppendMessage?.({ threadId: t2.id, message: assistantMsg });

      // Replace the live streaming bubble with the final rendered version
      // so the styling matches other historical messages.
      if (liveBubble?.isConnected) liveBubble.remove();
      appendBubble(assistantMsg);

      pendingPhotos = [];
      updatePhotoPreview();
    } catch (err) {
      const wasInactivity = err.name === 'AbortError' && controller.signal.reason === 'inactivity-timeout';
      if (wasInactivity) {
        appendError('No response from the AI for 30s. The connection may have stalled. Try again.');
      } else if (err.name === 'AbortError') {
        appendError('Request was cancelled.');
      } else {
        appendError(err.message);
      }
    } finally {
      clearTimeout(inactivityHandle);
      clearInterval(tickHandle);
      if (thinking.isConnected) thinking.remove();
      setBusy(false);
      input.focus();
      history.scrollTop = history.scrollHeight;
    }
  }

  function appendError(msg) {
    const div = document.createElement('div');
    div.className = 'chat-bubble chat-llm chat-error';
    div.textContent = `Error: ${msg}`;
    history.appendChild(div);
  }

  function inferScopeFromAction(action) {
    const lower = action.toLowerCase();
    // Count how many distinct concept domains the action mentions. If it
    // mixes two or more, we must use 'all' scope — otherwise the AI will
    // only have access to one domain's commands and silently fail to do
    // the rest (e.g. "remove part X and update plan Y" picked 'interventions'
    // when 'plan' matched first, then the AI had no remove-part available).
    const mentionsPlan = /\bplan\b|\bstep\b|\bintervention\b/.test(lower);
    const mentionsHypothesis = /\bhypothes\w*\b|\bdamag\w*\b|\bcrack\b|\bcondition\b/.test(lower);
    const mentionsAssembly = /\bpart\b|\bassembly\b|\bcomponent\b|\bartefact\b/.test(lower);
    const domainCount = [mentionsPlan, mentionsHypothesis, mentionsAssembly].filter(Boolean).length;
    if (domainCount >= 2) return 'all';
    if (mentionsPlan) return 'interventions';
    if (mentionsHypothesis) return 'hypotheses';
    if (mentionsAssembly) return 'assembly';
    return 'all';
  }

  function attachPhoto(photo) {
    pendingPhotos.push(photo);
    updatePhotoPreview();
  }

  function updatePhotoPreview() {
    let preview = document.getElementById('chat-photo-preview');
    if (!preview) {
      preview = document.createElement('div');
      preview.id = 'chat-photo-preview';
      preview.className = 'chat-photo-preview';
      input.parentElement.insertBefore(preview, input);
    }
    preview.innerHTML = '';
    if (!pendingPhotos.length) { preview.style.display = 'none'; return; }
    preview.style.display = 'flex';
    pendingPhotos.forEach((p, i) => {
      const thumb = document.createElement('div');
      thumb.className = 'chat-photo-thumb';
      thumb.innerHTML = `<img src="data:${p.mimeType};base64,${p.data}" alt=""><button title="Remove">✕</button>`;
      thumb.querySelector('button').onclick = () => { pendingPhotos.splice(i, 1); updatePhotoPreview(); };
      preview.appendChild(thumb);
    });
  }

  function open() {
    document.body.classList.add('chat-open');
    // Thread is resolved fresh by send() and other callers via currentThread()
    // — see the comment near the top of the module about why activeThread
    // is never cached. Just focus the input.
    setTimeout(() => input.focus(), 200);
  }
  function close() { document.body.classList.remove('chat-open'); }
  function isOpen() { return document.body.classList.contains('chat-open'); }

  sendBtn.onclick = send;
  input.addEventListener('keypress', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
  closeBtn.onclick = close;

  let dragY = null, startH = null;
  handle.addEventListener('pointerdown', e => {
    dragY = e.clientY;
    startH = sheet.getBoundingClientRect().height;
    handle.setPointerCapture(e.pointerId);
  });
  handle.addEventListener('pointermove', e => {
    if (dragY == null) return;
    const dy = e.clientY - dragY;
    const h = Math.max(220, Math.min(window.innerHeight * 0.85, startH - dy));
    sheet.style.maxHeight = `${h}px`;
    sheet.style.minHeight = `${h}px`;
  });
  handle.addEventListener('pointerup', e => { dragY = null; handle.releasePointerCapture(e.pointerId); });

  input.disabled = false;
  sendBtn.disabled = false;

  function pushMessage(role, content, extras = {}) {
    ensureThread();
    const thread = currentThread();
    const m = newMessage(role, content);
    Object.assign(m, extras);
    if (thread) onAppendMessage?.({ threadId: thread.id, message: m });
    appendBubble(m);
    history.scrollTop = history.scrollHeight;
  }

  function pushActionRecord(text) {
    ensureThread();
    const thread = currentThread();
    const m = newMessage('system', text);
    if (thread) onAppendMessage?.({ threadId: thread.id, message: m });
    appendBubble(m);
    history.scrollTop = history.scrollHeight;
  }

  function refresh() {
    // Called when the workspace was replaced externally (load, reset).
    // Re-render from whatever the workspace now contains. No need to
    // re-resolve a cached reference — currentThread() always looks it
    // up fresh from getWorkspace().
    renderHistory();
  }

  return {
    setScope,
    open, close, isOpen,
    attachPhoto,
    getCurrentMessage() { return input.value; },
    setMessage(text) { input.value = text; input.focus(); },
    getCurrentScope() { return { scope: currentScope, ref: currentRef }; },
    pushMessage,
    pushActionRecord,
    setBusy,
    refresh
  };
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * Human-readable label for a tool call event, used in the live "Applying:"
 * chip list and the final message summary. Compact form so many fit in
 * one line: "added Crack on front_left_leg" → "Crack on front_left_leg".
 */
function friendlyActionLabel(ev) {
  if (!ev) return '';
  const name = ev.name;
  const a = ev.args || {};
  switch (name) {
    case 'add_condition': return `+ ${a.type} on ${a.partRef}`;
    case 'remove_condition': return `− condition`;
    case 'update_condition': return `~ condition`;
    case 'create_plan': return `+ plan "${a.label}" (${(a.steps || []).length} steps)`;
    case 'add_step': return `+ step "${a.title}"`;
    case 'update_step': return `~ step`;
    case 'remove_step': return `− step`;
    case 'add_edge': return `→ link`;
    case 'remove_edge': return `× link`;
    case 'set_intent': return `~ intent`;
    case 'set_constraints': return `~ constraints`;
    case 'set_active_plan': return `→ active plan`;
    case 'remove_plan': return `− plan`;
    default: return name;
  }
}
