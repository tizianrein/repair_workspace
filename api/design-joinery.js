/**
 * POST /api/design-joinery
 *
 * Agentic Joinery Co-Designer, reasoning stage. Gemini reads the selected
 * member's scoped Workspace context and authors one `joinery-program@1`.
 * Grasshopper executes the program with the deterministic AnyJoint fitter.
 * Calling this endpoint again with `previousProgram` + `fitFeedback` performs
 * the critique/revision turn of the bounded agent loop.
 *
 * Body:
 *   {
 *     workspace: <full Workspace JSON>,
 *     beamId: "exact part id",
 *     stepId?: "repair step receiving the proposal",
 *     userMessage?: "additional construction instruction",
 *     files?: [{ name, mimeType, data }],
 *     references?: [{ id, title, page, text }],
 *     previousProgram?: <joinery-program@1>,
 *     fitFeedback?: <proposal/metrics returned by Grasshopper>
 *   }
 */

import { withRateLimit } from './_shared/rate-limit.js';
import { callGemini } from './_shared/gemini.js';
import { loadPrompt } from './_shared/prompts.js';

export const config = { maxDuration: 90 };

const PROGRAM_SCHEMA = 'joinery-program@1';
const TOPOLOGIES = new Set(['lap', 'scarf', 'lapped_bowtie']);

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const {
      workspace,
      beamId,
      stepId = null,
      userMessage = '',
      files = [],
      references = [],
      previousProgram = null,
      fitFeedback = null
    } = req.body || {};

    if (!workspace) return res.status(400).json({ error: 'workspace is required' });
    if (!beamId) return res.status(400).json({ error: 'beamId is required' });

    const context = buildJoineryContext(workspace, beamId, stepId);
    if (context.error) return res.status(400).json({ error: context.error });

    const result = await callGemini({
      systemPrompt: loadPrompt('design-joinery'),
      userPayload: {
        userMessage: userMessage || 'Design an actionable repair joinery proposal for this selected member.',
        selectedPart: context.selectedPart,
        connectedParts: context.connectedParts,
        conditions: context.conditions,
        strategy: context.strategy,
        evidence: context.evidence,
        references,
        previousProgram,
        fitFeedback
      },
      files,
      thinkingLevel: 'high',
      maxOutputTokens: 16384
    });

    if (!result || typeof result !== 'object' || !result.jointProgram) {
      return res.status(502).json({ error: 'Model returned no jointProgram', raw: result });
    }
    const checked = validateJointProgram(result.jointProgram, context, stepId);
    if (!checked.ok) {
      return res.status(502).json({
        error: `Invalid JointProgram: ${checked.errors.join('; ')}`,
        raw: result
      });
    }

    const program = checked.program;
    const proposal = {
      schema: 'joinery-proposal@1',
      id: program.id,
      targetPartRef: beamId,
      repairStepRef: stepId,
      status: 'agent_program_pending_fit',
      program,
      resolvedGeometry: null,
      fit: { status: 'pending_grasshopper_fit' },
      agent: {
        name: 'Agentic Joinery Co-Designer',
        stage: fitFeedback ? 'program_revised_after_fit' : 'program_authored',
        revision: fitFeedback ? 2 : 1
      }
    };

    const commands = [];
    if (stepId && context.planId) {
      commands.push({
        type: 'upsert-step',
        payload: {
          planId: context.planId,
          step: { id: stepId, joineryProposal: proposal }
        }
      });
    }

    return res.status(200).json({
      summary: result.summary || 'Authored a focused JointProgram for AnyJoint fitting.',
      jointProgram: program,
      proposal,
      commands,
      uncertainty: [
        ...(Array.isArray(result.uncertainty) ? result.uncertainty : []),
        ...checked.warnings
      ],
      nextAction: 'Fit jointProgram in Grasshopper and return proposal_json as fitFeedback when revision is needed.'
    });
  } catch (err) {
    console.error('[design-joinery] error:', err);
    return res.status(500).json({ error: err.message });
  }
}

