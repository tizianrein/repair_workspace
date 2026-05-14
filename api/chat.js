/**
 * POST /api/chat
 *
 * Body:
 *   {
 *     thread: { scope, ref, messages: [{ role, content }] },
 *     userMessage: string,
 *     workspace: <current workspace>,
 *     files?: [{ name, mimeType, data }]
 *   }
 *
 * Returns:
 *   { reply: string, suggestedAction: string|null, uncertainty: string[] }
 *
 * The chat endpoint never mutates state. To turn a chat suggestion into a
 * change, the client calls /api/propose separately.
 */

import { callGemini } from './_shared/gemini.js';
import { loadPrompt } from './_shared/prompts.js';

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { thread, userMessage, workspace, files } = req.body || {};
    if (!userMessage) return res.status(400).json({ error: 'userMessage is required' });
    if (!workspace) return res.status(400).json({ error: 'workspace is required' });

    const systemPrompt = loadPrompt('chat');

    const scopedContext = buildScopedContext(workspace, thread);

    const userPayload = {
      scope: thread?.scope || 'global',
      ref: thread?.ref || null,
      scopedContext,
      history: (thread?.messages || []).slice(-12).map(m => ({ role: m.role, content: m.content })),
      newUserMessage: userMessage
    };

    const result = await callGemini({
      systemPrompt,
      userPayload,
      files: files || [],
      model: 'gemini-2.5-flash',
      temperature: 0.5
    });

    if (!result || typeof result.reply !== 'string') {
      return res.status(502).json({ error: 'Model returned malformed reply', raw: result });
    }

    return res.status(200).json({
      reply: result.reply,
      suggestedAction: result.suggestedAction ?? null,
      uncertainty: Array.isArray(result.uncertainty) ? result.uncertainty : []
    });
  } catch (err) {
    console.error('[chat] error:', err);
    return res.status(500).json({ error: err.message });
  }
}

function buildScopedContext(ws, thread) {
  const scope = thread?.scope || 'global';
  const ref = thread?.ref;
  const ctx = { instanceName: ws.instance?.name };

  if (scope === 'part' && ref) {
    ctx.part = (ws.instance?.parts || []).find(p => p.id === ref) || null;
    ctx.hypothesesOnPart = (ws.hypotheses || []).filter(h => h.partRef === ref);
  } else if (scope === 'hypothesis' && ref) {
    ctx.hypothesis = (ws.hypotheses || []).find(h => h.id === ref) || null;
    if (ctx.hypothesis) ctx.part = (ws.instance?.parts || []).find(p => p.id === ctx.hypothesis.partRef) || null;
  } else if (scope === 'step' && ref) {
    const plan = (ws.plans || []).find(p => p.id === ws.currentPlanId);
    ctx.step = plan?.steps?.find(s => s.id === ref) || null;
    if (ctx.step) {
      ctx.affectedParts = (ctx.step.affectedPartRefs || []).map(pid =>
        (ws.instance?.parts || []).find(p => p.id === pid)).filter(Boolean);
      ctx.addressedHypotheses = (ctx.step.addressesHypothesisRefs || []).map(hid =>
        (ws.hypotheses || []).find(h => h.id === hid)).filter(Boolean);
    }
  } else {
    ctx.partCount = (ws.instance?.parts || []).length;
    ctx.hypothesisCount = (ws.hypotheses || []).length;
    ctx.suspectedCount = (ws.hypotheses || []).filter(h => h.status === 'suspected').length;
    ctx.intent = ws.intent;
    ctx.constraints = ws.constraints;
  }
  return ctx;
}
