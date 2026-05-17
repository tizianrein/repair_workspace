/**
 * Chat engine — the meat of the conversational endpoint.
 *
 * Both the synchronous chat endpoint (/api/chat) and a future streaming
 * variant share this logic. Pulled out so we don't duplicate the tool
 * dispatcher and workspace-lean logic when we add streaming later.
 *
 * The engine:
 *   1. Loads the system prompt
 *   2. Converts client thread history to Gemini's format
 *   3. Runs the multi-turn tool-calling loop via callGeminiWithTools
 *   4. Returns { reply, commands, toolCalls, plannedSummary }
 *
 * The `mapToolToCommand` function translates the AI's tool vocabulary
 * (add_condition, create_plan, etc) into the workspace's command
 * vocabulary (add-hypothesis, add-plan, etc). Server is stateless:
 * commands are collected and returned to the client which owns the
 * workspace state.
 */

import { callGeminiWithTools } from './gemini.js';
import { loadPrompt } from './prompts.js';
import { CHAT_TOOLS } from './chat-tools.js';

let serverCounter = 0;
function newId(prefix) {
  serverCounter++;
  return `${prefix}_${Date.now().toString(36)}${serverCounter.toString(36).padStart(3, '0')}`;
}

export async function runChat({ thread, userMessage, workspace, files }) {
  const systemPrompt = loadPrompt('chat');

  // Convert prior chat history into Gemini's role/parts format
  const history = [];
  for (const m of (thread?.messages || [])) {
    if (!m.content) continue;
    if (m.role === 'user') {
      history.push({ role: 'user', parts: [{ text: m.content }] });
    } else if (m.role === 'assistant') {
      history.push({ role: 'model', parts: [{ text: m.content }] });
    }
  }

  const snapshot = leanWorkspace(workspace);
  const collectedCommands = [];
  const toolCallTrace = [];

  async function executeTool(name, args) {
    const result = mapToolToCommand(name, args, snapshot, workspace);
    toolCallTrace.push({ name, args, result });
    if (result.command) collectedCommands.push(result.command);
    if (Array.isArray(result.commands)) {
      for (const c of result.commands) collectedCommands.push(c);
    }
    return result;
  }

  // First attempt: normal call
  let result;
  let firstError = null;
  try {
    result = await callGeminiWithTools({
      systemPrompt,
      userMessage,
      history,
      workspaceSnapshot: snapshot,
      tools: CHAT_TOOLS,
      executeTool,
      model: 'gemini-2.5-flash',
      temperature: 0.6,
      maxTurns: 12,
      // Gemini 2.5 Flash supports up to 65k output tokens. We use a
      // generous budget so big plans (20+ steps with full descriptions)
      // can fit. The bottleneck for big plans is rarely tokens — it's
      // Gemini's tool-call argument decoder choking on deeply nested
      // structures. We mitigate by allowing more turns so the model can
      // call create_plan with a skeleton, then refine with update_step
      // calls across subsequent turns.
      maxOutputTokens: 32768
    });
  } catch (err) {
    firstError = err;
  }

  // Retry-with-collaboration: if the first attempt failed with a model-side
  // problem (MALFORMED_FUNCTION_CALL, empty output, MAX_TOKENS), try again
  // with an explicit instruction to break the work down and ask the user
  // for help. This turns a hard failure into a productive conversation.
  const failed = firstError || (!result?.text?.trim() && toolCallTrace.length === 0);
  if (failed) {
    const errorContext = firstError?.message || 'no response';
    const fallbackInstruction =
      `The previous attempt failed: ${errorContext}. ` +
      `This means your task was too large to do in one go. ` +
      `Do NOT try again to do everything at once. ` +
      `Instead: reply with a short message that (a) acknowledges the request is ambitious, ` +
      `(b) proposes 2-3 ways to break it into smaller chunks, ` +
      `(c) asks the user which chunk to do first. ` +
      `Do NOT call any tools in this response — just write the chunking proposal as plain text.`;

    try {
      result = await callGeminiWithTools({
        systemPrompt: systemPrompt + '\n\n## RETRY MODE\n\n' + fallbackInstruction,
        userMessage,
        history,
        workspaceSnapshot: snapshot,
        // No tools on the retry — we want a conversational fallback only.
        tools: [],
        executeTool: async () => ({ ok: true }),
        model: 'gemini-2.5-flash',
        temperature: 0.5,
        maxTurns: 1,
        maxOutputTokens: 2048
      });
    } catch (retryErr) {
      // If even the simple retry fails, surface the original error so the
      // user knows what went wrong.
      throw firstError || retryErr;
    }
  }

  return {
    reply: result.text || '',
    commands: collectedCommands,
    toolCalls: toolCallTrace,
    plannedSummary: buildSummary(collectedCommands)
  };
}

