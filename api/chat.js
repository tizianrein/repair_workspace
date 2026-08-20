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
import { embedQuery, buildChunks, embedTexts, quantize, EMBEDDING_DIMS } from './_shared/embeddings.js';

export const config = { maxDuration: 90 };

// Roughly 30 pages of PDF at Gemini's ~258 tokens/page. Beyond this the model
// is told the document is too large to view and falls back to the text.
const MAX_VIEWABLE_BYTES = 12_000_000;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { thread, userMessage, workspace, files, corpus } = req.body || {};
    if (!userMessage) return res.status(400).json({ error: 'userMessage is required' });
    if (!workspace) return res.status(400).json({ error: 'workspace is required' });

    // The corpus INDEX rides along with the request — the client already knows
    // which documents this strategy may read (project-wide plus its own, never
    // another strategy's), and a summary per document is cheap. Full text is
    // fetched from the collaboration worker only when the model asks for a
    // specific document, so an unread corpus costs summaries rather than
    // contents.
    // One URL, either name. VITE_COLLAB_API_URL exists because Vite inlines
    // VITE_-prefixed variables into the browser bundle at build time — but
    // Vercel also exposes every variable to functions at runtime regardless of
    // prefix, so there is no need to configure the same address twice. Plain
    // COLLAB_API_URL still wins if it is set, for anyone who wants the
    // function pointed somewhere else.
    const collabRoot = String(
      process.env.COLLAB_API_URL || process.env.VITE_COLLAB_API_URL || '',
    ).replace(/\/$/, '');
    const corpusBase = () => {
      const base = collabRoot.endsWith('/api/collaboration')
        ? collabRoot
        : `${collabRoot}/api/collaboration`;
      return `${base}/projects/${encodeURIComponent(projectId)}/corpus`;
    };
    const projectId = corpus?.projectId || workspace?.collaboration?.projectId || null;
    const canFetchText = !!(collabRoot && projectId);

    const result = await runChat({
      thread,
      userMessage,
      workspace,
      files,
      corpus: corpus?.documents?.length
        ? {
            documents: corpus.documents,
            planId: corpus.planId || null,
            authorKey: corpus.authorKey || null,
            authorName: corpus.authorName || null,
            fetchText: canFetchText
              ? async docId => {
                  const res = await fetch(`${corpusBase()}/${encodeURIComponent(docId)}/text`);
                  if (!res.ok) throw new Error(`Document fetch failed (${res.status})`);
                  return (await res.json()).text || '';
                }
              : null,

            // Semantic retrieval. The query is embedded here (the Gemini key
            // lives on this side) and the vector is posted to the worker,
            // which holds the document vectors and does the comparison.
            search: canFetchText
              ? async query => {
                  const vector = await embedQuery(query);
                  if (!vector) return [];
                  const res = await fetch(`${corpusBase()}/search`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      vector,
                      planId: corpus?.planId || null,
                      authorKey: corpus?.authorKey || null,
                      topK: 8,
                    }),
                  });
                  if (!res.ok) throw new Error(`Corpus search failed (${res.status})`);
                  return (await res.json()).chunks || [];
                }
              : null,

            // File material the user pasted into the chat. Stored, summarised
            // and embedded on the same path as an uploaded document, so it is
            // retrievable in exactly the same way.
            save: canFetchText
              ? async ({ title, content, docKind, scope }) => {
                  const docId = `doc_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
                  const filename = `${title.replace(/[^\p{L}\p{N} .,_-]/gu, '').slice(0, 80) || 'note'}.txt`;
                  const q = new URLSearchParams({ scope, kind: docKind });
                  if (scope === 'strategy') {
                    if (!corpus?.planId || !corpus?.authorKey) {
                      throw new Error('no strategy is selected to attach it to');
                    }
                    q.set('planId', corpus.planId);
                    q.set('author', corpus.authorKey);
                  } else if (corpus?.authorKey) {
                    q.set('author', corpus.authorKey);
                  }

                  const put = await fetch(`${corpusBase()}/${docId}?${q}`, {
                    method: 'PUT',
                    headers: {
                      'Content-Type': 'text/plain; charset=utf-8',
                      'X-File-Name': encodeURIComponent(filename),
                      'X-Author-Name': encodeURIComponent(corpus?.authorName || ''),
                    },
                    body: content,
                  });
                  if (!put.ok) throw new Error(`store failed (${put.status})`);

                  // Index it the same way an uploaded document is indexed —
                  // anything less and it would be listed but unfindable.
                  const summary = `${title}. Filed from the conversation.`;
                  let chunks = [];
                  try {
                    const pieces = buildChunks({ summary, text: content, figures: [], indications: [] });
                    const vectors = await embedTexts(pieces.map(p => p.content));
                    chunks = pieces
                      .map((piece, i) => vectors[i]?.length
                        ? { ...piece, vector: quantize(vectors[i]), dims: EMBEDDING_DIMS }
                        : null)
                      .filter(Boolean);
                  } catch (err) {
                    console.warn('[corpus.save] embedding failed:', err.message);
                  }

                  await fetch(`${corpusBase()}/${docId}/text`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ status: 'ready', summary, text: content, chunks }),
                  });

                  return { id: docId, filename, scope, docKind };
                }
              : null,

            // The original bytes, for when the model needs to LOOK at a
            // drawing rather than read a transcription of it. Capped: a PDF
            // costs roughly 258 tokens per page, so an unbounded textbook
            // would blow the context in one call.
            fetchDocument: canFetchText
              ? async docId => {
                  const res = await fetch(`${corpusBase()}/${encodeURIComponent(docId)}`);
                  if (!res.ok) throw new Error(`Document fetch failed (${res.status})`);
                  const buffer = Buffer.from(await res.arrayBuffer());
                  if (buffer.byteLength > MAX_VIEWABLE_BYTES) {
                    throw new Error(
                      `that document is ${Math.round(buffer.byteLength / 1e6)} MB, too large to view in full`,
                    );
                  }
                  return {
                    mimeType: res.headers.get('Content-Type') || 'application/pdf',
                    data: buffer.toString('base64'),
                  };
                }
              : null,
          }
        : null,
    });
    return res.status(200).json(result);
  } catch (err) {
    console.error('[chat] error:', err);
    return res.status(500).json({ error: err.message });
  }
}
