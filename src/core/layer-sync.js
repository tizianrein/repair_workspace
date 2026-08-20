/**
 * Participant layer sync.
 *
 * A layer is one participant's whole workspace inside a project: their parts
 * model, conditions, strategies, evidence records, conversations and execution
 * log. Everything except the artefact seed the project was created from.
 *
 * What this module is for, beyond moving JSON:
 *
 *   1. Strategies survive the device. Previously only conditions reached the
 *      server, so a participant's strategies — the actual output of the whole
 *      exercise — existed in exactly one browser.
 *   2. A failed save is visible. The old sync reported failure as one line of
 *      status text and then went quiet, so "saved" and "silently not saved"
 *      looked identical.
 *   3. Concurrent writes fail loudly. Every write carries the revision it was
 *      based on; the server rejects a stale one with 409 instead of letting the
 *      second tab quietly erase the first.
 *   4. Nothing is lost on the way out. Browsers do not wait for a debounce, so
 *      a pending save is flushed on tab hide and on unload.
 */

const DEBOUNCE_MS = 2000;          // the old 450ms wrote far more often than a workshop needs
const MAX_ATTEMPTS = 4;
const BACKOFF_MS = [1000, 4000, 12000];

export const SYNC_STATE = {
  IDLE: 'idle',
  PENDING: 'pending',
  SAVING: 'saving',
  OFFLINE: 'offline',
  CONFLICT: 'conflict',
};

/**
 * Everything of the participant's that belongs on the server.
 *
 * The parts model is included: participants may adapt the artefact to what they
 * actually observe, and those edits stay in their own layer rather than
 * reaching under everyone else's conditions and step references.
 *
 * Deliberately excluded: `collaboration` (project identity, not layer content)
 * and anything prefixed `_` (transient client stashes).
 */
