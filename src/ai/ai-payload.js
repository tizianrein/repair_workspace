/**
 * ai-payload.js — minimize what gets sent to the AI.
 *
 * The full workspace JSON is large (parts, plans, evidence, full conversation
 * history) and most of it isn't relevant to a given call. This module returns
 * a slimmed-down view tailored to the call's scope or purpose.
 *
 * Two top-level helpers:
 *   - payloadForPropose({ workspace, scope }) → for /api/propose
 *   - payloadForChat({ workspace, thread, maxMessages }) → for /api/chat
 *
 * Both strip image data from evidence (we send only metadata; the AI gets
 * the image via the message attachments parameter instead) and avoid
 * including conversations from threads other than the active one.
 */

const SCOPE_NEEDS = {
  // Each scope: which workspace slices the AI needs to reason.
  assembly:      { parts: true, conditions: true,  intent: true, constraints: true, plans: false, executionLog: false },
  conditions:    { parts: true, conditions: true,  intent: true, constraints: true, plans: false, executionLog: false },
  interventions: { parts: true, conditions: true,  intent: true, constraints: true, plans: 'current', executionLog: true },
  all:           { parts: true, conditions: true,  intent: true, constraints: true, plans: 'current', executionLog: true }
};

export function payloadForPropose({ workspace, scope = 'all' }) {
  const needs = SCOPE_NEEDS[scope] || SCOPE_NEEDS.all;
  return slim(workspace, needs);
}

export function payloadForChat({ workspace, scope = 'all', ref = null, maxMessages = 8 }) {
  // Chat always needs the broadest context except old plan versions
  const needs = { parts: true, conditions: true, intent: true, constraints: true, plans: 'current', executionLog: true };
  const payload = slim(workspace, needs);
  // Truncate conversations to last N messages of the active thread.
  // For scoped-by-ref threads (part/hyp/step/plan), we must filter on
  // *both* scope and ref so we don't leak history from a sibling thread
  // (e.g. plan thread A spilling into plan thread B). Global stays as
  // a cross-cutting thread the user can step into separately.
  if (payload.conversations) {
    payload.conversations = payload.conversations
      .filter(t => {
        if (t.scope === 'global') return true;
        if (t.scope !== scope) return false;
        // Same scope — also require matching ref. null ref matches null ref.
        return (t.ref ?? null) === (ref ?? null);
      })
      .map(t => ({
        ...t,
        // Drop large per-message photo payloads (base64 data URLs) from
        // history. The current turn's photos travel via the separate
        // `files` field on the request, and including base64 images from
        // every prior turn would bloat the payload quickly (each photo
        // is hundreds of KB). We keep just a small marker so the model
        // knows photos were present in prior turns if it cares.
        messages: (t.messages || []).slice(-maxMessages).map(m => {
          if (Array.isArray(m.photos) && m.photos.length) {
            const { photos, ...rest } = m;
            return { ...rest, hadPhotos: photos.length };
          }
          return m;
        })
      }));
  }
  return payload;
}

function slim(ws, needs) {
  const out = {
    schemaVersion: ws.schemaVersion
  };
  if (ws.instance) {
    out.instance = {
      id: ws.instance.id,
      name: ws.instance.name,
      provenance: ws.instance.provenance || null,
      notes: ws.instance.notes || '',
      parts: needs.parts ? ws.instance.parts : []
    };
  }
  if (needs.conditions) out.conditions = ws.conditions || [];

  // In v2.1 intent + constraints are owned by the current plan
  // (strategy). When the caller asks for them we look them up there.
  // This keeps the AI request size the same as before — these fields
  // come from one plan, not from every plan.
  const cur = (ws.plans || []).find(p => p.id === ws.currentPlanId) || null;
  if (needs.intent)     out.intent = cur?.intent || null;
  if (needs.constraints) out.constraints = cur?.constraints || null;

  if (needs.plans === true) {
    out.plans = ws.plans || [];
  } else if (needs.plans === 'current') {
    out.plans = cur ? [cur] : [];
    out.currentPlanId = ws.currentPlanId;
  }

  if (needs.executionLog) out.executionLog = ws.executionLog || [];

  // Evidence: strip raw image data; keep only metadata. The base64 image
  // payload travels separately via the `files` field on the request.
  out.evidence = (ws.evidence || []).map(e => ({
    id: e.id,
    kind: e.kind,
    attachedTo: e.attachedTo,
    capturedAt: e.capturedAt,
    text: e.text || null,
    measurement: e.measurement || null,
    confirmsConditionRef: e.confirmsConditionRef || null,
    refutesConditionRef: e.refutesConditionRef || null,
    hasImage: !!e.url
  }));

  // Conversations: filtered by caller
  out.conversations = ws.conversations || [];

  return out;
}
