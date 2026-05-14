/**
 * Gemini API client.
 *
 * Single place to talk to Gemini. Both endpoints (propose, chat) go through
 * here. Centralized error handling, JSON unwrapping, multimodal support.
 */

const DEFAULT_MODEL = 'gemini-2.5-flash';

export async function callGemini({ systemPrompt, userPayload, files = [], model, temperature = 0.4, maxOutputTokens }) {
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
    generationConfig: {
      responseMimeType: 'application/json',
      temperature,
      // Default was 8192, too small for plan generation. Bumped to 32k —
      // Gemini 2.5 supports up to 65k. Callers can override.
      maxOutputTokens: maxOutputTokens || 32768
    }
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
  const candidate = json?.candidates?.[0];
  const finishReason = candidate?.finishReason;
  const text = candidate?.content?.parts?.map(p => p.text || '').join('') || '';
  if (!text) throw new Error('Gemini returned an empty response');

  // Try strict parse first
  try {
    return JSON.parse(text);
  } catch (err) {
    // Try common repairs before giving up
    const repaired = tryRepairJson(text);
    if (repaired) return repaired;

    // Detailed diagnostics for debugging
    const reason = finishReason ? ` (finishReason=${finishReason})` : '';
    const head = text.slice(0, 200).replace(/\s+/g, ' ');
    const tail = text.slice(-200).replace(/\s+/g, ' ');
    const len = text.length;
    console.error('[gemini] JSON parse failed', err.message, reason, `len=${len}`);
    console.error('[gemini] head:', head);
    console.error('[gemini] tail:', tail);
    throw new Error(
      `Model returned malformed JSON${reason}. Length=${len}. ` +
      `Error: ${err.message}. ` +
      (finishReason === 'MAX_TOKENS'
        ? 'Output was truncated by token limit — try a simpler request or raise maxOutputTokens.'
        : 'See server logs for full response head/tail.')
    );
  }
}

/**
 * Attempt to repair common malformations in JSON output from LLMs.
 * Returns the parsed object on success, or null if not recoverable.
 *
 * Repairs attempted, in order:
 *  1. Strip markdown code fences (```json ... ```)
 *  2. Extract the outermost {...} or [...]
 *  3. Remove trailing commas before ] or }
 *  4. Close unterminated strings, arrays, and objects at the end
 */
function tryRepairJson(text) {
  let s = String(text).trim();

  // 1. Strip markdown fences
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');

  // 2. Extract outermost JSON value if there's prose around it
  const firstBrace = s.search(/[\{\[]/);
  if (firstBrace > 0) s = s.slice(firstBrace);
  const lastBrace = Math.max(s.lastIndexOf('}'), s.lastIndexOf(']'));
  if (lastBrace >= 0 && lastBrace < s.length - 1) s = s.slice(0, lastBrace + 1);

  // Try parse after these basic cleanups
  try { return JSON.parse(s); } catch (_) {}

  // 3. Remove trailing commas
  const noTrailing = s.replace(/,(\s*[\]\}])/g, '$1');
  try { return JSON.parse(noTrailing); } catch (_) {}

  // 4. Best-effort close of unterminated structures.
  //    Walk through tracking string state and brace stack.
  const repaired = balanceBraces(noTrailing);
  if (repaired !== noTrailing) {
    try { return JSON.parse(repaired); } catch (_) {}
  }
  return null;
}

function balanceBraces(s) {
  const stack = [];
  let inStr = false;
  let escape = false;
  let lastCommaBeforeBreak = -1;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (escape) { escape = false; continue; }
    if (c === '\\' && inStr) { escape = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{' || c === '[') stack.push(c);
    else if (c === '}' || c === ']') stack.pop();
    if (c === ',') lastCommaBeforeBreak = i;
  }

  // Truncate at the last well-formed comma to drop a partial trailing element
  let out = s;
  if (inStr) {
    if (lastCommaBeforeBreak >= 0) {
      // Cut off the partial trailing element entirely (drop everything after
      // the last comma) and we'll re-balance after.
      out = out.slice(0, lastCommaBeforeBreak);
    } else {
      // No comma to fall back to — just terminate the unterminated string
      // by appending a closing quote. The value may be cut off but at least
      // parseable.
      out = out + '"';
    }
    // Recompute stack
    const tmp = [];
    let ins = false, esc = false;
    for (let i = 0; i < out.length; i++) {
      const c = out[i];
      if (esc) { esc = false; continue; }
      if (c === '\\' && ins) { esc = true; continue; }
      if (c === '"') { ins = !ins; continue; }
      if (ins) continue;
      if (c === '{' || c === '[') tmp.push(c);
      else if (c === '}' || c === ']') tmp.pop();
    }
    stack.length = 0;
    stack.push(...tmp);
  }

  // Close everything left on the stack
  while (stack.length) {
    const open = stack.pop();
    out += (open === '{' ? '}' : ']');
  }
  return out;
}
