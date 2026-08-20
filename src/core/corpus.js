/**
 * Corpus client — source material the AI reads.
 *
 * Two scopes, and the difference between them is a design decision, not a
 * storage detail:
 *
 *   project    Shared by everyone working on this artefact. The structure's
 *              documentation, the survey report, the repair brief. Deliberately
 *              user-independent: divergence between participants has to come
 *              from what they DO with the material, not from having been given
 *              different material.
 *
 *   strategy   Attached to one plan and readable only by it. This is what makes
 *              two strategies genuinely diverge — a participant who brings a
 *              paper on scarf joints into one strategy and a paper on
 *              consolidants into another has built two different evidence
 *              bases, and the plans that follow will differ because of it. If
 *              every strategy could read every document they would converge.
 *
 * Documents are uploaded, then ingested (summary + plaintext + key facts). The
 * summary is what rides along in chat context by default; full text is fetched
 * only when the model asks for a document by id.
 */

const DOC_KINDS = [
  { value: 'structure', label: 'Describes the structure' },
  { value: 'goal', label: 'States the repair goal' },
  { value: 'technique', label: 'Repair technique / precedent' },
  { value: 'reference', label: 'Other reference' },
];

export { DOC_KINDS };

export function newDocId() {
  const g = globalThis.crypto;
  const rand = g?.randomUUID
    ? g.randomUUID().replace(/-/g, '').slice(0, 10)
    : Math.random().toString(36).slice(2, 12);
  return `doc_${Date.now().toString(36)}${rand}`;
}

/** Human-readable size, for the document list. */
export function formatSize(bytes) {
  const n = Number(bytes || 0);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function createCorpus({ api, getProjectId, getScope, log = () => {} }) {
  // Cached per (projectId, planId) view. Invalidated on any write.
  let cache = null;
  let cacheKey = null;

  function keyFor() {
    const { planId, authorKey } = getScope();
    return `${getProjectId()}::${authorKey || ''}::${planId || ''}`;
  }

  /**
   * Documents readable from the current strategy: project-wide plus this
   * plan's own. There is deliberately no way to ask for another strategy's.
   */
  async function list({ force = false } = {}) {
    const projectId = getProjectId();
    if (!projectId) return [];
    const k = keyFor();
    if (!force && cache && cacheKey === k) return cache;
    const { planId, authorKey } = getScope();
    const docs = await api.listCorpus(projectId, { planId, authorKey });
    cache = docs;
    cacheKey = k;
    return docs;
  }

  function invalidate() { cache = null; cacheKey = null; }

  /**
   * Upload, then ingest.
   *
   * The document is stored first and ingested second, deliberately: a failed
   * ingest leaves a listed, downloadable document marked "failed" rather than
   * losing the upload. Ingest can be retried; a lost upload cannot.
   */
  async function add(file, { scope = 'project', docKind = 'reference', artefactName = null } = {}) {
    const projectId = getProjectId();
    if (!projectId) throw new Error('No project to add documents to');
    const { planId, authorKey, authorName } = getScope();
    if (scope === 'strategy' && (!planId || !authorKey)) {
      throw new Error('Choose a name and a strategy before adding strategy documents');
    }

    const docId = newDocId();
    const buffer = await file.arrayBuffer();

    await api.putCorpusDoc(projectId, docId, buffer, {
      scope,
      planId: scope === 'strategy' ? planId : null,
      authorKey: scope === 'strategy' ? authorKey : authorKey,
      authorName,
      filename: file.name,
      mimeType: file.type || 'application/octet-stream',
      docKind,
    });
    invalidate();

    // Ingest is best-effort. The document is already safe.
    //
    // We send the document's ADDRESS, not its bytes. It was just stored in R2
    // above, so the server can fetch it from there — and must, because a
    // Vercel function body may be 4.5 MB and base64 inflates by 4/3, which
    // capped the corpus at roughly 3.3 MB per document. Anything larger was
    // rejected by the platform before the function ran, and surfaced here as a
    // bare "Ingest failed (413)". Architectural PDFs are routinely bigger than
    // that, so the cap excluded most of what this corpus is for.
    try {
      const res = await fetch('/api/ingest-document', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId,
          docId,
          docKind,
          artefactName,
        }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Ingest failed (${res.status})`);
      const { summary, text, keyFacts, figures, indications, chunks } = await res.json();
      await api.putCorpusText(projectId, docId, { summary, text, keyFacts, figures, indications, chunks, status: 'ready' });
      log(`Read "${file.name}".`);
    } catch (error) {
      console.warn('Ingest failed:', error.message);
      try {
        await api.putCorpusText(projectId, docId, { status: 'failed', error: error.message });
      } catch {}
      log(`Stored "${file.name}", but could not read it: ${error.message}`);
    }

    invalidate();
    return docId;
  }

  async function remove(docId) {
    const projectId = getProjectId();
    if (!projectId) return;
    await api.deleteCorpusDoc(projectId, docId);
    invalidate();
  }

  /**
   * The compact index that travels with a chat turn.
   *
   * Summary only — roughly 40 tokens per document. The model sees what exists
   * and asks for a document by id when it needs the contents, so a fifty
   * document corpus costs ~2k tokens per turn instead of ~500k.
   */
  async function contextIndex() {
    const docs = await list().catch(() => []);
    return docs
      .filter(d => d.status === 'ready' || d.summary)
      .map(d => ({
        id: d.id,
        scope: d.scope,
        kind: d.docKind,
        filename: d.filename,
        summary: d.summary || '',
        keyFacts: d.keyFacts || [],
        // Figure descriptions travel in the index so search_corpus can match a
        // drawing that the extracted prose never mentions. They are short — a
        // label and a line each — and they are what makes a joinery manual
        // findable at all.
        figures: (d.figures || []).map(f => ({ label: f.label, description: f.description })),
        // The problem-side vocabulary — what situations this document helps
        // with, in the words of the situation rather than the solution. This is
        // what lets "the sill end is rotten" find a text on scarf joints.
        indications: d.indications || [],
      }));
  }

  return { list, add, remove, invalidate, contextIndex };
}
