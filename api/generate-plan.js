/**
 * POST /api/generate-plan
 *
 * Dedicated endpoint for generating or regenerating a repair plan.
 *
 * Why a dedicated endpoint instead of using /api/propose?
 *   1. Plans need a much more specific prompt with graph-construction rules
 *      that would clutter the generic propose prompt for all other operations.
 *   2. Plans benefit from a stronger reasoning model. We use gemini-2.5-pro
 *      here, while /api/propose runs the faster gemini-2.5-flash for typical
 *      single-purpose operations (add condition, update intent, etc.).
 *   3. Plans have much higher token budgets — a real plan can have 10-25
 *      steps, each with detailed descriptions and justifications.
 *
 * Body:
 *   {
 *     userMessage: "Generate a plan that prioritizes reversibility" (free text),
 *     workspace: <full workspace state>,
 *     files?: [{ name, mimeType, data }]   // optional reference photos
 *   }
 *
 * Returns the same shape as /api/propose so the client can route the
 * response into the same review-modal pipeline:
 *   {
 *     summary: string,
 *     commands: [{ type: 'add-plan', payload: { plan: {...} } }],
 *     uncertainty: []
 *   }
 *
 * The model always returns exactly one add-plan command. We do not split
 * plan generation into add-plan + upsert-step + add-edge follow-ups —
 * that pattern is brittle and was the cause of repeated regressions.
 */

import { callGemini } from './_shared/gemini.js';
import { loadPrompt } from './_shared/prompts.js';

export const config = { maxDuration: 90 };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { userMessage, workspace, files } = req.body || {};
    if (!userMessage) return res.status(400).json({ error: 'userMessage is required' });
    if (!workspace) return res.status(400).json({ error: 'workspace is required' });
    if (!workspace.instance?.parts?.length) {
      return res.status(400).json({ error: 'Workspace has no parts. Load an artefact assembly first.' });
    }

    const systemPrompt = loadPrompt('generate-plan');

    // The model needs rich context — pass the workspace with full detail on
    // parts, conditions, intent, constraints, and any existing plan being
    // revised. We keep evidence (photos as base64) out of the payload since
    // those go through `files` separately.
    const userPayload = {
      userMessage,
      workspace: enrichedWorkspace(workspace)
    };

    const result = await callGemini({
      systemPrompt,
      userPayload,
      files: files || [],
      model: 'gemini-2.5-pro',
      temperature: 0.4,
      maxOutputTokens: 32768
    });

    if (!result || typeof result !== 'object') {
      return res.status(502).json({ error: 'Model returned non-object', raw: result });
    }
    if (!Array.isArray(result.commands) || result.commands.length === 0) {
      return res.status(502).json({ error: 'Model returned no commands', raw: result });
    }

    // Validate: we expect exactly one add-plan command with an inline plan
    const planCmd = result.commands.find(c => c.type === 'add-plan');
    if (!planCmd) {
      return res.status(502).json({
        error: 'Model did not return an add-plan command',
        raw: result
      });
    }
    if (!planCmd.payload?.plan?.steps?.length) {
      return res.status(502).json({
        error: 'add-plan has no steps',
        raw: result
      });
    }

    // Sanity-check edges and mutex groups reference real steps; drop bad
    // ones rather than failing the whole batch (same philosophy as propose).
    const plan = planCmd.payload.plan;
    const stepIds = new Set(plan.steps.map(s => s.id));
    const droppedEdges = [];
    const droppedMutex = [];

    if (Array.isArray(plan.edges)) {
      const goodEdges = [];
      for (const e of plan.edges) {
        if (!e.source || !e.target || !stepIds.has(e.source) || !stepIds.has(e.target)) {
          droppedEdges.push(`${e.source} → ${e.target}`);
          continue;
        }
        goodEdges.push(e);
      }
      plan.edges = goodEdges;
    } else {
      plan.edges = [];
    }

    if (Array.isArray(plan.mutexGroups)) {
      const goodGroups = [];
      for (const g of plan.mutexGroups) {
        if (!Array.isArray(g.stepIds) || g.stepIds.length < 2) {
          droppedMutex.push(g.label || g.id || '(unnamed)');
          continue;
        }
        const validIds = g.stepIds.filter(id => stepIds.has(id));
        if (validIds.length < 2) {
          droppedMutex.push(g.label || g.id || '(unnamed)');
          continue;
        }
        goodGroups.push({ ...g, stepIds: validIds });
      }
      plan.mutexGroups = goodGroups;
    } else {
      plan.mutexGroups = [];
    }

    let summary = result.summary || `Generated plan with ${plan.steps.length} steps.`;
    if (droppedEdges.length) {
      summary += ` (Dropped ${droppedEdges.length} invalid edge${droppedEdges.length === 1 ? '' : 's'}.)`;
      console.warn('[generate-plan] Dropped edges:', droppedEdges);
    }
    if (droppedMutex.length) {
      summary += ` (Dropped ${droppedMutex.length} invalid mutex group${droppedMutex.length === 1 ? '' : 's'}: ${droppedMutex.join(', ')}.)`;
      console.warn('[generate-plan] Dropped mutex groups:', droppedMutex);
    }

    return res.status(200).json({
      summary,
      commands: [planCmd],
      uncertainty: Array.isArray(result.uncertainty) ? result.uncertainty : []
    });
  } catch (err) {
    console.error('[generate-plan] error:', err);
    return res.status(500).json({ error: err.message });
  }
}

/**
 * Build the workspace payload for the planner.
 *
 * Unlike /api/propose's redactWorkspace which keeps step details lean, we
 * here give the planner FULL detail on conditions (the model needs to know
 * what to address), full intent (the model needs to translate intent into
 * step character), and full constraints. If there is an existing plan being
 * revised, include its full step details so the planner can see what was
 * there before.
 */
function enrichedWorkspace(ws) {
  const existingPlan = (ws.plans || []).find(p => p.id === ws.currentPlanId);

  return {
    instance: {
      id: ws.instance?.id,
      name: ws.instance?.name,
      provenance: ws.instance?.provenance,
      notes: ws.instance?.notes,
      parts: (ws.instance?.parts || []).map(p => ({
        id: p.id,
        name: p.name,
        material: p.material,
        function: p.function,
        status: p.status,
        provenance: p.provenance
      }))
    },
    conditions: (ws.hypotheses || []).map(h => ({
      id: h.id,
      type: h.type,
      description: h.description,
      partRef: h.partRef,
      status: h.status,
      confidence: h.confidence,
      severity: h.severity
    })),
    intent: ws.intent,
    constraints: ws.constraints,
    existingPlan: existingPlan ? {
      id: existingPlan.id,
      label: existingPlan.label,
      status: existingPlan.status,
      steps: (existingPlan.steps || []).map(s => ({
        id: s.id,
        title: s.title,
        description: s.description,
        expectedOutcome: s.expectedOutcome,
        status: s.status,
        affectedPartRefs: s.affectedPartRefs,
        addressesHypothesisRefs: s.addressesHypothesisRefs,
        toolsRequired: s.toolsRequired,
        materialsRequired: s.materialsRequired,
        estimatedMinutes: s.estimatedMinutes
      })),
      edges: (existingPlan.edges || []).map(e => ({ source: e.source, target: e.target })),
      mutexGroups: existingPlan.mutexGroups
    } : null
  };
}
