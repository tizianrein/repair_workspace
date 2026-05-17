/**
 * Gemini API client.
 *
 * Single place to talk to Gemini. Both endpoints (propose, chat) go through
 * here. Centralized error handling, JSON unwrapping, multimodal support.
 *
 * Model strategy: we prefer gemini-2.5-pro for chat (much better tool-call
 * compliance — far fewer hallucinated step ids, far less "tool_code" text
 * output) and fall back to gemini-2.5-flash automatically on quota errors.
 * Callers can override per-call via the `model` param.
 */

const DEFAULT_MODEL = 'gemini-2.5-flash';
const PREFERRED_CHAT_MODEL = 'gemini-2.5-pro';
const FALLBACK_CHAT_MODEL = 'gemini-2.5-flash';

// ----------------------------------------------------------------------------
// Pro quota cool-down
//
// Vercel serverless functions don't share memory across invocations
// reliably, but within a single warm Lambda instance (which Vercel keeps
// alive for ~15min between requests) module-level state survives. We use
// that to track when Pro most recently 429'd; while we're inside the
// cool-down window we skip Pro entirely and go straight to Flash, sparing
// participants a 5-10s wasted call.
//
// This is best-effort, not perfect. Cold starts reset it. That's fine: the
// fallback path inside each request still catches Pro quota errors live.
// ----------------------------------------------------------------------------

let proCoolDownUntil = 0;
const PRO_COOL_DOWN_MS = 90 * 1000; // 1.5 min after a Pro rate-limit hit

export function isProAvailable() {
  return Date.now() >= proCoolDownUntil;
}
export function tripProCoolDown(reason) {
  proCoolDownUntil = Date.now() + PRO_COOL_DOWN_MS;
  console.warn(`[gemini] Pro cool-down tripped (${reason}); using Flash until`,
    new Date(proCoolDownUntil).toISOString());
}
export function isQuotaError(err) {
  const msg = (err && err.message) || '';
  // Gemini returns 429 with a "RESOURCE_EXHAUSTED" body for both per-minute
  // and per-day quota. Both should fall back.
  return /\b429\b/.test(msg)
    || /RESOURCE_EXHAUSTED/i.test(msg)
    || /quota/i.test(msg)
    || /rate.?limit/i.test(msg);
}
export const PREFERRED_CHAT_MODEL_NAME = PREFERRED_CHAT_MODEL;
export const FALLBACK_CHAT_MODEL_NAME = FALLBACK_CHAT_MODEL;

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

/**
 * Call Gemini with function-calling enabled.
 *
 * Unlike callGemini which forces a JSON response, this variant lets the
 * model freely mix text and tool calls. Used by the conversational chat
 * endpoint so the AI can act on the workspace directly while talking.
 *
 * Multi-turn loop: if the model returns function calls, the caller runs
 * them and feeds the results back as a follow-up message, then asks the
 * model to continue. We do up to maxTurns iterations to allow chained
 * reasoning (e.g. "first add conditions, then create a plan that
 * addresses them").
 *
 * Returns:
 *   {
 *     text: string,            // Final assistant text reply
 *     toolCalls: [{name, args, result}],  // All calls performed, in order
 *     turns: number            // How many model calls were made
 *   }
 */
