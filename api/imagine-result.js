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
 * The Soll-JSON is the canonical specification of the target state. The
 * prompt translates it into descriptive prose that the image model can
 * follow. We do not embed any repair strategy or interpretation — the
 * Soll already encodes those decisions. The prompt's only opinion is that
 * scene-level fields (lighting, angle, background) should match the
 * source photo, since those are explicitly marked as preserved.
 */
function buildPrompt(soll) {
  const { subject, scene } = soll;

  // Parts present in the target — describe them as the Soll says.
  const presentParts = (subject.parts || []).filter(p => p.present !== false);
  const removedParts = (subject.parts || []).filter(p => p.present === false);

  const presentList = presentParts.length
    ? presentParts.map(p => {
        const bits = [];
        if (p.geometry) bits.push(p.geometry);
        if (p.condition) bits.push(p.condition);
        return `- ${p.name}: ${bits.join('; ') || 'as in source'}`;
      }).join('\n')
    : '(no parts listed)';

  const removedList = removedParts.length
    ? removedParts.map(p => `- ${p.name}${p.removed_note ? ` — ${p.removed_note}` : ''}`).join('\n')
    : '';

  const removedSection = removedList
    ? `\n\nPARTS THAT ARE NO LONGER PRESENT IN THE OUTPUT IMAGE:\n${removedList}`
    : '';

  return `Generate a photograph showing the artefact described below. The provided source image is a visual reference for the artefact's identity, materials, and the photographic setting; render the artefact in the state described here.

THE ARTEFACT TO SHOW:
${subject.type}
Material and finish: ${subject.material}
Overall: ${subject.overall_condition}

PARTS AND THEIR APPEARANCE:
${presentList}${removedSection}

PHOTOGRAPHIC SETTING (match the source image):
- Background: ${scene.background}
- Lighting: ${scene.lighting}
- Camera angle: ${scene.angle}
- Framing: ${scene.framing}
- Style: ${scene.style}

Render a single photograph. No captions, no diagrams, no before/after split, no labels.`;
}