export function buildJoineryContext(workspace, beamId, stepId = null) {
  const parts = workspace?.instance?.parts || [];
  const selectedPart = parts.find(part => String(part.id) === String(beamId));
  if (!selectedPart) {
    return {
      error: `beamId "${beamId}" does not match a Workspace part. Available: ${parts.map(p => p.id).join(', ') || '(none)'}`
    };
  }

  const byId = new Map(parts.map(part => [String(part.id), part]));
  const connectedParts = (selectedPart.connections || [])
    .map(id => byId.get(String(id)))
    .filter(Boolean);
  const conditions = (workspace.conditions || [])
    .filter(condition => String(condition.partRef) === String(beamId));
  const conditionIds = new Set(conditions.map(condition => String(condition.id)));

  const evidence = (workspace.evidence || [])
    .filter(item => {
      const attached = item.attachedTo;
      const attachedId = attached && typeof attached === 'object' ? attached.id : attached;
      return String(attachedId) === String(beamId) || conditionIds.has(String(attachedId)) ||
        conditions.some(condition => (condition.evidenceRefs || []).map(String).includes(String(item.id)));
    })
    .map(item => ({
      id: item.id,
      kind: item.kind,
      attachedTo: item.attachedTo,
      capturedAt: item.capturedAt,
      text: item.text || null,
      measurement: item.measurement || null,
      fileName: item.fileName || null,
      mimeType: item.mimeType || null,
      hasImage: !!item.url
    }));

  const plans = workspace.plans || [];
  const plan = plans.find(item => String(item.id) === String(workspace.currentPlanId)) ||
    (plans.length === 1 ? plans[0] : null);
  let selectedStep = null;
  if (stepId) {
    selectedStep = (plan?.steps || []).find(step => String(step.id) === String(stepId));
    if (!plan) return { error: 'stepId was supplied but the Workspace has no active strategy' };
    if (!selectedStep) return { error: `stepId "${stepId}" does not exist in the active strategy` };
    if (!(selectedStep.affectedPartRefs || []).map(String).includes(String(beamId))) {
      return { error: `stepId "${stepId}" does not affect beamId "${beamId}"` };
    }
  }
  const relevantSteps = (plan?.steps || []).filter(step =>
    (step.affectedPartRefs || []).map(String).includes(String(beamId))
  );

  return {
    planId: plan?.id || null,
    selectedPart: cleanPart(selectedPart),
    connectedParts: connectedParts.map(cleanPart),
    conditions,
    evidence,
    strategy: plan ? {
      id: plan.id,
      label: plan.label,
      intent: plan.intent || null,
      constraints: plan.constraints || null,
      selectedStep,
      relevantSteps
    } : null
  };
}

function cleanPart(part) {
  return {
    id: part.id,
    label: part.label || part.name || '',
    origin: part.origin || null,
    dimensions: part.dimensions || null,
    rotation: part.rotation || null,
    connections: part.connections || [],
    material: part.material || '',
    status: part.status || '',
    function: part.function || '',
    notes: part.notes || ''
  };
}

