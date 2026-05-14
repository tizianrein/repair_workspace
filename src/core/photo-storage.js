/**
 * photo-storage.js — IndexedDB persistence for photo blobs.
 *
 * Why IndexedDB: localStorage caps at ~5MB and serializes as JSON strings
 * — base64 photos are huge. IndexedDB stores Blobs natively, has hundreds
 * of MB of capacity (or more), and is async (no UI freezes).
 *
 * Each photo has a stable ID assigned by the caller (typically an evidence
 * ID like "ev_abc123"). The blob is stored under that ID.
 *
 * Public API:
 *   await PhotoStorage.init()
 *   await PhotoStorage.put(id, blob, name?)
 *   await PhotoStorage.get(id)                  → { id, name, mime, blob } | null
 *   await PhotoStorage.delete(id)
 *   await PhotoStorage.listIds()                → [id, ...]
 *   await PhotoStorage.getAll()                 → [{ id, name, mime, blob }, ...]
 *   await PhotoStorage.clear()
 *   await PhotoStorage.estimate()               → { usage, quota } bytes
 */

const DB_NAME = 'repair-workspace';
const DB_VERSION = 1;
const PHOTO_STORE = 'photos';

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(PHOTO_STORE)) {
        db.createObjectStore(PHOTO_STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function txStore(mode = 'readonly') {
  return openDb().then(db => db.transaction(PHOTO_STORE, mode).objectStore(PHOTO_STORE));
}

function req2promise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function put(id, blob, name) {
  const store = await txStore('readwrite');
  await req2promise(store.put({
    id,
    name: name || id,
    mime: blob.type || 'image/jpeg',
    blob,
    createdAt: new Date().toISOString()
  }));
}

async function get(id) {
  const store = await txStore('readonly');
  return req2promise(store.get(id));
}

async function del(id) {
  const store = await txStore('readwrite');
  await req2promise(store.delete(id));
}

async function listIds() {
  const store = await txStore('readonly');
  const keys = await req2promise(store.getAllKeys());
  return keys || [];
}

async function getAll() {
  const store = await txStore('readonly');
  const all = await req2promise(store.getAll());
  return all || [];
}

async function clear() {
  const store = await txStore('readwrite');
  await req2promise(store.clear());
}

async function estimate() {
  if (navigator.storage && navigator.storage.estimate) {
    return navigator.storage.estimate();
  }
  return { usage: 0, quota: 0 };
}

async function init() {
  await openDb();
  if (navigator.storage && navigator.storage.persist) {
    try {
      const persisted = await navigator.storage.persisted();
      if (!persisted) await navigator.storage.persist();
    } catch (e) { /* non-fatal */ }
  }
}

export const PhotoStorage = {
  init, put, get, delete: del, listIds, getAll, clear, estimate
};
