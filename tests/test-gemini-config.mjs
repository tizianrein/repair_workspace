import assert from 'node:assert/strict';
import {
  callGemini,
  callGeminiImage,
  callGeminiWithTools,
  DEFAULT_IMAGE_MODEL,
  DEFAULT_TEXT_MODEL,
} from '../api/_shared/gemini.js';

const originalFetch = globalThis.fetch;
const originalApiKey = process.env.GEMINI_API_KEY;
process.env.GEMINI_API_KEY = 'test-key';

const requests = [];
const responses = [];
globalThis.fetch = async (url, options) => {
  requests.push({ url: String(url), body: JSON.parse(options.body) });
  const payload = responses.shift();
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

try {
  assert.equal(DEFAULT_TEXT_MODEL, 'gemini-3.7-flash');
  assert.equal(DEFAULT_IMAGE_MODEL, 'gemini-3.1-flash-image');

  responses.push({
    candidates: [{ content: { parts: [{ text: '{"ok":true}' }] }, finishReason: 'STOP' }],
  });
  const structured = await callGemini({
    systemPrompt: 'Return JSON.',
    userPayload: { task: 'test' },
    thinkingLevel: 'low',
  });
  assert.equal(structured.ok, true);
  assert.match(requests[0].url, /models\/gemini-3\.7-flash:generateContent/);
  assert.equal(requests[0].body.generationConfig.temperature, undefined);
  assert.deepEqual(requests[0].body.generationConfig.thinkingConfig, { thinkingLevel: 'low' });

  responses.push(
    {
      candidates: [{
        content: {
          role: 'model',
          parts: [{
            functionCall: { id: 'call_test_1', name: 'inspect_part', args: { id: 'part_1' } },
            thoughtSignature: 'signature_test_1',
          }],
        },
        finishReason: 'STOP',
      }],
    },
    {
      candidates: [{ content: { role: 'model', parts: [{ text: 'Inspection complete.' }] }, finishReason: 'STOP' }],
    },
  );
  const toolResult = await callGeminiWithTools({
    systemPrompt: 'Use tools.',
    userMessage: 'Inspect the part.',
    workspaceSnapshot: { parts: [{ id: 'part_1' }] },
    tools: [{ name: 'inspect_part', description: 'Inspect one part', parameters: { type: 'object' } }],
    executeTool: async () => ({ ok: true }),
    thinkingLevel: 'medium',
  });
  assert.equal(toolResult.text, 'Inspection complete.');
  const toolFollowUp = requests[2].body.contents.at(-1).parts[0].functionResponse;
  const preservedModelPart = requests[2].body.contents.at(-2).parts[0];
  assert.equal(toolFollowUp.id, 'call_test_1');
  assert.equal(toolFollowUp.name, 'inspect_part');
  assert.equal(preservedModelPart.thoughtSignature, 'signature_test_1');
  assert.equal(requests[1].body.generationConfig.temperature, undefined);
  assert.deepEqual(requests[1].body.generationConfig.thinkingConfig, { thinkingLevel: 'medium' });

  responses.push({
    candidates: [{ content: { parts: [{ inline_data: { mime_type: 'image/png', data: 'AA==' } }] } }],
  });
  const image = await callGeminiImage({ prompt: 'Create an image.' });
  assert.equal(image.image, 'data:image/png;base64,AA==');
  assert.match(requests[3].url, /models\/gemini-3\.1-flash-image:generateContent/);

  console.log('✓ Gemini 3.7 text, tool calling, and stable image model requests are configured correctly');
} finally {
  globalThis.fetch = originalFetch;
  if (originalApiKey === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = originalApiKey;
}
