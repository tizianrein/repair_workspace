/**
 * POST /api/synthesize-target-json
 *
 * Ist-JSON (current state from describe-photo) + Workspace (the repair plan)
 * → Soll-JSON (target state for image generation).
 *
 * Body:
 *   {
 *     ist: <structured description from describe-photo>,
 *     workspace: <current workspace state>
 *   }
 *
 * Returns:
 *   { soll: <structured description of TARGET state>, rationale: string }
 *
 * The Soll-JSON has the SAME SHAPE as the Ist-JSON. Fields that should
 * stay the same (background, lighting, angle, untouched parts) are copied
 * verbatim. Fields that change according to the repair plan are modified
 * in place. Some parts may be marked present:false (e.g. removed backrest).
 *
 * The user reviews and optionally edits this Soll-JSON before it's sent
 * to the image generator.
 */

import { callGemini } from './_shared/gemini.js';

export const config = { maxDuration: 45 };

const SYSTEM_PROMPT = `You are a repair planner translating a structured description of an artefact's CURRENT state into a structured description of its TARGET state after a repair plan is executed.

You will be given:
  - "ist": a JSON description of what the artefact looks like NOW (from a photo)
  - "workspace": the repair workspace including intent, conditions, plan steps, mutex choices

Your job is to produce a "soll" JSON with the SAME SHAPE as the ist, but with fields modified to reflect what the artefact will look like AFTER the repair plan is completed.

Rules for producing the soll:

1. COPY UNCHANGED FIELDS VERBATIM
   - "scene" object (background, lighting, angle, framing, style) is ALWAYS copied unchanged from ist to soll. The same photo perspective must remain.
   - "subject.material" stays the same unless the plan explicitly changes the finish.
   - Parts that are not touched by any step keep their condition string identical.

2. MODIFY PARTS PER PLAN
   - A part removed by a plan step gets "present": false. Add a brief "removed_note" explaining how the cut/joint looks.
   - A part repaired by a step has its "condition" updated to reflect the new state (e.g. "lightly sanded, finished with linseed oil and beeswax — visible patina preserved on damage").
   - Damage that the intent says to PRESERVE (e.g. low Material Authenticity + high Aesthetic Intervention + plan's expectedOutcome mentions "patina") should remain in the condition string with a note: "preserved as visible patina".
   - Damage that the plan eliminates should be removed from the condition string.

3. MODIFY SUBJECT.TYPE IF FUNCTION CHANGES
   - If the chosen plan converts the artefact (e.g. chair → side-table via a mutex group), update subject.type accordingly. The image must show the NEW function.
   - Update overall_condition to a 1-2 sentence summary of the new state.

4. MUTEX BRANCHES
   - If a plan has mutex groups, ONLY apply the selected branch. If no branch is selected, use the first step in the group (and mention this in the rationale).

5. CONSERVATIVE BIAS
   - When uncertain, prefer keeping things the same. Do not invent details. Do not invent new parts that aren't in the ist.

OUTPUT FORMAT — STRICT JSON:

{
  "soll": {
    "subject": {
      "type": "...",
      "material": "...",
      "overall_condition": "...",
      "parts": [
        { "id": "...", "name": "...", "present": true|false, "geometry": "...", "condition": "...", "removed_note": "..." }
      ]
    },
    "scene": { ... copied unchanged from ist ... }
  },
  "rationale": "2-4 sentences explaining the key transformations and what was preserved/changed and why, referring to specific plan steps and intent axes."
}

Do not include any text outside the JSON.`;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { ist, workspace } = req.body || {};
    if (!ist?.subject || !ist?.scene) {
      return res.status(400).json({ error: 'ist must include subject and scene' });
    }
    if (!workspace) {
      return res.status(400).json({ error: 'workspace is required' });
    }

    // Pick out the current plan with mutex selections resolved
    const plan = (workspace.plans || []).find(p => p.id === workspace.currentPlanId) || null;
    const planSummary = plan ? {
      label: plan.label,
      steps: (plan.steps || []).map(s => ({
        id: s.id, title: s.title,
        description: s.description,
        expectedOutcome: s.expectedOutcome,
        affectedPartRefs: s.affectedPartRefs,
        addressesHypothesisRefs: s.addressesHypothesisRefs,
        status: s.status
      })),
      mutexGroups: (plan.mutexGroups || []).map(g => ({
        label: g.label,
        stepIds: g.stepIds,
        selectedStepId: g.selectedStepId
      }))
    } : null;

    const userPayload = {
      ist,
      workspace: {
        instanceName: workspace.instance?.name,
        intent: workspace.intent,
        conditions: workspace.hypotheses || [],
        plan: planSummary,
        constraints: workspace.constraints
      }
    };

    const result = await callGemini({
      systemPrompt: SYSTEM_PROMPT,
      userPayload,
      model: 'gemini-2.5-flash',
      temperature: 0.3,
      maxOutputTokens: 8192
    });

    if (!result?.soll?.subject || !result?.soll?.scene) {
      return res.status(502).json({ error: 'Model returned malformed Soll-JSON', raw: result });
    }

    return res.status(200).json({
      soll: result.soll,
      rationale: result.rationale || ''
    });
  } catch (err) {
    console.error('[synthesize-target-json] error:', err);
    return res.status(500).json({ error: err.message });
  }
}