export async function callGeminiWithTools({
  systemPrompt,
  userMessage,
  history = [],            // Prior {role, parts} turns
  workspaceSnapshot,       // Stringified workspace summary for context
  tools,                   // Array of function declarations
  executeTool,             // async (name, args) => result
  model = 'gemini-2.5-flash',
  temperature = 0.5,
  maxTurns = 8,
  maxOutputTokens = 16384
}) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not configured on the server');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  // Build initial contents. System prompt goes as system_instruction.
  // History is the prior conversation turns. Then we append the user's
  // new message + the workspace snapshot as a single user turn.
  const userParts = [];
  if (workspaceSnapshot) {
    userParts.push({
      text: `Current workspace state:\n\`\`\`json\n${typeof workspaceSnapshot === 'string'
        ? workspaceSnapshot
        : JSON.stringify(workspaceSnapshot, null, 2)}\n\`\`\``
    });
  }
  userParts.push({ text: userMessage });

  const contents = [...history, { role: 'user', parts: userParts }];

  const toolCalls = [];
  let finalText = '';
  let turns = 0;
  let toolCodeLeakDetected = false;

  for (let i = 0; i < maxTurns; i++) {
    turns++;
    const body = {
      contents,
      systemInstruction: systemPrompt ? { parts: [{ text: systemPrompt }] } : undefined,
      tools: tools && tools.length ? [{ functionDeclarations: tools }] : undefined,
      generationConfig: {
        temperature,
        maxOutputTokens
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
    const parts = candidate?.content?.parts || [];

    // If the model was cut off mid-response, surface that clearly to the
    // caller so they can show a useful error to the user instead of a
    // silent empty bubble.
    if (finishReason === 'MAX_TOKENS' && parts.length === 0) {
      throw new Error(
        'The AI hit its output limit before producing anything useful. ' +
        'Try a smaller / more focused request.'
      );
    }
    // MALFORMED_FUNCTION_CALL: the model tried to call a tool but produced
    // junk arguments — usually happens when trying to cram a huge plan
    // into a single create_plan call and running into structural limits.
    if (finishReason === 'MALFORMED_FUNCTION_CALL') {
      throw new Error('MALFORMED_FUNCTION_CALL');
    }

    // Collect text and function calls from this turn
    let turnText = '';
    const turnCalls = [];
    for (const p of parts) {
      if (p.text) turnText += p.text;
      const fc = p.functionCall || p.function_call;
      if (fc) turnCalls.push({ name: fc.name, args: fc.args || {} });
    }

    // Strip "tool_code" leakage. Sometimes (especially on Flash) the model
    // emits its planned tool calls as a Python-like text block instead of
    // structured functionCall parts. The user sees a wall of
    // `tool_code print(default_api.create_plan(...))` text in chat and
    // nothing happens in the workspace. We can't recover the intended
    // calls — the action is lost — but we can at least remove the noise
    // from what the user sees, log a warning, and (later, in the engine)
    // emit a clear fallback message asking the user to retry.
    let toolCodeLeak = false;
    if (turnText && /\b(?:tool_code\b|default_api\.|print\(default_api)/.test(turnText)) {
      toolCodeLeak = true;
      toolCodeLeakDetected = true;
      console.warn('[gemini] detected tool_code leak in text output — stripping. snippet:',
        turnText.slice(0, 200).replace(/\s+/g, ' '));
      turnText = turnText
        // Remove fenced code blocks that look like tool-call dumps
        .replace(/```(?:tool_code|python)?[\s\S]*?```/g, '')
        // Greedy: remove any "default_api.foo(...)" call expressions. Use
        // a balanced-paren matcher up to 8 nesting levels deep — enough
        // for a step's nested arg lists. Anything left is prose.
        .replace(/\bprint\(default_api\.[A-Za-z_]+\([^()]*(?:\([^()]*(?:\([^()]*\)[^()]*)*\)[^()]*)*\)\)/g, '')
        .replace(/\bdefault_api\.[A-Za-z_]+\([^()]*(?:\([^()]*(?:\([^()]*\)[^()]*)*\)[^()]*)*\)/g, '')
        // Remove stray "tool_code" / "thought" stub words that surround
        // such dumps in Gemini's leaked syntax.
        .replace(/\btool_code\b/g, '')
        .replace(/^\s*thought\b[ \t]*/i, '')
        // Whitespace cleanup
        .replace(/\n{3,}/g, '\n\n')
        .replace(/  +/g, ' ')
        .trim();
      // If the leak emptied the text entirely, supply a graceful fallback
      // so the user doesn't see a blank assistant bubble.
      if (!turnText) {
        turnText = '[Die AI hat ihren Plan in einem internen Format ausgegeben statt ihn auszuführen. Bitte formuliere die Anfrage neu — z.B. konkreter, oder in kleineren Schritten.]';
      }
    }

    // Append model's response to contents
    contents.push({ role: 'model', parts });

    if (turnCalls.length === 0) {
      // No more tool calls — this is the final reply.
      // If the model produced neither text nor tool calls, that's
      // almost always a MAX_TOKENS or safety filter issue — surface it.
      if (!turnText && i === 0) {
        const reason = finishReason || 'unknown';
        throw new Error(
          `The AI produced no response (finishReason=${reason}). ` +
          'This usually means MAX_TOKENS, a safety filter, or a request the ' +
          'model couldn\'t handle. Try rephrasing more specifically.'
        );
      }
      finalText = turnText.trim();
      break;
    }

    // Execute each tool call and collect results
    const responseParts = [];
    for (const call of turnCalls) {
      let result;
      try {
        result = await executeTool(call.name, call.args);
      } catch (err) {
        result = { error: err.message };
      }
      toolCalls.push({ name: call.name, args: call.args, result });
      responseParts.push({
        functionResponse: {
          name: call.name,
          response: typeof result === 'object' && result !== null ? result : { value: result }
        }
      });
    }

    // Feed the tool results back as a user turn
    contents.push({ role: 'user', parts: responseParts });
  }

  return { text: finalText, toolCalls, turns, toolCodeLeakDetected };
}


/**
 * Streaming variant of callGeminiWithTools.
 *
 * Same multi-turn tool-calling loop, but uses Gemini's streamGenerateContent
 * endpoint and emits incremental events through onEvent callback:
 *
 *   onEvent({ kind: 'text_delta', text: '...' })
 *   onEvent({ kind: 'tool_call', name, args, result })
 *   onEvent({ kind: 'turn_complete' })
 *   onEvent({ kind: 'done', toolCalls, turns })
 *
 * The caller (chat endpoint) translates these into SSE events for the
 * browser to consume in real time.
 */
export async function streamGeminiWithTools({
  systemPrompt,
  userMessage,
  history = [],
  workspaceSnapshot,
  tools,
  executeTool,
  onEvent,
  model = 'gemini-2.5-flash',
  temperature = 0.5,
  maxTurns = 8,
  maxOutputTokens = 16384
}) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not configured on the server');

  // streamGenerateContent emits SSE-style chunks
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`;

  const userParts = [];
  if (workspaceSnapshot) {
    userParts.push({
      text: `Current workspace state:\n\`\`\`json\n${typeof workspaceSnapshot === 'string'
        ? workspaceSnapshot
        : JSON.stringify(workspaceSnapshot, null, 2)}\n\`\`\``
    });
  }
  userParts.push({ text: userMessage });

  const contents = [...history, { role: 'user', parts: userParts }];

  const allToolCalls = [];
  let turns = 0;

  for (let i = 0; i < maxTurns; i++) {
    turns++;
    const body = {
      contents,
      systemInstruction: systemPrompt ? { parts: [{ text: systemPrompt }] } : undefined,
      tools: tools && tools.length ? [{ functionDeclarations: tools }] : undefined,
      generationConfig: { temperature, maxOutputTokens }
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

    // Parse SSE stream
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const turnParts = [];          // all parts of this turn (text + function calls)
    const turnCalls = [];          // just the function calls
    let turnText = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE messages are separated by \n\n
      let idx;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 2);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let chunk;
        try { chunk = JSON.parse(payload); } catch { continue; }
        const cand = chunk?.candidates?.[0];
        const parts = cand?.content?.parts || [];
        for (const p of parts) {
          if (p.text) {
            turnText += p.text;
            turnParts.push({ text: p.text });
            onEvent?.({ kind: 'text_delta', text: p.text });
          }
          const fc = p.functionCall || p.function_call;
          if (fc) {
            turnCalls.push({ name: fc.name, args: fc.args || {} });
            turnParts.push({ functionCall: { name: fc.name, args: fc.args || {} } });
            // We delay emitting the tool_call event until we actually execute
            // it below — so the client gets it together with its result.
          }
        }
      }
    }

    // Append model turn to contents (consolidate consecutive text parts)
    contents.push({ role: 'model', parts: turnParts.length ? turnParts : [{ text: turnText }] });

    onEvent?.({ kind: 'turn_complete' });

    if (turnCalls.length === 0) {
      // Final reply — no more tools to call
      break;
    }

    // Execute tools, emit events, feed results back
    const responseParts = [];
    for (const call of turnCalls) {
      let result;
      try {
        result = await executeTool(call.name, call.args);
      } catch (err) {
        result = { error: err.message };
      }
      const record = { name: call.name, args: call.args, result };
      allToolCalls.push(record);
      onEvent?.({ kind: 'tool_call', ...record });
      responseParts.push({
        functionResponse: {
          name: call.name,
          response: typeof result === 'object' && result !== null ? result : { value: result }
        }
      });
    }
    contents.push({ role: 'user', parts: responseParts });
  }

  onEvent?.({ kind: 'done', toolCalls: allToolCalls, turns });
}


