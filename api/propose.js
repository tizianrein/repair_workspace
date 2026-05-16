/**
 * POST /api/propose
 *
 * Body:
 *   {
 *     scope: "assembly" | "hypotheses" | "interventions" | "all",
 *     userMessage: string,
 *     workspace: <current workspace>,
 *     files?: [{ name, mimeType, data: base64 }]
 *   }
 *
 * Returns:
 *   { summary: string, commands: [...] }
 *
 * The client is expected to display the summary, show the user the proposed
 * commands, and apply them on confirmation. The endpoint does not mutate
 * anything itself.
 */

import { callGemini } from './_shared/gemini.js';
import { loadPrompt } from './_shared/prompts.js';

export const config = { maxDuration: 60 };

// Set of command types the workspace's command registry actually understands.
// Kept in sync with src/core/commands.js — when adding a new command there,
// add the type string here too. If the AI returns anything else, we strip it
// from the response and surface the rejected types to the user.
const KNOWN_COMMAND_TYPES = new Set([
  'set-object-name',
  'upsert-part', 'remove-part', 'replace-assembly',
  'add-hypothesis', 'update-hypothesis', 'remove-hypothesis',
  'confirm-hypothesis', 'refute-hypothesis',
  'add-evidence', 'remove-evidence',
  'set-intent', 'set-constraints',
  'add-plan', 'remove-plan', 'set-current-plan', 'set-plan-status',
  'upsert-step', 'remove-step',
  'add-edge', 'remove-edge',
  'add-mutex-group', 'remove-mutex-group', 'select-mutex-branch',
  'log-execution', 'remove-execution',
  'start-conversation', 'remove-conversation',
  'noop'
]);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { scope, userMessage, workspace, files } = req.body || {};
    if (!scope) return res.status(400).json({ error: 'scope is required' });
    if (!userMessage) return res.status(400).json({ error: 'userMessage is required' });
    if (!workspace) return res.status(400).json({ error: 'workspace is required' });

    const systemPrompt = loadPrompt('propose');

    const userPayload = {
      scope,
      userMessage,
      workspace: redactWorkspace(workspace)
    };

    const result = await callGemini({
      systemPrompt,
      userPayload,
      files: files || [],
      model: scope === 'assembly' ? 'gemini-2.5-pro' : 'gemini-2.5-flash',
      temperature: 0.4
    });

    if (!result || typeof result !== 'object') {
      return res.status(502).json({ error: 'Model returned non-object', raw: result });
    }
    if (!Array.isArray(result.commands)) {
      return res.status(502).json({ error: 'Model returned no commands array', raw: result });
    }

    // Build a set of valid part ids from the workspace so we can validate
    // partRef on add-hypothesis. Used by the fan-out logic below.
    const validPartIds = new Set((workspace.instance?.parts || []).map(p => p.id));

    // Filter out commands with unknown types so they never make it to the
    // accept-modal-then-fail path. Surface the rejected types so the user
    // (and we, in logs) can see what the AI tried.
    const known = [];
    const rejected = [];
    const malformed = [];
    const fannedOut = [];   // Note user-facing: "expanded 1 command into N"
    for (const cmd of result.commands) {
      if (!cmd || typeof cmd !== 'object' || !KNOWN_COMMAND_TYPES.has(cmd.type)) {
        rejected.push(cmd?.type || '(missing type)');
        continue;
      }
      // Validate command payloads that frequently come back malformed from
      // the model. We drop the bad command but keep the rest of the batch,
      // surfacing the issue in the summary so the user knows the result is
      // partial. This is far better than killing the whole batch and
      // forcing the user to retry the entire propose.
      if (cmd.type === 'add-edge') {
        const p = cmd.payload || {};
        if (!p.source || !p.target || !p.planId) {
          malformed.push(`add-edge (source="${p.source}", target="${p.target}")`);
          continue;
        }
      }
      if (cmd.type === 'add-mutex-group') {
        const p = cmd.payload || {};
        if (!Array.isArray(p.stepIds) || p.stepIds.length < 2 || !p.planId) {
          malformed.push(`add-mutex-group (stepIds=${JSON.stringify(p.stepIds)})`);
          continue;
        }
      }
      if (cmd.type === 'upsert-step') {
        const p = cmd.payload || {};
        if (!p.planId || !p.step || !p.step.id) {
          malformed.push(`upsert-step (planId="${p.planId}", step.id="${p.step?.id}")`);
          continue;
        }
      }
      // add-hypothesis: the model occasionally collapses "condition applies
      // to many parts" into a single command with partRef like
      // "back_left_leg,back_right_leg,..." or an array, even though the
      // prompt forbids it. Detect and fan out — one hypothesis per part —
      // so the UI renders them correctly. Drop unrecognised refs.
      if (cmd.type === 'add-hypothesis') {
        const h = cmd.payload?.hypothesis;
        if (!h) {
          malformed.push('add-hypothesis (missing hypothesis payload)');
          continue;
        }
        const refs = expandPartRef(h.partRef, validPartIds);
        if (refs.length === 0) {
          // The model gave us a partRef that doesn't match any known part.
          // Don't silently drop — keep the hypothesis with whatever ref it
          // had so the user can fix it in the detail editor. The existing
          // behaviour for unmatched refs.
          known.push(cmd);
          continue;
        }
        if (refs.length === 1 && refs[0] === h.partRef) {
          // Already well-formed, no fan-out needed.
          known.push(cmd);
          continue;
        }
        // Fan out: one add-hypothesis per resolved partRef. Each gets its
        // own hypothesis object so the runtime command (which generates
        // a fresh id) produces distinct entities.
        for (const partId of refs) {
          known.push({
            type: 'add-hypothesis',
            payload: { hypothesis: { ...h, partRef: partId } }
          });
        }
        fannedOut.push(`condition "${h.description || h.type}" → ${refs.length} parts`);
        continue;
      }
      known.push(cmd);
    }
    if (rejected.length) {
      console.warn('[propose] Filtered unknown command types:', rejected);
      const note = ` (Skipped ${rejected.length} unsupported command${rejected.length === 1 ? '' : 's'}: ${rejected.join(', ')}.)`;
      result.summary = (result.summary || '') + note;
    }
    if (malformed.length) {
      console.warn('[propose] Filtered malformed commands:', malformed);
      const note = ` (Skipped ${malformed.length} malformed command${malformed.length === 1 ? '' : 's'}: ${malformed.join('; ')}.)`;
      result.summary = (result.summary || '') + note;
    }
    if (fannedOut.length) {
      console.info('[propose] Fanned out multi-part hypotheses:', fannedOut);
      const note = ` (Expanded ${fannedOut.length === 1 ? 'a' : fannedOut.length} multi-part condition${fannedOut.length === 1 ? '' : 's'} into per-part entries: ${fannedOut.join('; ')}.)`;
      result.summary = (result.summary || '') + note;
    }
    result.commands = known;

    return res.status(200).json(result);
  } catch (err) {
    console.error('[propose] error:', err);
    return res.status(500).json({ error: err.message });
  }
}

