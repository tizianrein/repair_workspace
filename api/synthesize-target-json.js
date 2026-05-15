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

const SYSTEM_PROMPT = `You are translating a structured description of an artefact's CURRENT state into a structured description of its TARGET state after a repair plan has been executed.

You will be given:
  - "ist": a JSON description of what the artefact looks like NOW (from a photo)
  - "workspace": the repair workspace including intent, conditions, plan steps, mutex choices

Your job is to produce a "soll" JSON with the SAME SHAPE as the ist, but with fields modified to reflect the target state described by the workspace.

CORE PRINCIPLE — TRANSLATE, DO NOT INTERPRET

The workspace specifies what the repair should do. The intent specifies the values that shape those choices. Your job is to FAITHFULLY translate this specification into the soll JSON. You do NOT pick a repair philosophy.

A workspace can call for any outcome the user wants — from invisible restoration to deliberate transformation to creative reinterpretation. Read what the workspace actually says and translate THAT. Do not default to any approach. Do not assume what "a good repair" looks like.

For each part touched by a step, the new condition string should describe what that step's expectedOutcome implies for that part's visual appearance — using the step's own words and the intent's framing.

Rules for producing the soll:

1. COPY UNCHANGED FIELDS VERBATIM
   - "scene" (background, lighting, angle, framing, style): ALWAYS unchanged.
   - Parts not touched by any step: condition string unchanged.

2. MODIFY PARTS PER PLAN STEP
   - Find the plan step(s) that address this part (via affectedPartRefs or addressesHypothesisRefs).
   - Read the step's title, description, and expectedOutcome.
   - Translate that into a new condition string describing how this part LOOKS after the step is complete. Use concrete visual language (texture, color, surface state) — not procedural language.
   - If the step removes the part: present: false, removed_note describes the cut/joint based on the step's expectedOutcome.

3. PART NOT TOUCHED BUT WORKSPACE SAYS SOMETHING ABOUT IT
   - If the intent.summary or a step.expectedOutcome explicitly mentions a part that has no dedicated step (e.g. "preserve the original patina across all legs"), apply that intent to the part's condition.
   - Otherwise, leave the part's condition unchanged.

4. SUBJECT-LEVEL CHANGES
   - subject.type: if the plan converts the artefact's function (e.g. via a selected mutex branch like "convert to side-table"), update the type.
   - subject.material: if the plan applies a new finish or material treatment, update to reflect it. Otherwise unchanged.
   - subject.overall_condition: a 1-2 sentence summary describing the artefact's COMPLETED state — in the voice that the intent suggests (e.g. a conservation-focused intent → conservator's voice; an adaptive-reuse intent → designer's voice; a sustainability-focused intent → sustainability advocate's voice).

5. MUTEX BRANCHES
   - Apply ONLY the selected branch. If no selection, use the first step in the group and mention in rationale.

6. DO NOT INVENT
   - Don't add parts not in the ist.
   - Don't change parts the workspace doesn't address.
   - Don't supply repair philosophies the workspace doesn't specify.

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
  "rationale": "2-4 sentences explaining what you translated and from where (which steps, which intent axes, which mutex selections drove the changes). Quote the workspace's own language where helpful."
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
