/**
 * POST /api/chat (streaming)
 *
 * Conversational endpoint with function-calling and Server-Sent Events.
 * Streams text deltas + tool calls live to the browser so the UI can
 * update workspace state in real time while the AI talks.
 *
 * Event stream (each event is "data: {json}\n\n"):
 *   { kind: 'text_delta', text }
 *   { kind: 'tool_call', name, args, result, command? }
 *   { kind: 'turn_complete' }
 *   { kind: 'done', summary, commandCount }
 *   { kind: 'error', error }
 *
 * The 'command' field on tool_call events is the workspace command the
 * client should apply immediately. The client is the source of truth for
 * workspace state — the server is stateless. IDs generated here are
 * format-compatible with the client's uid() so they reference correctly.
 */

import { streamGeminiWithTools } from './_shared/gemini.js';
import { loadPrompt } from './_shared/prompts.js';
import { CHAT_TOOLS } from './_shared/chat-tools.js';

export const config = { maxDuration: 90 };

let serverCounter = 0;
function newId(prefix) {
  serverCounter++;
  return `${prefix}_${Date.now().toString(36)}${serverCounter.toString(36).padStart(3, '0')}`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  function send(event) {
    try { res.write(`data: ${JSON.stringify(event)}\n\n`); }
    catch (err) { console.warn('[chat] failed to write event:', err.message); }
  }

  try {
    const { thread, userMessage, workspace, files } = req.body || {};
    if (!userMessage) { send({ kind: 'error', error: 'userMessage is required' }); res.end(); return; }
    if (!workspace) { send({ kind: 'error', error: 'workspace is required' }); res.end(); return; }

    const systemPrompt = loadPrompt('chat');

    const history = [];
    for (const m of (thread?.messages || [])) {
      if (!m.content) continue;
      if (m.role === 'user') history.push({ role: 'user', parts: [{ text: m.content }] });
      else if (m.role === 'assistant') history.push({ role: 'model', parts: [{ text: m.content }] });
    }

    const snapshot = leanWorkspace(workspace);
    let commandCount = 0;

    async function executeTool(name, args) {
      // Returns { ok|error, command?, ...details } — streamGeminiWithTools
      // emits a 'tool_call' event with this whole object as the `result`
      // payload, so the `command` field is what the client picks up to apply.
      const result = mapToolToCommand(name, args, snapshot, workspace, newId);
      if (result.command) commandCount++;
      return result;
    }

    await streamGeminiWithTools({
      systemPrompt,
      userMessage,
      history,
      workspaceSnapshot: snapshot,
      tools: CHAT_TOOLS,
      executeTool,
      onEvent: (ev) => send(ev),
      model: 'gemini-2.5-flash',
      temperature: 0.6,
      maxTurns: 10,
      maxOutputTokens: 16384
    });

    send({ kind: 'done', commandCount });
    res.end();
  } catch (err) {
    console.error('[chat] error:', err);
    send({ kind: 'error', error: err.message });
    try { res.end(); } catch {}
  }
}

function mapToolToCommand(name, args, snapshot, fullWorkspace, mkId) {
  switch (name) {
    case 'add_condition': {
      const id = mkId('hyp');
      return {
        ok: true, hypothesisId: id, message: `Added ${args.type} on ${args.partRef}`,
        command: {
          type: 'add-hypothesis',
          payload: {
            hypothesis: {
              id, type: args.type, description: args.description, partRef: args.partRef,
              status: args.status || 'suspected', confidence: args.confidence ?? 0.7
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
      const planId = mkId('plan');
      const steps = (args.steps || []).map(s => ({
        id: s.id || mkId('step'),
        title: s.title, description: s.description,
        affectedPartRefs: s.affectedPartRefs || [],
        addressesHypothesisRefs: s.addressesHypothesisRefs || [],
        toolsRequired: s.toolsRequired || [], materialsRequired: s.materialsRequired || [],
        estimatedMinutes: s.estimatedMinutes || null
      }));
      const edges = (args.edges || []).map(e => ({ id: mkId('edge'), source: e.source, target: e.target }));
      const mutexGroups = (args.mutexGroups || []).map(g => ({
        id: mkId('mutex'), label: g.label || '', stepIds: g.stepIds || []
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
      const stepId = mkId('step');
      return {
        ok: true, stepId, message: `Added step "${args.title}"`,
        command: {
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
        }
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
    case 'remove_plan':
      return { ok: true, command: { type: 'remove-plan', payload: { planId: args.planId } } };
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

function leanWorkspace(ws) {
  const plan = (ws.plans || []).find(p => p.id === ws.currentPlanId);
  return {
    instance: {
      id: ws.instance?.id, name: ws.instance?.name,
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
        affectedPartRefs: s.affectedPartRefs, addressesHypothesisRefs: s.addressesHypothesisRefs
      })),
      edges: (plan.edges || []).map(e => ({ source: e.source, target: e.target })),
      mutexGroups: plan.mutexGroups
    } : null,
    plans: (ws.plans || []).map(p => ({
      id: p.id, label: p.label, status: p.status, stepCount: (p.steps || []).length
    }))
  };
}