/**
 * Lean workspace snapshot — the slice the chat AI actually needs.
 * Drops large/noisy fields like full part geometry, edge metadata,
 * past conversation threads. The AI gets enough to reason about
 * the artefact, its conditions, intent, constraints, and the
 * current strategy.
 */
function leanWorkspace(ws) {
  const plan = (ws.plans || []).find(p => p.id === ws.currentPlanId);
  return {
    instance: {
      id: ws.instance?.id,
      name: ws.instance?.name,
      parts: (ws.instance?.parts || []).map(p => ({
        id: p.id, label: p.label, material: p.material, status: p.status
      }))
    },
    conditions: (ws.hypotheses || []).map(h => ({
      id: h.id, type: h.type, description: h.description,
      partRef: h.partRef, status: h.status, confidence: h.confidence
    })),
    intent: ws.intent,
    constraints: ws.constraints,
    currentPlanId: ws.currentPlanId,
    currentPlan: plan ? {
      id: plan.id, label: plan.label, status: plan.status,
      steps: (plan.steps || []).map(s => ({
        id: s.id, title: s.title, description: s.description,
        affectedPartRefs: s.affectedPartRefs,
        addressesHypothesisRefs: s.addressesHypothesisRefs
      })),
      edges: (plan.edges || []).map(e => ({ source: e.source, target: e.target })),
      mutexGroups: plan.mutexGroups
    } : null,
    plans: (ws.plans || []).map(p => ({
      id: p.id, label: p.label, status: p.status, stepCount: (p.steps || []).length
    }))
  };
}

/**
 * Translate one tool call from the AI's vocabulary into a workspace
 * command. Returns { ok|error, command?, ...details }.
 */
