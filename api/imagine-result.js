/**
 * POST /api/imagine-result
 *
 * Source photo + Soll-JSON → generated image showing the target state.
 *
 * Body:
 *   {
 *     file: { name, mimeType, data },              // base64 source image (the real photo)
 *     soll: <target-state structured description>,
 *     previousRendering?: { mimeType, data }       // optional: previous generated image for refinement passes
 *   }
 *
 * Returns:
 *   { image: 'data:image/png;base64,...', text: string }
 *
 * Calls Gemini 2.5 Flash Image (Nano Banana). The source photo is always
 * passed as the primary visual anchor — the real artefact's identity,
 * materials, and photographic setting come from there. The Soll-JSON
 * describes the target state.
 *
 * When `previousRendering` is supplied (i.e. this is a refinement of an
 * earlier generation rather than a fresh render), it goes in as a second
 * reference image so the model can preserve the stable visual elements of
 * the previous version while applying the change described in the
 * (modified) Soll-JSON.
 */

import { callGeminiImage } from './_shared/gemini.js';

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { file, soll, previousRendering } = req.body || {};
    if (!file?.data || !file?.mimeType) {
      return res.status(400).json({ error: 'file with data and mimeType is required' });
    }
    if (!soll?.subject || !soll?.scene) {
      return res.status(400).json({ error: 'soll must include subject and scene' });
    }

    const isRefinement = !!(previousRendering?.data && previousRendering?.mimeType);

    // Build the prompt
    const prompt = buildPrompt(soll, isRefinement);

    // Refinement passes use ONLY the previous rendering as the reference.
    // Sending both the original source photo and the previous rendering
    // produced confusing outputs (the model couldn't tell which to anchor
    // on and would interpolate between them). Single-reference is clearer:
    // the user iteratively works on the latest state, and if they want to
    // revisit an earlier version they can re-select it via the thumbnail
    // strip.
    const files = isRefinement
      ? [{ name: 'previous_rendering', mimeType: previousRendering.mimeType, data: previousRendering.data }]
      : [file];

    const result = await callGeminiImage({
      prompt,
      files
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
function buildPrompt(soll, isRefinement = false) {
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

  const intro = isRefinement
    ? `The provided reference image shows the CURRENT version of the artefact. Generate a new photograph that preserves this image's composition, background, lighting, angle, materials, and overall character — but applies the changes described below. Only modify what is explicitly different in the description; everything else should remain as in the reference.`
    : `Generate a photograph showing the artefact described below. The provided source image is a visual reference for the artefact's identity, materials, and the photographic setting; render the artefact in the state described here.`;

  return `${intro}

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
