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
