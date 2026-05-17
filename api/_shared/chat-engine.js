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

import { callGeminiWithTools, isProAvailable, tripProCoolDown, isQuotaError, PREFERRED_CHAT_MODEL_NAME, FALLBACK_CHAT_MODEL_NAME } from './gemini.js';
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

// Build a Map<alias, realStepId> from the live workspace plan AND any steps
// added in the current chat turn.
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

// Try to resolve a step reference (id-or-slug-or-title) to a real step id.
// Returns null if it can't be resolved.
function resolveStepRef(ref, aliases) {
  if (!ref) return null;
  const raw = String(ref).trim();
  if (aliases.has(raw)) return aliases.get(raw);
  const slug = normalizeSlug(raw);
  if (slug && aliases.has(slug)) return aliases.get(slug);
  return null;
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
  // Steps created during *this* chat turn. Used to resolve add_edge refs that
  // point at a sibling step the model just created (where the model knows the
  // step by a slug or title, but the server assigned a fresh id).
  const pendingSteps = [];
  // Plan created during *this* chat turn. Client only re-points currentPlanId
  // after the whole batch is applied, so without this, a sequence like
  // create_plan + add_step would route the add_step to the *old* current plan
  // (or fail with "no active plan"). Mutable so create_plan can write to it.
  const turnContext = { pendingPlanId: null };

  async function executeTool(name, args) {
    const result = mapToolToCommand(name, args, snapshot, workspace, pendingSteps, turnContext);
    toolCallTrace.push({ name, args, result });
    // Only add commands when the tool actually succeeded. A result with
    // `error` means we rejected the call (e.g. add_edge to an unknown step)
    // and the model will see the error and get to try again.
    if (!result.error) {
      if (result.command) collectedCommands.push(result.command);
      if (Array.isArray(result.commands)) {
        for (const c of result.commands) collectedCommands.push(c);
      }
    }
    return result;
  }

  // ---------------------------------------------------------------------
  // Model selection: Flash first, Pro only on failure.
  // ---------------------------------------------------------------------
  // Flash is the default because it's act-freudig (eager to call tools)
  // and 2x faster. Pro is more cautious about acting and frequently
  // produced long descriptive replies with zero tool calls — exactly the
  // failure mode the user complained about ("the chat says it did things
  // but the workspace didn't change").
  //
  // We escalate to Pro only when Flash produces a recognizable failure
  // signal: a thrown error (MALFORMED_FUNCTION_CALL, MAX_TOKENS, network),
  // an empty response with no tool calls, or a tool_code-as-text leak.
  // Pro is much more reliable at producing structured function calls and
  // very rarely leaks tool_code text, so this catches the cases where
  // Flash literally cannot do the job.

  async function tryModel(model, opts = {}) {
    return callGeminiWithTools({
      systemPrompt,
      userMessage,
      history,
      workspaceSnapshot: snapshot,
      tools: CHAT_TOOLS,
      executeTool,
      model,
      temperature: 0.6,
      maxTurns: 12,
      maxOutputTokens: 32768,
      ...opts
    });
  }

  // Helper: detect whether a result looks like a recoverable failure that
  // would benefit from a Pro retry. Returns null if the result is usable,
  // or a short reason string otherwise.
  function flashFailureReason(res, err) {
    if (err) return `error: ${err.message}`;
    if (res?.toolCodeLeakDetected) return 'tool_code leak';
    if (!res?.text?.trim() && toolCallTrace.length === 0) return 'empty response';
    return null;
  }

  let result;
  let firstError = null;
  let modelTried = FALLBACK_CHAT_MODEL_NAME; // Flash
  const t0 = Date.now();
  try {
    result = await tryModel(modelTried);
    console.log(`[chat-engine] ${modelTried} OK in`, Date.now() - t0, 'ms. text.len=', result?.text?.length || 0, 'tools=', toolCallTrace.length, result?.toolCodeLeakDetected ? '(leak)' : '');
  } catch (err) {
    firstError = err;
    console.warn(`[chat-engine] ${modelTried} FAILED after`, Date.now() - t0, 'ms:', err.message);
  }

  // Escalate to Pro if Flash failed or produced unusable output.
  const failureReason = flashFailureReason(result, firstError);
  if (failureReason) {
    console.warn(`[chat-engine] escalating to Pro (reason: ${failureReason})`);
    // Reset turn-local state so the Pro retry starts clean. Anything Flash
    // half-committed (which is rare on the failure paths above — leak and
    // empty-response yield no tool calls) would otherwise double-up.
    collectedCommands.length = 0;
    toolCallTrace.length = 0;
    pendingSteps.length = 0;
    turnContext.pendingPlanId = null;
    modelTried = PREFERRED_CHAT_MODEL_NAME;
    const t1 = Date.now();
    try {
      result = await tryModel(PREFERRED_CHAT_MODEL_NAME);
      firstError = null;
      console.log('[chat-engine] Pro escalation OK in', Date.now() - t1, 'ms. text.len=', result?.text?.length || 0, 'tools=', toolCallTrace.length);
    } catch (proErr) {
      firstError = proErr;
      console.warn('[chat-engine] Pro escalation also FAILED after', Date.now() - t1, 'ms:', proErr.message);
    }
    if (firstError) {
      console.warn('[chat-engine] context at failure: history.length=', history.length,
        'parts=', snapshot.instance?.parts?.length || 0,
        'conditions=', snapshot.conditions?.length || 0,
        'planSteps=', snapshot.currentPlan?.steps?.length || 0,
        'collectedCommands=', collectedCommands.length,
        'toolCallTrace=', toolCallTrace.length);
    }
  }

  // Retry-with-collaboration: if the first attempt(s) produced no text and
  // no tool calls, fall back to a plain-text "let me chunk this" reply so
  // the user gets something useful rather than a silent empty bubble.
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
        // Always use Flash for the chunking retry — it's the cheap path
        // and we don't need Pro quality for "ask the user a question".
        model: FALLBACK_CHAT_MODEL_NAME,
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

  // ---------------------------------------------------------------------
  // Honesty guard
  //
  // Workshop bug: the model writes long reflective replies claiming to have
  // done things ("Ich habe den Plan auf Konservierung umgestellt...") while
  // calling zero tools — workspace doesn't change but user thinks it did.
  // Destroys trust faster than any other failure mode. Detect the pattern,
  // retry with a sharp instruction (escalating model if we were on Flash),
  // annotate the reply transparently if retry doesn't help.
  // ---------------------------------------------------------------------
  if (result?.text && toolCallTrace.length === 0 && containsActionClaim(result.text)) {
    console.warn(`[chat-engine] honesty guard tripped on ${modelTried}: reply claims actions but 0 tools called`);
    console.warn('[chat-engine] suspect reply head:', result.text.slice(0, 200).replace(/\s+/g, ' '));
    // If Flash lied, the retry uses Pro — Pro is more careful about claims
    // and more likely to actually call tools when retrying. If Pro lied,
    // retry on Pro since we don't have a better option.
    const retryModel = modelTried === FALLBACK_CHAT_MODEL_NAME
      ? PREFERRED_CHAT_MODEL_NAME
      : modelTried;
    const hardInstruction =
      `Your previous reply claimed to have done things ("ich habe...", "I have...", "I've changed...") ` +
      `but you did NOT call any tools, so the workspace was NOT actually modified. ` +
      `That is a lie to the user and breaks their trust. ` +
      `Reply again. You have two honest options: ` +
      `(1) Call the actual tools to do what you claimed — set_intent, update_plan, add_step, etc. ` +
      `Then briefly say what was done. ` +
      `(2) If you only intended to think out loud or propose, rewrite the reply as a question or proposal ` +
      `("Soll ich den Plan auf Konservierung umstellen? Das wären folgende Änderungen...") — ` +
      `do NOT use past tense for actions you did not actually perform via tool calls.`;
    try {
      const retryResult = await callGeminiWithTools({
        systemPrompt: systemPrompt + '\n\n## HONESTY RETRY\n\n' + hardInstruction,
        userMessage,
        history,
        workspaceSnapshot: snapshot,
        tools: CHAT_TOOLS,
        executeTool,
        model: retryModel,
        temperature: 0.4,
        maxTurns: 6,
        maxOutputTokens: 16384
      });
      console.log(`[chat-engine] honesty retry on ${retryModel} returned. text.len=`, retryResult?.text?.length || 0, 'tools=', toolCallTrace.length);
      // Use the retry result only if it actually fixed the problem
      // (either it called tools now, OR it rewrote the reply without
      // action claims). Otherwise keep the original + warn the user.
      const retryHasTools = toolCallTrace.length > 0;
      const retryHasClaims = retryResult?.text && containsActionClaim(retryResult.text);
      if (retryHasTools || !retryHasClaims) {
        result = retryResult;
        modelTried = retryModel;
        console.log('[chat-engine] honesty retry succeeded.');
      } else {
        // Retry didn't help. Append a transparent warning to the original
        // reply so the user knows nothing actually happened.
        console.warn('[chat-engine] honesty retry did NOT recover; annotating reply');
        result = {
          ...result,
          text: result.text.trim()
            + '\n\n— Hinweis: Ich habe oben Änderungen beschrieben, aber im Workspace ist nichts angepasst worden. Bitte fordere die konkrete Änderung nochmal direkt an, dann führe ich sie aus.'
        };
      }
    } catch (retryErr) {
      console.warn('[chat-engine] honesty retry threw:', retryErr.message);
      result = {
        ...result,
        text: result.text.trim()
          + '\n\n— Hinweis: Ich habe oben Änderungen beschrieben, aber im Workspace ist nichts angepasst worden. Bitte fordere die konkrete Änderung nochmal direkt an, dann führe ich sie aus.'
      };
    }
  }

  return {
    reply: result.text || '',
    commands: collectedCommands,
    toolCalls: toolCallTrace,
    plannedSummary: buildSummary(collectedCommands)
  };
}