/**
 * Call Gemini 2.5 Flash Image (Nano Banana) to generate or edit an image.
 *
 * Unlike callGemini which expects a JSON response, this returns the image
 * as a base64-encoded data URL string along with any accompanying text.
 *
 * Inputs:
 *   prompt:     text describing the desired output
 *   files:      array of { name, mimeType, data } where data is base64.
 *               Pass the source image(s) here. The model will treat them
 *               as visual reference and edit/extend rather than ignoring.
 *
 * Returns:
 *   { image: 'data:image/png;base64,...' | null, text: string, raw }
 */
export async function callGeminiImage({ prompt, files = [] }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not configured on the server');

  const model = 'gemini-2.5-flash-image';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const parts = [];
  if (prompt) parts.push({ text: prompt });
  for (const f of (files || [])) {
    if (f.data && f.mimeType) {
      parts.push({ inline_data: { mime_type: f.mimeType, data: f.data } });
    }
  }

  const body = {
    contents: [{ parts }]
    // Note: no responseMimeType — we want the model's natural image output
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini Image ${res.status}: ${errText.slice(0, 400)}`);
  }

  const json = await res.json();
  const candidate = json?.candidates?.[0];
  const responseParts = candidate?.content?.parts || [];

  let image = null;
  let text = '';
  for (const part of responseParts) {
    if (part.inline_data || part.inlineData) {
      const d = part.inline_data || part.inlineData;
      // Build a data URL the browser can directly use as <img src>
      image = `data:${d.mime_type || d.mimeType || 'image/png'};base64,${d.data}`;
    } else if (part.text) {
      text += part.text;
    }
  }

  if (!image) {
    const reason = candidate?.finishReason || 'unknown';
    throw new Error(`Image generation returned no image (finishReason=${reason}). Model said: "${text.slice(0, 200)}"`);
  }

  return { image, text, raw: json };
}
