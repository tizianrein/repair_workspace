/**
 * POST /api/chat
 *
 * Conversational endpoint. The AI uses function calling to act directly
 * on the workspace while replying. Server runs the multi-turn tool loop
 * to completion, then returns:
 *
 *   {
 *     reply: string,                  // The AI's text reply
 *     commands: [{ type, payload }],  // Workspace commands to apply
 *     toolCalls: [{ name, args, result }],  // Trace
 *     plannedSummary: string          // Short label of what was done
 *   }
 *
 * Streaming (text + commands arriving live) is a planned future variant
 * that will reuse the same chat-engine module — see _shared/chat-engine.js.
 */

import { runChat } from './_shared/chat-engine.js';

export const config = { maxDuration: 90 };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { thread, userMessage, workspace, files } = req.body || {};
    if (!userMessage) return res.status(400).json({ error: 'userMessage is required' });
    if (!workspace) return res.status(400).json({ error: 'workspace is required' });

    const result = await runChat({ thread, userMessage, workspace, files });
    return res.status(200).json(result);
  } catch (err) {
    console.error('[chat] error:', err);
    return res.status(500).json({ error: err.message });
  }
}