export function layerSnapshot(workspace, { authorName = null, authorKey = null } = {}) {
  return {
    layerVersion: 1,
    schemaVersion: workspace.schemaVersion,
    authorName,
    authorKey,
    instance: workspace.instance || null,
    conditions: (workspace.conditions || []).map(c => ({
      ...c,
      authorName: c.authorName || authorName,
      authorKey: c.authorKey || authorKey,
    })),
    plans: workspace.plans || [],
    currentPlanId: workspace.currentPlanId || null,
    evidence: workspace.evidence || [],
    conversations: workspace.conversations || [],
    executionLog: workspace.executionLog || [],
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Fold a fetched layer back into a workspace.
 *
 * The project's seed artefact is the fallback: a participant who has never
 * saved has no `instance` of their own and should start from the shared one.
 */
export function applyLayer(workspace, layer) {
  if (!layer) return workspace;
  return {
    ...workspace,
    instance: layer.instance || workspace.instance,
    conditions: layer.conditions || [],
    plans: layer.plans?.length ? layer.plans : workspace.plans,
    currentPlanId: layer.currentPlanId
      || (layer.plans?.length ? layer.plans[0].id : workspace.currentPlanId),
    evidence: layer.evidence || [],
    conversations: layer.conversations || workspace.conversations || [],
    executionLog: layer.executionLog || [],
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Create the sync controller.
 *
 * `getContext()` returns { projectId, authorName, authorKey, readOnly } — read
 * fresh on every save so switching participant mid-session does the right
 * thing. `onState(state, detail)` drives the UI indicator.
 */
export function createLayerSync({ api, getWorkspace, getContext, onState, log = () => {} }) {
  let timer = null;
  let inFlight = null;
  let dirty = false;
  let rev = 0;
  let attempt = 0;
  let suspended = false;
  let lastError = null;

  function setState(state, detail = null) {
    lastError = state === SYNC_STATE.IDLE ? null : detail;
    onState?.(state, detail);
  }

  function ready() {
    const ctx = getContext();
    return !!(ctx?.projectId && ctx?.authorName && !ctx.readOnly && !suspended);
  }

  /** Note the server revision after a read, so the first write isn't a blind overwrite. */
  function setRevision(next) {
    rev = Number(next || 0);
  }

  function getRevision() { return rev; }

  /** Suspend during bulk replacements (loading a layer) so we don't echo it back. */
  function suspend() { suspended = true; }
  function resume() { suspended = false; }

  function queue() {
    if (!ready()) return;
    dirty = true;
    setState(SYNC_STATE.PENDING);
    clearTimeout(timer);
    timer = setTimeout(() => { flush().catch(() => {}); }, DEBOUNCE_MS);
  }

  /**
   * `overwrite: true` is the deliberate resolution of a conflict — the write
   * goes up with no baseRev at all, which the Worker reads as "replace whatever
   * is there". It is never triggered by an edit or a timer; only by someone
   * choosing it, because picking a winner automatically is how the previous
   * sync destroyed work.
   */
  async function flush({ force = false, overwrite = false } = {}) {
    clearTimeout(timer);
    if (!ready()) return { ok: false, reason: 'not-ready' };
    if (!dirty && !force && !overwrite) return { ok: true, reason: 'clean' };
    if (inFlight) return inFlight;

    inFlight = (async () => {
      const ctx = getContext();
      dirty = false;
      setState(SYNC_STATE.SAVING);
      const payload = layerSnapshot(getWorkspace(), ctx);

      try {
        const result = await api.putLayer(ctx.projectId, ctx.authorKey, {
          authorName: ctx.authorName,
          layer: payload,
          // Omitted, not null. The Worker reads a missing baseRev as a
          // knowing replacement, but `Number(null)` is 0 — so sending null
          // would assert "this layer does not exist yet" and conflict against
          // any layer that does.
          baseRev: overwrite ? undefined : rev,
        });
        rev = Number(result.rev || rev + 1);
        attempt = 0;
        setState(SYNC_STATE.IDLE, result);
        return { ok: true, rev };
      } catch (error) {
        if (error?.status === 409) {
          // Someone else wrote this layer — another tab, or the same person on
          // another device. We do not resolve it silently in either direction:
          // picking a winner automatically is how the old sync destroyed work.
          //
          // The work stays dirty and stays local. Recovery is deliberate:
          // either reload to take the other version, or choose to overwrite,
          // which is what overwriteRemote() does. Retrying the same write is
          // not recovery — baseRev is still stale, so it would conflict again,
          // and again, for the rest of the session.
          dirty = true;
          setState(SYNC_STATE.CONFLICT, error);
          log('This layer was changed elsewhere. Reload to pick up the other version, or choose to overwrite it with what is on this screen.');
          return { ok: false, conflict: true };
        }

        dirty = true;
        attempt += 1;
        if (attempt < MAX_ATTEMPTS) {
          const wait = BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)];
          setState(SYNC_STATE.OFFLINE, error);
          clearTimeout(timer);
          timer = setTimeout(() => { flush().catch(() => {}); }, wait);
        } else {
          setState(SYNC_STATE.OFFLINE, error);
        }
        return { ok: false, error };
      } finally {
        inFlight = null;
      }
    })();

    return inFlight;
  }

  /**
   * Flush on the way out.
   *
   * `visibilitychange` is the reliable one — mobile browsers often never fire
   * `beforeunload` at all, and a phone being pocketed mid-survey is exactly
   * when an unsaved debounce would be lost.
   */
  function attachLifecycle(target = globalThis) {
    const onHide = () => { if (dirty) flush().catch(() => {}); };
    target.addEventListener?.('visibilitychange', () => {
      if (globalThis.document?.visibilityState === 'hidden') onHide();
    });
    target.addEventListener?.('pagehide', onHide);
    target.addEventListener?.('beforeunload', onHide);
    target.addEventListener?.('online', () => { if (dirty) flush().catch(() => {}); });
  }

  return {
    queue,
    flush,
    /** Resolve a conflict by replacing the server's version with this one. */
    overwriteRemote: () => flush({ force: true, overwrite: true }),
    suspend,
    resume,
    setRevision,
    getRevision,
    attachLifecycle,
    isDirty: () => dirty,
    lastError: () => lastError,
  };
}