function redactWorkspace(ws) {
  return {
    schemaVersion: ws.schemaVersion,
    instance: { ...ws.instance },
    hypotheses: ws.hypotheses || [],
    intent: ws.intent,
    constraints: ws.constraints,
    plans: (ws.plans || []).map(p => ({
      id: p.id, label: p.label, status: p.status,
      steps: (p.steps || []).map(s => ({
        id: s.id, title: s.title, status: s.status,
        affectedPartRefs: s.affectedPartRefs, addressesHypothesisRefs: s.addressesHypothesisRefs
      })),
      edges: p.edges, mutexGroups: p.mutexGroups
    })),
    currentPlanId: ws.currentPlanId
  };
}

/**
 * Resolve a partRef coming from the model into a list of valid part ids.
 * Handles three malformations the model commits when collapsing a
 * many-parts request into one command:
 *
 *   - "part_a,part_b,part_c"   (comma-separated string)
 *   - ["part_a", "part_b"]     (array)
 *   - "all" / "all_parts" / "*"  (meta-token)
 *
 * Plus the well-formed case (a single id matching a known part). Returns
 * an array of part ids that exist in the workspace; unknown ids are
 * dropped. Empty array signals "couldn't resolve anything sensible".
 */
function expandPartRef(partRef, validPartIds) {
  if (partRef == null) return [];
  if (Array.isArray(partRef)) {
    return partRef.filter(p => typeof p === 'string' && validPartIds.has(p));
  }
  if (typeof partRef !== 'string') return [];
  const trimmed = partRef.trim();
  if (!trimmed) return [];
  // "all" / "every part" / "*": fan to every part in the workspace.
  if (/^(all|all[_-]parts|every[_-]?part|\*)$/i.test(trimmed)) {
    return [...validPartIds];
  }
  // Comma-separated list — most common malformation we observed.
  if (trimmed.includes(',')) {
    const parts = trimmed.split(',').map(s => s.trim()).filter(Boolean);
    const valid = parts.filter(p => validPartIds.has(p));
    return valid;
  }
  // Plain single ref. Return as a single-item array if it matches a
  // real part; if not, return the original string anyway so the
  // unmatched-ref path keeps it for the user to fix in the detail editor.
  if (validPartIds.has(trimmed)) return [trimmed];
  return [];
}
