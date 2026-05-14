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
  assembly:      { parts: true, hypotheses: true,  intent: true, constraints: true, plans: false, executionLog: false },
  hypotheses:    { parts: true, hypotheses: true,  intent: true, constraints: true, plans: false, executionLog: false },
  interventions: { parts: true, hypotheses: true,  intent: true, constraints: true, plans: 'current', executionLog: true },
  all:           { parts: true, hypotheses: true,  intent: true, constraints: true, plans: 'current', executionLog: true }
};

export function payloadForPropose({ workspace, scope = 'all' }) {
  const needs = SCOPE_NEEDS[scope] || SCOPE_NEEDS.all;
  return slim(workspace, needs);
}

export function payloadForChat({ workspace, scope = 'all', maxMessages = 8 }) {
  // Chat always needs the broadest context except old plan versions
  const needs = { parts: true, hypotheses: true, intent: true, constraints: true, plans: 'current', executionLog: true };
  const payload = slim(workspace, needs);
  // Truncate conversations to last N messages of the active thread, drop others
  if (payload.conversations) {
    payload.conversations = payload.conversations
      .filter(t => t.scope === scope || t.scope === 'global')
      .map(t => ({
        ...t,
        messages: (t.messages || []).slice(-maxMessages)
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
  if (needs.hypotheses) out.hypotheses = ws.hypotheses || [];
  if (needs.intent)     out.intent = ws.intent || null;
  if (needs.constraints) out.constraints = ws.constraints || null;

  if (needs.plans === true) {
    out.plans = ws.plans || [];
  } else if (needs.plans === 'current') {
    const cur = (ws.plans || []).find(p => p.id === ws.currentPlanId);
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
    confirmsHypothesisRef: e.confirmsHypothesisRef || null,
    refutesHypothesisRef: e.refutesHypothesisRef || null,
    hasImage: !!e.url
  }));

  // Conversations: filtered by caller
  out.conversations = ws.conversations || [];

  return out;
}
