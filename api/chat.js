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

import { withRateLimit } from './_shared/rate-limit.js';
import { runChat } from './_shared/chat-engine.js';
import { embedQuery, buildChunks, embedTexts, quantize, quantizeVector, EMBEDDING_DIMS } from './_shared/embeddings.js';

export const config = { maxDuration: 90 };

// The ceiling on looking at a document's original pages.
//
// This is a cost limit, not an API limit: Gemini accepts a 23.6 MB inline
// request in practice (measured against a 17.7 MB, 129-page PDF), and bills
// about 258 tokens per page — so a view of that book costs roughly 33k input
// tokens, and an unbounded document would be an unbounded bill.
//
// It was 12 MB, which was below the size of the very reference works most
// worth looking at. A book-length document already yields little body text at
// ingest — the model summarises rather than transcribes 129 pages — so if it
// also cannot be viewed, the drawings inside it are unreachable by any route.
// Figure descriptions tell the model a drawing exists; this is what lets it go
// and read the drawing.
const MAX_VIEWABLE_BYTES = 28_000_000;

async function handler(req, res) {
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
                      // Quantised, not raw. The stored vectors are unit-length
                      // int8; the query has to be in the same units or the dot
                      // product means nothing. See quantizeVector.
                      vector: quantizeVector(vector),
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

// Bounded before it can spend anything. See _shared/rate-limit.js.
export default withRateLimit('chat', handler);
