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

export function createChatSheet(elements, { onScopeChange, getWorkspace, onProposeIntent, onEnsureThread, onAppendMessage }) {
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
      if (msg.suggestedAction && typeof msg.suggestedAction === 'string') {
        // Only render the suggested-action affordance when the server gave
        // us a proper string. If a non-string slips through (model bug,
        // schema drift), drop it silently rather than render [object Object]
        // and a Propose button that points at garbage.
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
    const CHAT_TIMEOUT_MS = 45_000;
    const timeoutHandle = setTimeout(() => controller.abort('client-timeout'), CHAT_TIMEOUT_MS);

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
      const payload = await res.json();
      const assistantMsg = newMessage('assistant', payload.reply);
      assistantMsg.suggestedAction = payload.suggestedAction;
      assistantMsg.uncertainty = payload.uncertainty || [];
      // Re-resolve the thread before appending — apply() may have
      // produced a new workspace object since we last looked.
      const t2 = currentThread();
      if (t2) onAppendMessage?.({ threadId: t2.id, message: assistantMsg });
      appendBubble(assistantMsg);
      pendingPhotos = [];
      updatePhotoPreview();
    } catch (err) {
      const wasOurTimeout = err.name === 'AbortError' && controller.signal.reason === 'client-timeout';
      if (wasOurTimeout) {
        const elapsedS = Math.round((Date.now() - startedAt) / 1000);
        appendError(`No response after ${elapsedS}s — server timeout or cold start. Try again.`);
      } else {
        appendError(err.message);
      }
    } finally {
      clearInterval(tickHandle);
      clearTimeout(timeoutHandle);
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
    if (/\bplan\b|\bstep\b|\bintervention\b/.test(lower)) return 'interventions';
    if (/\bhypothes\w*\b|\bdamag\w*\b|\bcrack\b|\bcondition\b/.test(lower)) return 'hypotheses';
    if (/\bpart\b|\bassembly\b|\bcomponent\b/.test(lower)) return 'assembly';
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
    if (!activeThread) activeThread = findOrCreateThread();
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
    getActiveThread() { return activeThread; },
    pushMessage,
    pushActionRecord,
    setBusy,
    refresh
  };
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