function mapToolToCommand(name, args, snapshot, fullWorkspace) {
  switch (name) {
    case 'add_condition': {
      const id = newId('hyp');
      return {
        ok: true, hypothesisId: id,
        message: `Added ${args.type} on ${args.partRef}`,
        command: {
          type: 'add-hypothesis',
          payload: {
            hypothesis: {
              id, type: args.type, description: args.description,
              partRef: args.partRef,
              status: args.status || 'suspected',
              confidence: args.confidence ?? 0.7
            }
          }
        }
      };
    }
    case 'remove_condition':
      return {
        ok: true, message: `Removed ${args.hypothesisId}`,
        command: { type: 'remove-hypothesis', payload: { hypothesisId: args.hypothesisId } }
      };
    case 'update_condition':
      return {
        ok: true, message: `Updated ${args.hypothesisId}`,
        command: { type: 'update-hypothesis', payload: { hypothesisId: args.hypothesisId, patch: args.patch || {} } }
      };
    case 'set_intent': {
      const intent = {};
      if (args.summary !== undefined) intent.summary = args.summary;
      if (Array.isArray(args.axes)) {
        const existing = (snapshot.intent?.axes || []).slice();
        for (const upd of args.axes) {
          const idx = existing.findIndex(a => a.id === upd.id);
          if (idx >= 0) existing[idx] = { ...existing[idx], value: upd.value };
        }
        intent.axes = existing;
      }
      return { ok: true, message: 'Intent updated', command: { type: 'set-intent', payload: { intent } } };
    }
    case 'set_constraints':
      return {
        ok: true, message: 'Constraints updated',
        command: { type: 'set-constraints', payload: { constraints: { ...args } } }
      };
    case 'create_plan': {
      const planId = newId('plan');
      const steps = (args.steps || []).map(s => ({
        id: s.id || newId('step'),
        title: s.title, description: s.description,
        affectedPartRefs: s.affectedPartRefs || [],
        addressesHypothesisRefs: s.addressesHypothesisRefs || [],
        toolsRequired: s.toolsRequired || [],
        materialsRequired: s.materialsRequired || [],
        estimatedMinutes: s.estimatedMinutes || null
      }));
      const edges = (args.edges || []).map(e => ({ id: newId('edge'), source: e.source, target: e.target }));
      const mutexGroups = (args.mutexGroups || []).map(g => ({
        id: newId('mutex'), label: g.label || '', stepIds: g.stepIds || []
      }));
      return {
        ok: true, planId, stepIds: steps.map(s => s.id),
        message: `Created plan "${args.label}" with ${steps.length} steps`,
        command: {
          type: 'add-plan',
          payload: { plan: { id: planId, label: args.label, status: 'draft', steps, edges, mutexGroups } }
        }
      };
    }
    case 'add_step': {
      const currentPlanId = fullWorkspace.currentPlanId;
      if (!currentPlanId) return { error: 'No active plan. Call create_plan first.' };
      const stepId = newId('step');
      const commands = [{
        type: 'upsert-step',
        payload: {
          planId: currentPlanId,
          step: {
            id: stepId, title: args.title, description: args.description,
            affectedPartRefs: args.affectedPartRefs || [],
            addressesHypothesisRefs: args.addressesHypothesisRefs || [],
            toolsRequired: args.toolsRequired || [],
            materialsRequired: args.materialsRequired || [],
            estimatedMinutes: args.estimatedMinutes || null
          }
        }
      }];
      // Auto-wire the new step into the plan's flow. If afterStepId is
      // given, add an edge so this step depends on that one. Same for
      // beforeStepId. Without this, the user gets orphan steps floating
      // disconnected from the main chain.
      if (args.afterStepId) {
        commands.push({
          type: 'add-edge',
          payload: { planId: currentPlanId, source: args.afterStepId, target: stepId }
        });
      }
      if (args.beforeStepId) {
        commands.push({
          type: 'add-edge',
          payload: { planId: currentPlanId, source: stepId, target: args.beforeStepId }
        });
      }
      return {
        ok: true, stepId,
        message: `Added step "${args.title}"`,
        // Multi-command result: engine will push all of these into the
        // collectedCommands array.
        commands
      };
    }
    case 'update_step': {
      const currentPlanId = fullWorkspace.currentPlanId;
      if (!currentPlanId) return { error: 'No active plan' };
      return {
        ok: true, message: `Updated ${args.stepId}`,
        command: { type: 'upsert-step', payload: { planId: currentPlanId, step: { id: args.stepId, ...(args.patch || {}) } } }
      };
    }
    case 'remove_step': {
      const currentPlanId = fullWorkspace.currentPlanId;
      if (!currentPlanId) return { error: 'No active plan' };
      return {
        ok: true, message: `Removed ${args.stepId}`,
        command: { type: 'remove-step', payload: { planId: currentPlanId, stepId: args.stepId } }
      };
    }
    case 'add_edge': {
      const currentPlanId = fullWorkspace.currentPlanId;
      if (!currentPlanId) return { error: 'No active plan' };
      return {
        ok: true, message: `Linked ${args.source} → ${args.target}`,
        command: { type: 'add-edge', payload: { planId: currentPlanId, source: args.source, target: args.target } }
      };
    }
    case 'remove_edge': {
      const currentPlanId = fullWorkspace.currentPlanId;
      if (!currentPlanId) return { error: 'No active plan' };
      return { ok: true, command: { type: 'remove-edge', payload: { planId: currentPlanId, edgeId: args.edgeId } } };
    }
    case 'set_active_plan':
      return { ok: true, command: { type: 'set-current-plan', payload: { planId: args.planId } } };
    case 'update_plan':
      return {
        ok: true, message: `Updated plan ${args.planId}`,
        command: { type: 'update-plan', payload: { planId: args.planId, patch: args.patch || {} } }
      };
    case 'remove_plan':
      return { ok: true, command: { type: 'remove-plan', payload: { planId: args.planId } } };
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

function buildSummary(commands) {
  if (!commands.length) return '';
  const counts = {};
  for (const c of commands) counts[c.type] = (counts[c.type] || 0) + 1;
  const friendly = {
    'add-hypothesis': 'condition',
    'remove-hypothesis': 'removed condition',
    'update-hypothesis': 'updated condition',
    'add-plan': 'plan',
    'remove-plan': 'removed plan',
    'upsert-step': 'step',
    'remove-step': 'removed step',
    'add-edge': 'connection',
    'remove-edge': 'removed connection',
    'set-intent': 'intent change',
    'set-constraints': 'constraints change',
    'set-current-plan': 'switched plan'
  };
  const parts = [];
  for (const [type, n] of Object.entries(counts)) {
    const label = friendly[type] || type;
    parts.push(n === 1 ? `1 ${label}` : `${n} ${label}s`);
  }
  return parts.join(', ');
}
