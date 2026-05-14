/**
 * Gemini API client.
 *
 * Single place to talk to Gemini. Both endpoints (propose, chat) go through
 * here. Centralized error handling, JSON unwrapping, multimodal support.
 */

const DEFAULT_MODEL = 'gemini-2.5-flash';

export async function callGemini({ systemPrompt, userPayload, files = [], model, temperature = 0.4 }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not configured on the server');

  const m = model || DEFAULT_MODEL;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${apiKey}`;

  const parts = [];
  if (systemPrompt) parts.push({ text: systemPrompt });
  parts.push({ text: typeof userPayload === 'string' ? userPayload : JSON.stringify(userPayload, null, 2) });
  for (const f of (files || [])) {
    if (f.data && f.mimeType) {
      parts.push({ inline_data: { mime_type: f.mimeType, data: f.data } });
    }
  }

  const body = {
    contents: [{ parts }],
    generationConfig: { responseMimeType: 'application/json', temperature, maxOutputTokens: 8192 }
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini ${res.status}: ${errText.slice(0, 400)}`);
  }

  const json = await res.json();
  const text = json?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
  if (!text) throw new Error('Gemini returned an empty response');

  try {
    return JSON.parse(text);
  } catch (err) {
    const match = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (match) return JSON.parse(match[0]);
    throw new Error(`Could not parse JSON from model: ${text.slice(0, 200)}`);
  }
}
