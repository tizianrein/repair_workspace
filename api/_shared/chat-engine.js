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

// ----------------------------------------------------------------------------
// Step-reference resolution
//
// Workshop bug: Gemini frequently calls add_edge with step "ids" that don't
// match the real ids in the plan — typically because (a) it invents a
// snake_case slug like "repair_feet_ends" from a step it created in the
// same turn (and where the server assigned an ephemeral id like step_mp9...),
// or (b) it passes the step's display title ("Grundierung auftragen") instead
// of an id. The batch then fails at apply-time on the client, the user sees
// the step never showed up, and there's no way for the model to recover.
//
// Fix: track every step the model creates within this chat turn, keyed by
// every alias the model might plausibly reference it by (server id, original
// requested slug if any, title, normalized title). When we see an add_edge,
// resolve source/target against the live workspace AND this pending-steps
// registry. If neither matches, return an error to the model — Gemini will
// see it in the functionResponse and gets a chance to fix itself.
// ----------------------------------------------------------------------------

function normalizeSlug(s) {
  if (s == null) return '';
  return String(s)
    .toLowerCase()
    // Pre-expand German digraphs that NFKD does NOT decompose (ä/ö/ü do
    // decompose, but ß stays as ß and would otherwise be stripped). Doing
    // this before NFKD covers the common workshop case where a step title
    // is "Reparatur der Fußenden" and the model references it by
    // "reparatur_der_fussenden".
    .replace(/ß/g, 'ss')
    .replace(/æ/g, 'ae')
    .replace(/œ/g, 'oe')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function buildStepAliasMap(currentPlan, pendingSteps) {
  const aliases = new Map();
  const add = (alias, realId) => {
    if (!alias || !realId) return;
    const a = String(alias).trim();
    if (!a) return;
    if (!aliases.has(a)) aliases.set(a, realId);
    const slug = normalizeSlug(a);
    if (slug && !aliases.has(slug)) aliases.set(slug, realId);
  };
  for (const s of (currentPlan?.steps || [])) {
    add(s.id, s.id);
    add(s.title, s.id);
  }
  for (const p of pendingSteps) {
    add(p.realId, p.realId);
    if (p.requestedSlug) add(p.requestedSlug, p.realId);
    if (p.title) add(p.title, p.realId);
  }
  return aliases;
}

function resolveStepRef(ref, aliases) {
  if (!ref) return null;
  const raw = String(ref).trim();
  if (aliases.has(raw)) return aliases.get(raw);
  const slug = normalizeSlug(raw);
  if (slug && aliases.has(slug)) return aliases.get(slug);
  return null;
}

// ----------------------------------------------------------------------------
// Chat-markdown stripping
//
// The chat UI doesn't render markdown. The prompt forbids it, but the model
// leaks **bold**, headings, and bullet markers anyway. We strip the common
// patterns server-side as a safety net so the user never sees literal
// asterisks or hashes. Conservative — only obvious markup, never touch
// snake_case identifiers like front_left_leg.
//
// We also strip Gemini "tool_code" leakage. Gemini Pro occasionally emits
// its function calls as a *text* part instead of as a proper `functionCall`
// part — typically as `tool_code\n print(default_api.add_condition(...))`
// or as long chains of `print(default_api.xxx(...))` calls. When this
// happens the tools don't actually execute (we only act on functionCall
// parts), and the user sees a wall of pseudo-Python in the chat. We can't
// recover the missed tool calls from text, but we can at least stop the
// garbage from reaching the UI and replace it with a brief honest message.
// ----------------------------------------------------------------------------

// Detect Gemini's textual tool-call leak. Triggers on either the explicit
// "tool_code" marker or on chains of `print(default_api.xxx(` which is the
// fingerprint of the leak format regardless of marker.
function looksLikeToolCodeLeak(text) {
  if (!text) return false;
  if (/\btool_code\b/.test(text)) return true;
  // Two or more print(default_api.xxx( calls in a row is the leak signature.
  const matches = text.match(/\bdefault_api\.[a-z_]+\s*\(/gi);
  return !!matches && matches.length >= 2;
}

// Remove the leaked tool-code blob. If the leak is most of the message,
// replace the whole thing with a short honest line so the user isn't
// reading pseudo-code. If it's only part of the message (rare), excise
// just the leak region.
function stripToolCodeLeak(text) {
  if (!looksLikeToolCodeLeak(text)) return text;
  // Strip the obvious tool_code / print(default_api...) chains.
  let cleaned = text
    .replace(/```tool_code[\s\S]*?```/g, '')
    .replace(/\btool_code\b[\s\S]*?(?=\n\n|$)/g, '')
    .replace(/\bprint\s*\(\s*default_api\.[\s\S]*?\)\s*\)/g, '')
    .replace(/\bdefault_api\.[a-z_]+\([\s\S]*?\)/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  // If almost nothing meaningful is left (under ~40 chars of prose),
  // replace with a stand-in. The tools that should have run didn't, so
  // tell the user honestly rather than pretending success.
  if (cleaned.length < 40) {
    return 'Something went wrong on my side — the changes I meant to make didn\'t register. Could you ask again?';
  }
  return cleaned;
}

function stripChatMarkdown(text) {
  if (!text || typeof text !== 'string') return text;
  return text
    .replace(/\*\*([^*\n]+?)\*\*/g, '$1')
    .replace(/__([^_\n]+?)__/g, '$1')
    .replace(/(^|[\s(])\*([^*\n]{1,80}?)\*(?=[\s.,!?;:)]|$)/g, '$1$2')
    .replace(/(^|[\s(])_([^_\n]{1,80}?)_(?=[\s.,!?;:)]|$)/g, '$1$2')
    .replace(/^#{1,6}[ \t]+/gm, '')
    .replace(/^[ \t]*[-*][ \t]+/gm, '')
    .replace(/`([^`\n]+?)`/g, '$1')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
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
  // Steps created during *this* chat turn. Lets add_edge resolve refs that
  // point at a sibling step the model just created (where the model knows
  // the step by a slug or title, but the server assigned a fresh id).
  const pendingSteps = [];
  // Plan created during *this* chat turn. The client only re-points
  // currentPlanId after the whole batch is applied, so without this a
  // sequence like create_plan + add_step would route the add_step to the
  // *old* current plan (or fail with "no active plan").
  const turnContext = { pendingPlanId: null };

  async function executeTool(name, args) {
    const result = mapToolToCommand(name, args, snapshot, workspace, pendingSteps, turnContext);
    toolCallTrace.push({ name, args, result });
    // Only push commands when the tool succeeded. result.error means we
    // rejected the call (e.g. add_edge to an unknown step) so the model
    // sees the error via functionResponse and gets to fix itself.
    if (!result.error) {
      if (result.command) collectedCommands.push(result.command);
      if (Array.isArray(result.commands)) {
        for (const c of result.commands) collectedCommands.push(c);
      }
    }
    return result;
  }

  // First attempt: normal call
  let result;
  let firstError = null;
  const t0 = Date.now();
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
    console.log('[chat-engine] first attempt OK in', Date.now() - t0, 'ms. text.len=', result?.text?.length || 0, 'tools=', toolCallTrace.length);
  } catch (err) {
    firstError = err;
    console.warn('[chat-engine] first attempt FAILED after', Date.now() - t0, 'ms:', err.message);
    console.warn('[chat-engine] context at failure: history.length=', history.length,
      'parts=', snapshot.instance?.parts?.length || 0,
      'conditions=', snapshot.conditions?.length || 0,
      'planSteps=', snapshot.currentPlan?.steps?.length || 0,
      'collectedCommands=', collectedCommands.length,
      'toolCallTrace=', toolCallTrace.length);
  }

  // Retry-on-tool-code-leak: Gemini sometimes emits its intended function
  // calls as *text* — "tool_code\nprint(default_api.add_condition(...))"
  // — instead of as proper functionCall parts. From the model's POV the
  // turn succeeded; from ours, zero tools ran and the user is about to
  // read pseudo-Python claiming things were done that weren't. Detect
  // this and re-prompt with an explicit correction. The retry instruction
  // tells the model to use real function calls AND warns it not to lie
  // about what it did. We discard the first attempt's leaked text and
  // also wipe any half-applied commands so the retry starts clean.
  if (!firstError && result?.text && looksLikeToolCodeLeak(result.text)) {
    console.warn('[chat-engine] tool_code LEAK detected in first reply (len=' + result.text.length + '). Retrying with correction.');
    // Clean slate: the leak path almost always means zero real tools ran,
    // but if the model emitted a *mix* of real calls and leaked text we
    // throw away the real calls too — the retry will redo the whole turn
    // properly. Better than a half-applied state the user can't reason about.
    collectedCommands.length = 0;
    toolCallTrace.length = 0;
    pendingSteps.length = 0;
    turnContext.pendingPlanId = null;

    const leakCorrection =
      '\n\n## TOOL-CALL CORRECTION\n\n' +
      'Your previous attempt at this user turn emitted tool calls as *text* (e.g. ' +
      '"tool_code print(default_api.add_condition(...))") instead of as real function ' +
      'calls. None of those tools actually ran. The workspace was not modified.\n\n' +
      'Retry this turn now. Use real function calls — the same tools listed in your ' +
      'tool schema (add_condition, set_intent, create_plan, etc.). Do NOT write ' +
      'tool calls as Python-looking text. Do NOT claim you did things you did not do. ' +
      'If you cannot perform the requested actions for some reason, say so plainly ' +
      'in one or two sentences and ask a clarifying question. Otherwise: make the ' +
      'function calls and write a short normal reply describing what you just did.';

    const tLeak = Date.now();
    try {
      result = await callGeminiWithTools({
        systemPrompt: systemPrompt + leakCorrection,
        userMessage,
        history,
        workspaceSnapshot: snapshot,
        tools: CHAT_TOOLS,
        executeTool,
        model: 'gemini-2.5-flash',
        temperature: 0.4,  // a touch lower — we want compliance, not creativity
        maxTurns: 12,
        maxOutputTokens: 32768
      });
      console.log('[chat-engine] leak retry done in', Date.now() - tLeak, 'ms. text.len=', result?.text?.length || 0, 'tools=', toolCallTrace.length, 'leakAgain=', looksLikeToolCodeLeak(result?.text || ''));
    } catch (retryErr) {
      // The retry itself errored. Fall through — the strip-and-apologize
      // path at the end will catch it. Don't throw: we want to give the
      // user *something* useful rather than a 500.
      console.warn('[chat-engine] leak retry threw:', retryErr.message);
      firstError = retryErr;
    }
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
    reply: stripChatMarkdown(stripToolCodeLeak(result.text || '')),
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
 *
 * `pendingSteps` is a shared mutable array carrying step-id information
 * for steps created earlier in the same chat turn — so add_edge can
 * resolve refs that point at a step the model just created via add_step.
 *
 * `turnContext.pendingPlanId` carries the id of a plan created earlier
 * in this turn via create_plan. Subsequent step-mutation tools in the
 * same turn must target that plan, not the stale workspace currentPlanId.
 */
function mapToolToCommand(name, args, snapshot, fullWorkspace, pendingSteps = [], turnContext = {}) {
  const activePlanId = turnContext.pendingPlanId || fullWorkspace.currentPlanId || null;
  const currentPlan = activePlanId
    ? (fullWorkspace.plans || []).find(p => p.id === activePlanId) || null
    : null;
  const aliases = buildStepAliasMap(currentPlan, pendingSteps);

  switch (name) {
    case 'add_condition': {
      const id = newId('hyp');
      // Default coordinates: anchor to the part's origin.
      //
      // In this workspace, a part's `origin` is the position of its mesh
      // in world space (see views/viewer-3d.js: mesh.position.set(o.x,
      // o.y, o.z)). The box geometry extends symmetrically around that
      // origin, so the origin is effectively the part's anchor point —
      // not a corner. The viewer also skips rendering hypothesis spheres
      // that have no coordinates at all, so we need *some* coordinate.
      //
      // For an unlocated condition (e.g. "weathering across the whole
      // leg") the right default is the part origin itself. That keeps
      // the marker visually attached to its part instead of floating
      // away by half a bounding box, which is what a naive
      // origin + dim/2 calculation produced. propose.js uses the same
      // convention in rescueCoordinates(): when a hypothesis has no
      // meaningful location, snap it to the part origin.
      //
      // If the model has a real spatial cue from the user ("crack on
      // the upper-left of the seat"), it can pass an explicit
      // `coordinates` argument and we honour it.
      let coordinates = null;
      const part = (fullWorkspace.instance?.parts || []).find(p => p.id === args.partRef);
      if (args.coordinates && typeof args.coordinates === 'object') {
        coordinates = {
          x: Number(args.coordinates.x) || 0,
          y: Number(args.coordinates.y) || 0,
          z: Number(args.coordinates.z) || 0
        };
      } else if (part?.origin) {
        coordinates = {
          x: part.origin.x || 0,
          y: part.origin.y || 0,
          z: part.origin.z || 0
        };
      }
      return {
        ok: true, hypothesisId: id,
        message: `Added ${args.type} on ${args.partRef}`,
        command: {
          type: 'add-hypothesis',
          payload: {
            hypothesis: {
              id, type: args.type, description: args.description,
              partRef: args.partRef,
              coordinates,
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
      // First pass: stamp every step with a real id, register it in
      // pendingSteps so subsequent tool calls (and edge resolution below)
      // can find it by the slug/title the model originally used.
      const steps = (args.steps || []).map(s => {
        const realId = s.id && /^step_/.test(s.id) ? s.id : newId('step');
        pendingSteps.push({
          realId,
          requestedSlug: s.id || null,
          title: s.title || null
        });
        return {
          id: realId,
          title: s.title, description: s.description,
          affectedPartRefs: s.affectedPartRefs || [],
          addressesHypothesisRefs: s.addressesHypothesisRefs || [],
          toolsRequired: s.toolsRequired || [],
          materialsRequired: s.materialsRequired || [],
          estimatedMinutes: s.estimatedMinutes || null
        };
      });
      // Resolve edges against the now-registered steps. Skip silently any
      // edge whose endpoints don't resolve — a partial plan is better than
      // no plan when participants are watching.
      const localAliases = buildStepAliasMap(currentPlan, pendingSteps);
      const edges = [];
      const droppedEdges = [];
      for (const e of (args.edges || [])) {
        const src = resolveStepRef(e.source, localAliases);
        const tgt = resolveStepRef(e.target, localAliases);
        if (src && tgt) {
          edges.push({ id: newId('edge'), source: src, target: tgt });
        } else {
          droppedEdges.push({ source: e.source, target: e.target });
        }
      }
      const mutexGroups = (args.mutexGroups || []).map(g => ({
        id: newId('mutex'), label: g.label || '',
        stepIds: (g.stepIds || []).map(id => resolveStepRef(id, localAliases)).filter(Boolean)
      })).filter(g => g.stepIds.length >= 2);
      if (droppedEdges.length) {
        console.warn('[chat-engine] create_plan: dropped', droppedEdges.length, 'unresolvable edge(s):', droppedEdges);
      }
      // Mark this plan as in-turn active so later tool calls route to it.
      turnContext.pendingPlanId = planId;
      return {
        ok: true, planId, stepIds: steps.map(s => s.id),
        message: `Created plan "${args.label}" with ${steps.length} steps`
          + (droppedEdges.length ? ` (${droppedEdges.length} edge(s) skipped)` : ''),
        command: {
          type: 'add-plan',
          payload: { plan: { id: planId, label: args.label, status: 'draft', steps, edges, mutexGroups } }
        }
      };
    }
    case 'add_step': {
      const currentPlanId = activePlanId;
      if (!currentPlanId) return { error: 'No active plan. Call create_plan first.' };
      const stepId = newId('step');
      // Register BEFORE resolving after/before so the new step itself is
      // findable by later tool calls in this turn.
      pendingSteps.push({
        realId: stepId,
        requestedSlug: args.slug || null,
        title: args.title || null
      });
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
      // Auto-wire. afterStepId/beforeStepId may be a real id, slug, or
      // title; resolve via the alias map. If unresolvable, skip the edge
      // and warn rather than failing the whole batch.
      const localAliases = buildStepAliasMap(currentPlan, pendingSteps);
      const warnings = [];
      if (args.afterStepId) {
        const src = resolveStepRef(args.afterStepId, localAliases);
        if (src) {
          commands.push({
            type: 'add-edge',
            payload: { planId: currentPlanId, source: src, target: stepId }
          });
        } else {
          warnings.push(`afterStepId "${args.afterStepId}" did not match — edge skipped`);
        }
      }
      if (args.beforeStepId) {
        const tgt = resolveStepRef(args.beforeStepId, localAliases);
        if (tgt) {
          commands.push({
            type: 'add-edge',
            payload: { planId: currentPlanId, source: stepId, target: tgt }
          });
        } else {
          warnings.push(`beforeStepId "${args.beforeStepId}" did not match — edge skipped`);
        }
      }
      return {
        ok: true, stepId,
        message: `Added step "${args.title}"` + (warnings.length ? ` (${warnings.join('; ')})` : ''),
        commands
      };
    }
    case 'update_step': {
      const currentPlanId = activePlanId;
      if (!currentPlanId) return { error: 'No active plan' };
      const resolvedId = resolveStepRef(args.stepId, aliases);
      if (!resolvedId) {
        const known = (currentPlan?.steps || []).map(s => s.id).join(', ');
        return { error: `update_step: step "${args.stepId}" not found. Known: ${known || '(none)'}` };
      }
      return {
        ok: true, message: `Updated ${resolvedId}`,
        command: { type: 'upsert-step', payload: { planId: currentPlanId, step: { id: resolvedId, ...(args.patch || {}) } } }
      };
    }
    case 'remove_step': {
      const currentPlanId = activePlanId;
      if (!currentPlanId) return { error: 'No active plan' };
      const resolvedId = resolveStepRef(args.stepId, aliases);
      if (!resolvedId) {
        const known = (currentPlan?.steps || []).map(s => s.id).join(', ');
        return { error: `remove_step: step "${args.stepId}" not found. Known: ${known || '(none)'}` };
      }
      return {
        ok: true, message: `Removed ${resolvedId}`,
        command: { type: 'remove-step', payload: { planId: currentPlanId, stepId: resolvedId } }
      };
    }
    case 'add_edge': {
      const currentPlanId = activePlanId;
      if (!currentPlanId) return { error: 'No active plan' };
      const src = resolveStepRef(args.source, aliases);
      const tgt = resolveStepRef(args.target, aliases);
      if (!src || !tgt) {
        // Return a tool-level error so Gemini sees it via functionResponse
        // and can correct itself in the same turn — instead of the batch
        // dying at apply time and the user seeing nothing happen.
        const known = (currentPlan?.steps || [])
          .map(s => `${s.id} ("${s.title}")`)
          .concat(pendingSteps.map(p => `${p.realId} ("${p.title || p.requestedSlug || ''}") [this turn]`))
          .join(', ');
        const what = !src && !tgt ? `source "${args.source}" and target "${args.target}"`
                   : !src ? `source "${args.source}"`
                   : `target "${args.target}"`;
        return {
          error: `add_edge: ${what} did not match any step in the current plan. ` +
                 `Known steps: ${known || '(none)'}.`
        };
      }
      return {
        ok: true, message: `Linked ${src} → ${tgt}`,
        command: { type: 'add-edge', payload: { planId: currentPlanId, source: src, target: tgt } }
      };
    }
    case 'remove_edge': {
      const currentPlanId = activePlanId;
      if (!currentPlanId) return { error: 'No active plan' };
      return { ok: true, command: { type: 'remove-edge', payload: { planId: currentPlanId, edgeId: args.edgeId } } };
    }
    case 'set_active_plan':
      // Keep the in-turn context consistent so later tool calls target
      // the same plan the model just switched to.
      turnContext.pendingPlanId = args.planId || null;
      return { ok: true, command: { type: 'set-current-plan', payload: { planId: args.planId } } };
    case 'update_plan':
      return {
        ok: true, message: `Updated plan ${args.planId}`,
        command: { type: 'update-plan', payload: { planId: args.planId, patch: args.patch || {} } }
      };
    case 'remove_plan':
      // If the model removes the plan it was about to mutate, clear the
      // turn-local pointer so later tool calls don't write into the void.
      if (turnContext.pendingPlanId === args.planId) turnContext.pendingPlanId = null;
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
