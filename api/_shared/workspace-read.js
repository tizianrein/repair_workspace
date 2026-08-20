/**
 * Canonical readers for plan-scoped workspace fields.
 *
 * Schema v2.1 moved `intent` and `constraints` off the workspace root and
 * onto each plan (strategy), so that two strategies on the same artefact can
 * pursue different goals under different limits. See src/core/schema.js.
 *
 * Four endpoints kept reading `ws.intent` / `ws.constraints` after that move
 * and silently received `undefined` on every real v2.1 workspace — which
 * meant the planner ran with its primary directive empty. Every endpoint that
 * needs these values must go through here.
 *
 * The root fallback exists for two cases: pre-2.1 payloads that still carry
 * root-level values, and clients that pre-slim the workspace and hoist the
 * current plan's intent to the root (src/ai/ai-payload.js does exactly that).
 * Prefer the plan; fall back to the root; never return undefined.
 */

export function getCurrentPlan(ws) {
  if (!ws) return null;
  const plans = ws.plans || [];
  return plans.find(p => p.id === ws.currentPlanId) || plans[0] || null;
}

export function getIntent(ws) {
  const fromPlan = getCurrentPlan(ws)?.intent;
  if (fromPlan) return fromPlan;
  if (ws?.intent) return ws.intent;
  return { axes: [], summary: '' };
}

export function getConstraints(ws) {
  const fromPlan = getCurrentPlan(ws)?.constraints;
  if (fromPlan) return fromPlan;
  if (ws?.constraints) return ws.constraints;
  return {};
}

/**
 * True when the intent carries no actual commitment — no axes, or every axis
 * still sitting at the 0.5 default with an empty summary.
 *
 * A plan generated from a neutral intent has nothing to justify its steps
 * against, so its justifications are decoration. Endpoints use this to tell
 * the model to elicit priorities rather than invent them.
 */
export function isIntentNeutral(intent) {
  const axes = intent?.axes || [];
  if (!axes.length) return true;
  const summary = String(intent?.summary || '').trim();
  if (summary) return false;
  return axes.every(a => Math.abs(Number(a?.value ?? 0.5) - 0.5) < 0.02);
}