export function validateJointProgram(input, context, stepId = null) {
  const errors = [];
  const warnings = [];
  const program = structuredClone(input || {});
  const validPartIds = new Set([
    String(context.selectedPart.id),
    ...context.connectedParts.map(part => String(part.id))
  ]);
  const validConditionIds = new Set(context.conditions.map(item => String(item.id)));

  program.schema = PROGRAM_SCHEMA;
  if (!program.id) program.id = `joinery_${context.selectedPart.id}`;
  program.targetPartRef = program.targetPartRef || context.selectedPart.id;
  if (String(program.targetPartRef) !== String(context.selectedPart.id)) {
    errors.push(`targetPartRef must be "${context.selectedPart.id}"`);
  }
  program.repairStepRef = stepId || null;

  const aliases = {
    bowtie: 'lapped_bowtie',
    dovetail: 'lapped_bowtie',
    positive_lock: 'lapped_bowtie',
    lap_plus_bowtie: 'lapped_bowtie',
    simple_scarf: 'scarf',
    half_lap: 'lap'
  };
  program.geometry = program.geometry && typeof program.geometry === 'object'
    ? program.geometry : {};
  let topology = String(program.geometry.topology || '').trim().toLowerCase();
  topology = aliases[topology] || topology;
  if (!TOPOLOGIES.has(topology)) {
    errors.push(`geometry.topology must be one of: ${[...TOPOLOGIES].join(', ')}`);
  }
  program.geometry.topology = topology;
  program.geometry.parameters = program.geometry.parameters || {};

  if (!Array.isArray(program.geometryProgram) || !program.geometryProgram.length) {
    errors.push('geometryProgram must contain at least one operation');
  }
  program.addressesConditionRefs = (program.addressesConditionRefs || [])
    .map(String)
    .filter(id => {
      const valid = validConditionIds.has(id);
      if (!valid) warnings.push(`Removed unknown condition ref: ${id}`);
      return valid;
    });
  program.affectedPartRefs = (program.affectedPartRefs || [])
    .map(String)
    .filter(id => {
      const valid = validPartIds.has(id);
      if (!valid) warnings.push(`Removed non-neighbour affected part ref: ${id}`);
      return valid;
    });
  if (!program.affectedPartRefs.includes(String(context.selectedPart.id))) {
    program.affectedPartRefs.unshift(String(context.selectedPart.id));
  }

  program.fitObjective = program.fitObjective && typeof program.fitObjective === 'object'
    ? program.fitObjective : {};
  program.fitObjective.mandatoryDamageCoverage = 1.0;
  program.fitObjective.parameterSamples = clampInt(program.fitObjective.parameterSamples, 1, 3, 3);
  program.fitObjective.positionSamples = clampInt(program.fitObjective.positionSamples, 2, 25, 7);
  program.fitObjective.damageThreshold = clampNumber(program.fitObjective.damageThreshold, 0, 1, 0.5);
  program.fitObjective.damageMarginSections = clampNumber(program.fitObjective.damageMarginSections, 0, 3, 1.0);
  if (!Array.isArray(program.fitObjective.rotationsDeg) || !program.fitObjective.rotationsDeg.length) {
    program.fitObjective.rotationsDeg = [0, 90, 180, 270];
  }
  if (!Array.isArray(program.fitObjective.replacementSides) || !program.fitObjective.replacementSides.length) {
    program.fitObjective.replacementSides = [1, -1];
  }
  program.fitObjective.replacementSides = program.fitObjective.replacementSides
    .map(Number)
    .map(value => value >= 0 ? 1 : -1)
    .filter((value, index, array) => array.indexOf(value) === index);

  program.contextAssessment = program.contextAssessment || {};
  program.jointBehaviour = program.jointBehaviour || {};
  program.assemblyPlan = program.assemblyPlan || {};
  program.fabricationPlan = program.fabricationPlan || {};
  program.evidence = Array.isArray(program.evidence) ? program.evidence : [];
  program.openQuestions = Array.isArray(program.openQuestions) ? program.openQuestions.map(String) : [];
  program.confidence = clampNumber(program.confidence, 0, 1, 0.5);

  return { ok: errors.length === 0, errors, warnings, program };
}

function clampInt(value, min, max, fallback) {
  const number = Number.isFinite(Number(value)) ? Math.round(Number(value)) : fallback;
  return Math.max(min, Math.min(max, number));
}

function clampNumber(value, min, max, fallback) {
  const number = Number.isFinite(Number(value)) ? Number(value) : fallback;
  return Math.max(min, Math.min(max, number));
}

// Bounded before it can spend anything. See _shared/rate-limit.js.
export default withRateLimit('design-joinery', handler);
