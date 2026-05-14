/**
 * POST /api/describe-photo
 *
 * Photo in → structured Ist-JSON out.
 *
 * Body:
 *   {
 *     file: { name, mimeType, data },         // base64 image
 *     workspace?: <workspace state>           // optional: name hints
 *   }
 *
 * Returns:
 *   { ist: <structured description object> }
 *
 * The Ist-JSON describes the FULL current scene as the model sees it —
 * subject parts with conditions, scene context. Not a list of changes.
 * Acts as the canonical "what's in this photo" representation that the
 * next step (synthesize-target-json) modifies to produce the Soll-JSON.
 */

import { callGemini } from './_shared/gemini.js';

export const config = { maxDuration: 45 };

const SYSTEM_PROMPT = `You are an expert at describing physical artefacts for the purpose of structured image editing.

Given a photo, you produce a JSON object describing the CURRENT state of the scene as you see it. This JSON will later be modified by a planner and sent back to an image-generation model. The image model needs your description to faithfully reproduce everything in the photo that should NOT change.

Output STRICT JSON in this exact shape:

{
  "subject": {
    "type": "what kind of object this is, in 2-5 words",
    "material": "main materials and finish, including color/tone",
    "overall_condition": "1-2 sentences summary of state",
    "parts": [
      {
        "id": "snake_case_identifier",
        "name": "human-readable name",
        "present": true,
        "geometry": "brief shape/proportions description",
        "condition": "specific condition and damages visible on this part, including locations"
      }
      // List every distinct part you can identify. Be thorough.
    ]
  },
  "scene": {
    "background": "describe the background as if for a painter",
    "lighting": "direction, softness, color temperature, shadows",
    "angle": "camera perspective relative to the subject",
    "framing": "how the subject is positioned in the frame",
    "style": "photographic style — studio, casual, documentary, etc."
  }
}

CRITICAL rules:
- Describe what you SEE, not what you assume. If you cannot tell whether something is present, omit it.
- Be specific about locations of damage ("upper left of the seat", "near the joint with the right leg").
- The "scene" fields define what must stay constant when the image is re-rendered. Be precise about lighting and background so they can be preserved.
- Use the same level of detail as a conservator would in a condition report — descriptive, factual, no judgement.
- Do not add fields not listed above. Do not add commentary outside the JSON.`;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { file, workspace } = req.body || {};
    if (!file?.data || !file?.mimeType) {
      return res.status(400).json({ error: 'file with data and mimeType is required' });
    }

    // Optional hint from the workspace — gives the model a starting vocabulary
    const hint = workspace?.instance?.name
      ? `\nHint: this artefact is identified in our system as "${workspace.instance.name}". Use that knowledge to inform your part naming, but describe ONLY what you see in the photo.`
      : '';

    const result = await callGemini({
      systemPrompt: SYSTEM_PROMPT + hint,
      userPayload: 'Describe the artefact in this photo according to the schema above.',
      files: [file],
      model: 'gemini-2.5-flash',
      temperature: 0.2,
      maxOutputTokens: 4096
    });

    if (!result?.subject || !result?.scene) {
      return res.status(502).json({ error: 'Model returned malformed Ist-JSON', raw: result });
    }

    return res.status(200).json({ ist: result });
  } catch (err) {
    console.error('[describe-photo] error:', err);
    return res.status(500).json({ error: err.message });
  }
}
