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

    // Filter out commands with unknown types so they never make it to the
    // accept-modal-then-fail path. Surface the rejected types so the user
    // (and we, in logs) can see what the AI tried.
    const known = [];
    const rejected = [];
    for (const cmd of result.commands) {
      if (cmd && typeof cmd === 'object' && KNOWN_COMMAND_TYPES.has(cmd.type)) {
        known.push(cmd);
      } else {
        rejected.push(cmd?.type || '(missing type)');
      }
    }
    if (rejected.length) {
      console.warn('[propose] Filtered unknown command types:', rejected);
      const note = ` (Skipped ${rejected.length} unsupported command${rejected.length === 1 ? '' : 's'}: ${rejected.join(', ')}.)`;
      result.summary = (result.summary || '') + note;
      result.commands = known;
    }

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
