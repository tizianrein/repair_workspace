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

import { newConversation, newMessage } from '../core/schema.js';

export function createChatSheet(elements, { onScopeChange, getWorkspace, onProposeIntent }) {
  const {
    history, input, sendBtn, scopePill, titleEl, closeBtn, handle, sheet
  } = elements;

  let currentScope = 'global';
  let currentRef = null;
  let pendingPhotos = [];
  let activeThread = null;
  let busy = false;

  function setBusy(b) {
    busy = b;
    input.disabled = b;
    sendBtn.disabled = b;
    input.placeholder = b ? 'Waiting for AI response…' : 'Ask, instruct, or describe what you see…';
  }

  function setScope(scope, ref, label) {
    currentScope = scope;
    currentRef = ref;
    scopePill.textContent = label || scope.toUpperCase();
    scopePill.classList.toggle('global', scope === 'global');
    onScopeChange?.({ scope, ref });
    renderTitle();
    activeThread = findOrCreateThread();
    renderHistory();
  }

  function renderTitle() {
    const map = {
      global: 'Discuss the repair',
      instance: 'About the object',
      part: `About ${currentRef || 'part'}`,
      hypothesis: `About ${currentRef || 'hypothesis'}`,
      step: `About ${currentRef || 'step'}`
    };
    titleEl.textContent = map[currentScope] || 'Discuss';
  }

  function findOrCreateThread() {
    const ws = getWorkspace();
    let thread = (ws.conversations || []).find(t => t.scope === currentScope && t.ref === currentRef);
    if (!thread) thread = newConversation(currentScope, currentRef);
    return thread;
  }

  function renderHistory() {
    history.innerHTML = '';
    const msgs = activeThread?.messages || [];
    if (!msgs.length) {
      const sys = document.createElement('div');
      sys.className = 'chat-system';
      sys.textContent = currentScope === 'global'
        ? 'Type a message or attach a photo to begin'
        : `Scoped to this ${currentScope} — questions and changes apply here`;
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
      if (msg.suggestedAction) {
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

    const userMsg = newMessage('user', text);
    activeThread.messages.push(userMsg);
    appendBubble(userMsg);
    input.value = '';
    history.scrollTop = history.scrollHeight;

    const thinking = document.createElement('div');
    thinking.className = 'chat-bubble chat-llm chat-thinking';
    thinking.textContent = '…';
    history.appendChild(thinking);
    history.scrollTop = history.scrollHeight;

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          thread: activeThread,
          userMessage: text,
          workspace: getWorkspace(),
          files: pendingPhotos
        })
      });
      thinking.remove();
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        appendError(err.error || `Server returned ${res.status}`);
        return;
      }
      const payload = await res.json();
      const assistantMsg = newMessage('assistant', payload.reply);
      assistantMsg.suggestedAction = payload.suggestedAction;
      assistantMsg.uncertainty = payload.uncertainty || [];
      activeThread.messages.push(assistantMsg);
      appendBubble(assistantMsg);
      pendingPhotos = [];
      updatePhotoPreview();
    } catch (err) {
      thinking.remove();
      appendError(err.message);
    } finally {
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
    if (!activeThread) activeThread = findOrCreateThread();
    const m = newMessage(role, content);
    Object.assign(m, extras);
    activeThread.messages.push(m);
    appendBubble(m);
    history.scrollTop = history.scrollHeight;
  }

  function pushActionRecord(text) {
    if (!activeThread) activeThread = findOrCreateThread();
    const m = newMessage('system', text);
    activeThread.messages.push(m);
    appendBubble(m);
    history.scrollTop = history.scrollHeight;
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
    setBusy
  };
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
