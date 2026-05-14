/**
 * POST /api/imagine-result
 *
 * Source photo + Soll-JSON → generated image showing the target state.
 *
 * Body:
 *   {
 *     file: { name, mimeType, data },   // base64 source image
 *     soll: <target-state structured description>
 *   }
 *
 * Returns:
 *   { image: 'data:image/png;base64,...', text: string }
 *
 * Calls Gemini 2.5 Flash Image (Nano Banana) with the source image as
 * visual anchor and the Soll-JSON as the structural target spec. The
 * model produces a new image that follows the Soll-JSON description
 * while staying visually consistent with the source for everything
 * that hasn't changed.
 */

import { callGeminiImage } from './_shared/gemini.js';

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { file, soll } = req.body || {};
    if (!file?.data || !file?.mimeType) {
      return res.status(400).json({ error: 'file with data and mimeType is required' });
    }
    if (!soll?.subject || !soll?.scene) {
      return res.status(400).json({ error: 'soll must include subject and scene' });
    }

    // Format the Soll-JSON as a clear edit instruction
    const prompt = buildPrompt(soll);

    const result = await callGeminiImage({
      prompt,
      files: [file]
    });

    return res.status(200).json({
      image: result.image,
      text: result.text || ''
    });
  } catch (err) {
    console.error('[imagine-result] error:', err);
    return res.status(500).json({ error: err.message });
  }
}

/**
 * Build the prompt for Nano Banana from the Soll-JSON.
 *
 * We give the model the source image as visual reference and then describe
 * exactly what the OUTPUT image should show, using the Soll-JSON as the
 * specification. We emphasize preservation of scene elements explicitly,
 * since the model's natural tendency is to re-render everything.
 */
function buildPrompt(soll) {
  const { subject, scene } = soll;
  const partsList = (subject.parts || []).map(p => {
    if (p.present === false) {
      return `- ${p.name} (${p.id}): REMOVED. ${p.removed_note || 'No longer present in the image.'}`;
    }
    return `- ${p.name} (${p.id}): ${p.condition}${p.geometry ? ` — ${p.geometry}` : ''}`;
  }).join('\n');

  return `Generate a photograph that shows the artefact in the provided source image AFTER the following modifications have been made. The source image is the visual anchor for everything that has NOT changed.

TARGET STATE:
Subject: ${subject.type}
Material: ${subject.material}
Overall: ${subject.overall_condition}

Parts:
${partsList}

PRESERVE FROM THE SOURCE IMAGE (these must remain visually identical):
- Background: ${scene.background}
- Lighting: ${scene.lighting}
- Camera angle: ${scene.angle}
- Framing: ${scene.framing}
- Photographic style: ${scene.style}

Render this as a single high-quality photograph at the same angle, lighting, and background as the source. Show only the final result, no captions, no diagrams, no before/after split — just the artefact in its repaired state.`;
}
