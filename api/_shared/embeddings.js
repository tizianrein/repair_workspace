/**
 * Embeddings — semantic retrieval over the corpus.
 *
 * Why this exists: keyword search cannot bridge vocabulary. "The sill end is
 * rotten over 400mm" shares no word with "stop-splayed scarf joint", and the
 * practitioner who most needs the joinery manual is precisely the one who does
 * not yet know to ask for it by name. Extracted `indications` help, but only
 * for the gaps the ingesting model anticipated, and not at all across
 * languages — "fauler Balkenkopf" matches nothing in an English corpus.
 *
 * Embeddings rank by meaning instead of by shared characters, which handles
 * paraphrase and cross-language matching as a matter of course.
 *
 * Cost: embedding is roughly a fiftieth the price of generation, it happens
 * once per document at ingest and once per query, and the vectors never enter
 * the model's context. Retrieval quality goes up while tokens per turn go down,
 * because we can return three precise chunks instead of a whole document.
 */

export const EMBEDDING_MODEL = 'gemini-embedding-001';

// 768 is the model's native size and its best quality/size trade-off. The
// vectors are quantised for storage (see quantize), so the wire size here is
// not the storage size.
export const EMBEDDING_DIMS = 768;

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * Embed a batch of texts.
 *
 * `taskType` matters more than it looks: asymmetric retrieval models encode
 * documents and queries differently, and using RETRIEVAL_QUERY for a stored
 * document (or vice versa) measurably degrades ranking. Documents are indexed
 * with RETRIEVAL_DOCUMENT; searches use RETRIEVAL_QUERY.
 */
export async function embedTexts(texts, { taskType = 'RETRIEVAL_DOCUMENT', dims = EMBEDDING_DIMS } = {}) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not configured on the server');
  const list = (texts || []).map(t => String(t || '').slice(0, 8000)).filter(Boolean);
  if (!list.length) return [];

  const out = [];
  // The batch endpoint caps at 100 requests; chunked ingest passes more.
  const BATCH = 100;
  for (let i = 0; i < list.length; i += BATCH) {
    const slice = list.slice(i, i + BATCH);
    const res = await fetch(`${ENDPOINT}/${EMBEDDING_MODEL}:batchEmbedContents?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: slice.map(text => ({
          model: `models/${EMBEDDING_MODEL}`,
          content: { parts: [{ text }] },
          taskType,
          outputDimensionality: dims,
        })),
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Embedding ${res.status}: ${body.slice(0, 300)}`);
    }
    const json = await res.json();
    for (const e of (json.embeddings || [])) out.push(e.values || []);
  }
  return out;
}

export async function embedQuery(text, { dims = EMBEDDING_DIMS } = {}) {
  const [vector] = await embedTexts([text], { taskType: 'RETRIEVAL_QUERY', dims });
  return vector || null;
}

/**
 * Normalise, quantise to int8, base64.
 *
 * A 768-dimension float32 vector is 3 KB. At a few hundred chunks that is
 * megabytes to drag out of D1 on every query. Quantised it is 768 bytes, and
 * the precision lost sits far below anything retrieval ranking can notice —
 * cosine over int8 reproduces cosine over float32 to about three decimals.
 *
 * Normalising first means cosine similarity reduces to a dot product, so the
 * search loop has no square roots in it.
 */
export function quantize(vector) {
  const v = Float32Array.from(vector || []);
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm) || 1;

  const q = new Int8Array(v.length);
  for (let i = 0; i < v.length; i++) {
    q[i] = Math.max(-127, Math.min(127, Math.round((v[i] / norm) * 127)));
  }
  return Buffer.from(q.buffer).toString('base64');
}

/**
 * Split a document into retrievable pieces.
 *
 * Chunking is what makes retrieval precise rather than merely relevant: one
 * vector for a 40-page manual answers "is this document about joinery" and
 * nothing more useful. Per-chunk vectors let a search return the two paragraphs
 * that actually discuss scarf proportions — which is both a better answer and
 * fewer tokens than handing over the document.
 *
 * Boundaries follow paragraphs, because a chunk split mid-sentence embeds
 * badly. The overlap keeps a passage that straddles a boundary findable from
 * either side.
 */
export function chunkText(text, { size = 1200, overlap = 200 } = {}) {
  const clean = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!clean) return [];
  if (clean.length <= size) return [clean];

  const paragraphs = clean.split(/\n{2,}/);
  const chunks = [];
  let current = '';

  for (const para of paragraphs) {
    if (current && (current.length + para.length + 2) > size) {
      chunks.push(current.trim());
      // Carry the tail of the previous chunk so a passage spanning the seam is
      // reachable from both sides.
      const tail = current.slice(-overlap);
      current = tail.includes('\n') ? tail.slice(tail.indexOf('\n') + 1) : tail;
    }
    // A single paragraph longer than the window is split on sentence ends.
    if (para.length > size) {
      const sentences = para.split(/(?<=[.!?])\s+/);
      for (const sentence of sentences) {
        if (current && (current.length + sentence.length + 1) > size) {
          chunks.push(current.trim());
          current = '';
        }
        current += (current ? ' ' : '') + sentence;
      }
    } else {
      current += (current ? '\n\n' : '') + para;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.filter(c => c.length > 20);
}

/**
 * Everything about a document that is worth being able to find independently.
 *
 * Figures and indications get their own vectors rather than being folded into
 * body text. A drawing's caption is a few words that would be drowned out
 * inside a 1200-character chunk, and indications are phrased in the problem's
 * vocabulary precisely so that a problem-shaped query can reach them — both
 * only work if they are embedded on their own.
 */
export function buildChunks({ summary, text, figures = [], indications = [] }) {
  const chunks = [];
  if (summary) chunks.push({ kind: 'summary', label: null, content: summary });
  for (const ind of indications) {
    if (ind) chunks.push({ kind: 'indication', label: null, content: ind });
  }
  for (const fig of figures) {
    if (!fig?.description) continue;
    chunks.push({
      kind: 'figure',
      label: fig.label || null,
      content: `${fig.label ? fig.label + ': ' : ''}${fig.description}`,
    });
  }
  for (const body of chunkText(text)) {
    chunks.push({ kind: 'text', label: null, content: body });
  }
  return chunks.slice(0, 400);
}
