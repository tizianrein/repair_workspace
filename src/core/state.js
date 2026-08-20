/**
 * State container.
 *
 * Owns the single workspace object, the undo/redo history, and the list of
 * listener functions that views subscribe with. Persists to localStorage on
 * every change so participants don't lose work if they refresh.
 *
 * Three properties this module is responsible for, all of which were broken
 * and are load-bearing for a workshop with ~10 concurrent participants:
 *
 *   1. A reload must not lose work. `restore()` migrates old schema versions
 *      instead of discarding them.
 *   2. The participant's identity must survive a reload, so nobody retypes
 *      their name every time the page comes back.
 *   3. A failed write must be visible. Silently running on a stale stored copy
 *      is worse than saying "storage is full".
 */

import { newWorkspace, validateWorkspace, SCHEMA_VERSION } from './schema.js';
import { migrateV1ToV2 } from './migrate.js';

const STORAGE_KEY = 'repair-workspace-v2';
const IDENTITY_KEY_PREFIX = 'repair-workspace-v2-identity:';

export function createState() {
  return {
    workspace: newWorkspace(),
    history: [],
    future: [],
    listeners: new Set(),
    // Transient project/name/view state. The shared condition data itself
    // remains in workspace.conditions so every existing view keeps working.
    collaboration: {
      projectId: null,
      projectTitle: '',
      activeAuthorName: '',
      activeAuthorKey: '',
      scope: 'mine',
      readOnly: false,
      syncState: 'idle'
    }
  };
}

export function subscribe(state, listener) {
  state.listeners.add(listener);
  return () => state.listeners.delete(listener);
}

export function notify(state, event = null) {
  state.listeners.forEach(fn => fn(state.workspace, event));
}

export function setWorkspace(state, workspace) {
  const validation = validateWorkspace(workspace);
  if (!validation.ok) {
    console.warn('Workspace validation failed:', validation.errors);
  }
  state.workspace = workspace;
  state.history = [];
  state.future = [];
  notify(state, { type: 'replace-workspace' });
}

// ============================================================================
// PERSISTENCE
// ============================================================================

/**
 * Write the workspace to localStorage.
 *
 * Returns { ok, error?, degraded? }. Callers must not ignore the result:
 * the previous implementation swallowed the exception and returned a boolean
 * nobody checked, so once the ~5 MB quota was reached the app carried on
 * against a stale stored copy and a refresh silently rolled the user back.
 *
 * On a quota failure we retry once with chat transcripts trimmed. Transcripts
 * are the only unbounded part of the workspace, they are the least costly
 * thing to lose, and on a phone they are usually what filled the quota. The
 * in-memory workspace is never modified — only what we store is reduced — so
 * the running session keeps its full history.
 */
export function persist(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.workspace));
    return { ok: true };
  } catch (err) {
    if (!isQuotaError(err)) {
      console.warn('Persist failed:', err.message);
      return { ok: false, error: err.message };
    }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(trimForStorage(state.workspace)));
      console.warn('Storage full — saved with chat transcripts trimmed.');
      return { ok: true, degraded: 'conversations-trimmed' };
    } catch (err2) {
      console.warn('Persist failed even after trimming:', err2.message);
      return { ok: false, error: 'Storage is full. Download a ZIP to avoid losing work.' };
    }
  }
}

function isQuotaError(err) {
  return err?.name === 'QuotaExceededError'
    || err?.name === 'NS_ERROR_DOM_QUOTA_REACHED'
    || err?.code === 22
    || err?.code === 1014;
}

const KEEP_MESSAGES_PER_THREAD = 12;

function trimForStorage(ws) {
  return {
    ...ws,
    conversations: (ws.conversations || []).map(t => ({
      ...t,
      messages: (t.messages || []).slice(-KEEP_MESSAGES_PER_THREAD)
    }))
  };
}

/**
 * Read the workspace back.
 *
 * A stored workspace whose schemaVersion doesn't match used to be discarded
 * outright, which meant bumping SCHEMA_VERSION destroyed every participant's
 * in-progress work on their next reload. The file-load path already migrated;
 * this one now does the same.
 */
export function restore(state) {
  let raw;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch (err) {
    console.warn('Restore failed (storage unavailable):', err.message);
    return false;
  }
  if (!raw) return false;

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn('Restore failed (corrupt JSON):', err.message);
    return false;
  }

  let ws = parsed;
  if (parsed.schemaVersion !== SCHEMA_VERSION) {
    try {
      const { workspace: migrated, warnings } = migrateV1ToV2(parsed);
      ws = migrated;
      if (warnings?.length) {
        console.info(`Migrated stored workspace ${parsed.schemaVersion} → ${SCHEMA_VERSION} (${warnings.length} warnings)`, warnings);
      }
    } catch (err) {
      console.warn(`Could not migrate stored workspace from ${parsed.schemaVersion}:`, err.message);
      return false;
    }
  }

  const validation = validateWorkspace(ws);
  if (!validation.ok) {
    console.warn('Stored workspace failed validation, starting fresh:', validation.errors);
    return false;
  }

  state.workspace = ws;
  notify(state, { type: 'restore' });
  return true;
}

export function clearPersisted() {
  try { localStorage.removeItem(STORAGE_KEY); } catch {}
}

/**
 * Persist on every change. `onError` is called with a human-readable message
 * when a write fails or degrades, so the UI can say so rather than pretending
 * the work is safe.
 */
export function autoPersist(state, onError = null) {
  let lastReported = null;
  subscribe(state, () => {
    const result = persist(state);
    if (result.ok && !result.degraded) {
      lastReported = null;
      return;
    }
    const message = result.ok
      ? 'Storage nearly full — older chat messages are no longer being saved. Download a ZIP.'
      : result.error;
    // Don't spam: the same failure fires on every keystroke otherwise.
    if (message !== lastReported) {
      lastReported = message;
      onError?.(message, result);
    }
  });
}

// ============================================================================
// PARTICIPANT IDENTITY
//
// Scoped per project so that opening a different project doesn't silently
// reuse the name from the last one. Deliberately NOT part of the workspace
// JSON: identity belongs to this browser, not to the artefact, and exporting
// a workspace should not carry somebody's name into someone else's copy.
// ============================================================================

export function saveIdentity(projectId, { authorName, authorKey }) {
  if (!projectId || !authorName) return;
  try {
    localStorage.setItem(
      IDENTITY_KEY_PREFIX + projectId,
      JSON.stringify({ authorName, authorKey, savedAt: new Date().toISOString() })
    );
  } catch (err) {
    console.warn('Could not remember participant name:', err.message);
  }
}

export function loadIdentity(projectId) {
  if (!projectId) return null;
  try {
    const raw = localStorage.getItem(IDENTITY_KEY_PREFIX + projectId);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.authorName) return null;
    return { authorName: parsed.authorName, authorKey: parsed.authorKey };
  } catch {
    return null;
  }
}

export function clearIdentity(projectId) {
  if (!projectId) return;
  try { localStorage.removeItem(IDENTITY_KEY_PREFIX + projectId); } catch {}
}
