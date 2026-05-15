/**
 * POST /api/modify-target-json
 *
 * Iterative refinement of an existing Soll-JSON based on a short user
 * instruction. Used by the "Refine" flow under Imagined Result.
 *
 * The user has already generated an image once. Now they want to make a
 * small change ("make the legs darker", "swap the cushion for green wool").
 * Rather than re-running the full pipeline (which would re-derive the
 * Ist-JSON and Soll-JSON from scratch, producing a potentially completely
 * different image), we apply a targeted edit to the existing Soll-JSON.
 *
 * Input:
 *   {
 *     currentSoll: <the existing Soll-JSON>,
 *     userInstruction: "make the legs darker",
 *     workspace: <full workspace state>      // for intent context
 *   }
 *
 * Output:
 *   {
 *     soll: <modified Soll-JSON, same shape as input>,
 *     rationale: "2-3 sentences explaining what was changed and why"
 *   }
 *
 * Uses gemini-2.5-flash — small structured edits are well within its
 * capability, and the input is small so it's fast.
 */

import { callGemini } from './_shared/gemini.js';
import { loadPrompt } from './_shared/prompts.js';

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { currentSoll, userInstruction, workspace } = req.body || {};
    if (!currentSoll) return res.status(400).json({ error: 'currentSoll is required' });
    if (!userInstruction) return res.status(400).json({ error: 'userInstruction is required' });

    const systemPrompt = loadPrompt('modify-target-json');

    const userPayload = {
      currentSoll,
      userInstruction,
      intent: workspace?.intent,
      constraints: workspace?.constraints
    };

    const result = await callGemini({
      systemPrompt,
      userPayload,
      model: 'gemini-2.5-flash',
      temperature: 0.3,
      maxOutputTokens: 8192
    });

    if (!result || typeof result !== 'object') {
      return res.status(502).json({ error: 'Model returned non-object', raw: result });
    }
    if (!result.soll || typeof result.soll !== 'object') {
      return res.status(502).json({ error: 'Model returned no soll object', raw: result });
    }

    return res.status(200).json({
      soll: result.soll,
      rationale: typeof result.rationale === 'string' ? result.rationale : ''
    });
  } catch (err) {
    console.error('[modify-target-json] error:', err);
    return res.status(500).json({ error: err.message });
  }
}
