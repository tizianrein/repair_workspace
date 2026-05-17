/**
 * POST /api/enrich-plan
 *
 * Phase B of plan generation. Takes an already-generated plan skeleton
 * (steps with id/title/description/affectedPartRefs/addressesConditionRefs)
 * and fills in the operational + reflective fields:
 *   - toolsRequired, materialsRequired, estimatedMinutes
 *   - expectedOutcome, safetyNotes
 *   - justification with rationale and driving axes/conditions
 *   - confidence
 *
 * Uses gemini-2.5-flash because this is straightforward field-filling
 * rather than novel structural reasoning. Output volume is moderate
 * (~200-400 tokens per step × N steps).
 *
 * Body:
 *   {
 *     workspace: <full workspace state>,
 *     plan: <the plan skeleton from generate-plan>
 *   }
 *
 * Returns:
 *   {
 *     enrichments: [
 *       { id, toolsRequired, materialsRequired, estimatedMinutes,
 *         expectedOutcome, safetyNotes, justification, confidence }
 *     ]
 *   }
 *
 * The client merges these enrichments back into the corresponding steps
 * via upsert-step commands (one per enrichment, batched).
 */

import { callGemini } from './_shared/gemini.js';
import { loadPrompt } from './_shared/prompts.js';

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { workspace, plan } = req.body || {};
    if (!workspace) return res.status(400).json({ error: 'workspace is required' });
    if (!plan?.steps?.length) return res.status(400).json({ error: 'plan with steps is required' });

    const systemPrompt = loadPrompt('enrich-plan');

    const userPayload = {
      workspace: leanWorkspace(workspace),
      plan: {
        id: plan.id,
        label: plan.label,
        steps: plan.steps.map(s => ({
          id: s.id,
          title: s.title,
          description: s.description,
          affectedPartRefs: s.affectedPartRefs || [],
          addressesConditionRefs: s.addressesConditionRefs || []
        }))
      }
    };

    const result = await callGemini({
      systemPrompt,
      userPayload,
      model: 'gemini-2.5-flash',
      temperature: 0.3,
      maxOutputTokens: 32768
    });

    if (!result || typeof result !== 'object') {
      return res.status(502).json({ error: 'Model returned non-object', raw: result });
    }
    if (!Array.isArray(result.enrichments)) {
      return res.status(502).json({ error: 'Model returned no enrichments array', raw: result });
    }

    // Filter to only enrichments that reference an actual step id, and
    // sanitize each one so we know exactly what the client gets.
    const stepIds = new Set(plan.steps.map(s => s.id));
    const clean = [];
    for (const e of result.enrichments) {
      if (!e || !stepIds.has(e.id)) continue;
      clean.push({
        id: e.id,
        toolsRequired: Array.isArray(e.toolsRequired) ? e.toolsRequired : [],
        materialsRequired: Array.isArray(e.materialsRequired) ? e.materialsRequired : [],
        estimatedMinutes: Number.isFinite(e.estimatedMinutes) ? e.estimatedMinutes : null,
        expectedOutcome: typeof e.expectedOutcome === 'string' ? e.expectedOutcome : '',
        safetyNotes: typeof e.safetyNotes === 'string' ? e.safetyNotes : '',
        justification: {
          drivingIntentAxes: Array.isArray(e.justification?.drivingIntentAxes) ? e.justification.drivingIntentAxes : [],
          drivingConditions: Array.isArray(e.justification?.drivingConditions) ? e.justification.drivingConditions : [],
          drivingConstraints: Array.isArray(e.justification?.drivingConstraints) ? e.justification.drivingConstraints : [],
          rationale: typeof e.justification?.rationale === 'string' ? e.justification.rationale : ''
        },
        confidence: typeof e.confidence === 'number' ? Math.max(0, Math.min(1, e.confidence)) : 0.7
      });
    }

    return res.status(200).json({ enrichments: clean });
  } catch (err) {
    console.error('[enrich-plan] error:', err);
    return res.status(500).json({ error: err.message });
  }
}

function leanWorkspace(ws) {
  return {
    instanceName: ws.instance?.name,
    parts: (ws.instance?.parts || []).map(p => ({
      id: p.id, name: p.name, material: p.material
    })),
    conditions: (ws.conditions || []).map(h => ({
      id: h.id, type: h.type, partRef: h.partRef, status: h.status
    })),
    intent: ws.intent,
    constraints: ws.constraints
  };
}