// ----------------------------------------------------------------------------
// Action-claim detection
//
// Lightweight heuristic for "this reply claims a workspace action was taken."
// We don't try to be perfect — false positives cost a retry (cheap), false
// negatives mean a missed lie (the original bad behaviour). German + English
// covered because the prompt enforces same-language replies.
// ----------------------------------------------------------------------------

const ACTION_CLAIM_PATTERNS = [
  // German: "ich habe ... gesetzt/geändert/hinzugefügt/entfernt/aktualisiert/umbenannt/umgestellt/erstellt"
  /\bich habe\b[^.!?\n]*\b(gesetzt|geändert|hinzugefügt|entfernt|aktualisiert|umbenannt|umgestellt|erstellt|angepasst|gelöscht|eingefügt|umgestaltet|verschoben|umgewandelt|gewechselt|markiert|deaktiviert|aktiviert|reduziert|erhöht|gespeichert)\b/i,
  // German: "X wurde ..." passive (e.g. "Die Absicht wurde angepasst")
  /\b(wurde|wurden)\b[^.!?\n]*\b(gesetzt|geändert|hinzugefügt|entfernt|aktualisiert|umbenannt|umgestellt|erstellt|angepasst|gelöscht|eingefügt|verschoben|aktiviert)\b/i,
  // German: "Plan/Intent/Schritte sind jetzt ..."
  /\b(der Plan|die Absicht|das Intent|die Schritte|die Constraints?|die Bedingungen|die Conditions?)\b[^.!?\n]*\bist jetzt\b/i,
  /\b(der Plan|die Absicht|das Intent|die Schritte)\b[^.!?\n]*\bnun\b[^.!?\n]*\b(angepasst|aktualisiert|geändert|umgestellt|umbenannt)\b/i,
  // English: "I've / I have ... changed/added/removed/set/updated/renamed"
  /\bI('ve| have)\b[^.!?\n]*\b(set|changed|added|removed|updated|renamed|deleted|created|inserted|switched|adjusted|reduced|raised|moved)\b/i,
  // English: "X has been ..."
  /\bhas been\b[^.!?\n]*\b(set|changed|added|removed|updated|renamed|deleted|created|inserted|switched|adjusted)\b/i
];

function containsActionClaim(text) {
  if (!text || typeof text !== 'string') return false;
  // Skip very short replies — "Hi.", "Yes.", etc. can't credibly be a lie
  if (text.trim().length < 30) return false;
  for (const re of ACTION_CLAIM_PATTERNS) {
    if (re.test(text)) return true;
  }
  return false;
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
 * `pendingSteps` is a shared mutable array carrying step-id information for
 * steps created earlier in the same chat turn — so add_edge can resolve refs
 * that point at a step the model just created via add_step.
 *
 * `turnContext.pendingPlanId` carries the id of a plan created earlier in
 * this turn via create_plan. Subsequent add_step / update_step / add_edge /
 * etc. in the same turn must target that plan, not the workspace's stale
 * currentPlanId (which only updates client-side after the whole batch
 * applies). Without this, "create a plan and add 5 steps" silently routes
 * the steps to the previously-active plan, or fails with "no active plan".
 */
function mapToolToCommand(name, args, snapshot, fullWorkspace, pendingSteps = [], turnContext = {}) {
  // Resolve the active plan id, preferring the one just created in this turn
  // over the workspace's stale currentPlanId.
  const activePlanId = turnContext.pendingPlanId || fullWorkspace.currentPlanId || null;
  // Build the alias map once per call. Cheap; few dozen entries at most. We
  // prefer the active plan (turn-local or workspace-current) over a strict
  // currentPlanId lookup so step-ref resolution works inside the same turn
  // that created the plan.
  const currentPlan = activePlanId
    ? (fullWorkspace.plans || []).find(p => p.id === activePlanId) || null
    : null;
  const aliases = buildStepAliasMap(currentPlan, pendingSteps);

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
      // First pass: stamp every step with a real id, register it in
      // pendingSteps so subsequent tool calls (and internal edge resolution
      // below) can find it by the slug/title the model originally used.
      const steps = (args.steps || []).map(s => {
        const realId = s.id && /^step_/.test(s.id) ? s.id : newId('step');
        pendingSteps.push({
          realId,
          requestedSlug: s.id || null,  // model's intended slug, if any
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
      // Rebuild alias map now that the new steps are registered.
      const localAliases = buildStepAliasMap(currentPlan, pendingSteps);
      // Second pass: resolve every edge's source/target. Skip silently-broken
      // edges instead of failing the whole plan — a partial plan is better
      // than no plan when participants are watching.
      const edges = [];
      const droppedEdges = [];
      for (const e of (args.edges || [])) {
        const src = resolveStepRef(e.source, localAliases);
        const tgt = resolveStepRef(e.target, localAliases);
        if (src && tgt) {
          edges.push({ id: newId('edge'), source: src, target: tgt });
        } else {
          droppedEdges.push({ source: e.source, target: e.target, srcOk: !!src, tgtOk: !!tgt });
        }
      }
      const mutexGroups = (args.mutexGroups || []).map(g => ({
        id: newId('mutex'), label: g.label || '',
        stepIds: (g.stepIds || []).map(id => resolveStepRef(id, localAliases)).filter(Boolean)
      })).filter(g => g.stepIds.length >= 2);
      if (droppedEdges.length) {
        console.warn('[chat-engine] create_plan: dropped', droppedEdges.length, 'unresolvable edge(s):', droppedEdges);
      }
      // Mark this plan as the in-turn active one so subsequent add_step etc.
      // route to it. The client only updates its currentPlanId after the
      // whole batch applies, so without this the new plan would be invisible
      // to the rest of this turn's tool calls.
      turnContext.pendingPlanId = planId;
      return {
        ok: true, planId, stepIds: steps.map(s => s.id),
        message: `Created plan "${args.label}" with ${steps.length} steps`
          + (droppedEdges.length ? ` (${droppedEdges.length} edge(s) skipped: referenced unknown steps)` : ''),
        droppedEdges: droppedEdges.length || undefined,
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
      // Register this step BEFORE resolving after/before refs — covers the
      // odd case where the model passes the just-created step's title as
      // afterStepId, and lets later tool calls in this turn reference it.
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
      // Auto-wire the new step into the plan's flow. afterStepId/beforeStepId
      // may be a real id, a slug, or a title; resolve against the alias map
      // (which now includes this step + any earlier ones from this turn).
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
          warnings.push(`afterStepId "${args.afterStepId}" did not match any step — edge skipped`);
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
          warnings.push(`beforeStepId "${args.beforeStepId}" did not match any step — edge skipped`);
        }
      }
      return {
        ok: true, stepId,
        message: `Added step "${args.title}"`
          + (warnings.length ? ` (${warnings.join('; ')})` : ''),
        warnings: warnings.length ? warnings : undefined,
        commands
      };
    }
    case 'update_step': {
      const currentPlanId = activePlanId;
      if (!currentPlanId) return { error: 'No active plan' };
      const resolvedId = resolveStepRef(args.stepId, aliases);
      if (!resolvedId) {
        const known = (currentPlan?.steps || []).map(s => s.id).join(', ');
        return { error: `update_step: step "${args.stepId}" not found. Known step ids: ${known || '(none)'}` };
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
        return { error: `remove_step: step "${args.stepId}" not found. Known step ids: ${known || '(none)'}` };
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
        // Return a tool-level error so Gemini sees it in the functionResponse
        // and can correct itself in the same turn (rather than the whole
        // batch dying on the client at apply time).
        const known = (currentPlan?.steps || [])
          .map(s => `${s.id} ("${s.title}")`)
          .concat(pendingSteps.map(p => `${p.realId} ("${p.title || p.requestedSlug || ''}") [created this turn]`))
          .join(', ');
        const what = !src && !tgt ? `source "${args.source}" and target "${args.target}"`
                   : !src ? `source "${args.source}"`
                   : `target "${args.target}"`;
        return {
          error: `add_edge: ${what} did not match any step in the current plan. ` +
                 `Use exact step ids (not titles, not slugs). Known steps: ${known || '(none)'}. ` +
                 `If you intended to reference a step you created earlier in this turn via add_step, ` +
                 `the server assigned it a real id starting with "step_" — use that.`
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
      // Keep the in-turn context consistent so subsequent tool calls target
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
