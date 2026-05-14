/**
 * State container.
 *
 * Owns the single workspace object, the undo/redo history, and the list of
 * listener functions that views subscribe with. Persists to localStorage on
 * every change so participants don't lose work if they refresh.
 */

import { newWorkspace, validateWorkspace, SCHEMA_VERSION } from './schema.js';

const STORAGE_KEY = 'repair-workspace-v2';

export function createState() {
  return {
    workspace: newWorkspace(),
    history: [],
    future: [],
    listeners: new Set()
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

export function persist(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.workspace));
    return true;
  } catch (err) {
    console.warn('Persist failed:', err.message);
    return false;
  }
}

export function restore(state) {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    if (parsed.schemaVersion !== SCHEMA_VERSION) {
      console.info(`Stored workspace is schema ${parsed.schemaVersion}, current is ${SCHEMA_VERSION}. Starting fresh.`);
      return false;
    }
    state.workspace = parsed;
    notify(state, { type: 'restore' });
    return true;
  } catch (err) {
    console.warn('Restore failed:', err.message);
    return false;
  }
}

export function clearPersisted() {
  localStorage.removeItem(STORAGE_KEY);
}

export function autoPersist(state) {
  subscribe(state, () => persist(state));
}
