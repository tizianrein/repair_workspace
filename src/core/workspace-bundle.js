/**
 * workspace-bundle.js — pack and unpack a workspace as ZIP with photos.
 *
 * Format of the ZIP:
 *   workspace.json        the workspace metadata (no inline photos)
 *   photos/<id>.jpg       one file per evidence entry of kind="photo"
 *
 * On export: include every photo currently in IndexedDB that's referenced
 * by an evidence entry in this workspace. Photos that no evidence points
 * to are skipped (orphans get cleaned up here).
 *
 * On import: write workspace.json to state, write every photo in photos/
 * to IndexedDB under its file-basename (assumed to equal the evidence ID).
 *
 * Either side (load or save) supports plain JSON without photos as a
 * graceful degraded form for workspaces with no images.
 */

import JSZip from 'jszip';
import { PhotoStorage } from './photo-storage.js';

const PHOTO_FOLDER = 'photos';
const WORKSPACE_FILENAME = 'workspace.json';

// Every evidence kind whose bytes live in IndexedDB and must travel with the
// workspace. 'rendering' was missing, so AI-generated images were written into
// workspace.json as references with no blob behind them: a Save -> Load round
// trip silently lost every imagined result, and the viewer then showed
// "Image not on device" for records that looked perfectly intact.
const BINARY_EVIDENCE_KINDS = ['photo', 'rendering'];

export function binaryEvidence(workspace) {
  return (workspace?.evidence || []).filter(e => BINARY_EVIDENCE_KINDS.includes(e.kind));
}

/**
 * Build a ZIP Blob containing the workspace and any photos it references.
 * Returns { blob, photoCount } or { blob, photoCount: 0 } if no photos.
 */
export async function exportWorkspaceBundle(workspace) {
  const zip = new JSZip();
  zip.file(WORKSPACE_FILENAME, JSON.stringify(workspace, null, 2));

  const photoEvidence = binaryEvidence(workspace);
  let included = 0;
  for (const ev of photoEvidence) {
    try {
      const rec = await PhotoStorage.get(ev.id);
      if (!rec || !rec.blob) continue;
      const ext = (rec.mime || ev.mimeType || '').includes('png') ? 'png' : 'jpg';
      // Hand JSZip raw bytes rather than the Blob itself. Blob input only
      // works in a browser; ArrayBuffer works everywhere, which keeps this
      // path testable outside one.
      const bytes = await rec.blob.arrayBuffer();
      zip.file(`${PHOTO_FOLDER}/${ev.id}.${ext}`, bytes);
      included += 1;
    } catch (err) {
      console.warn('Failed to include photo', ev.id, err);
    }
  }

  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  return { blob, photoCount: included };
}

/**
 * Read a File (either a .json or .zip). Returns { workspace, photoCount }.
 * Workspaces are returned as parsed objects; photos are written to
 * IndexedDB as a side effect.
 */
export async function importWorkspaceBundle(file) {
  const lowerName = file.name?.toLowerCase() || '';
  const isZip = lowerName.endsWith('.zip') || file.type === 'application/zip';

  if (!isZip) {
    // Plain JSON
    const text = await file.text();
    return { workspace: JSON.parse(text), photoCount: 0 };
  }

  // Read as bytes rather than handing JSZip the File. Blob/File input is a
  // browser-only capability of JSZip; ArrayBuffer works in every runtime and
  // keeps import testable headlessly.
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const wsFile = zip.file(WORKSPACE_FILENAME);
  if (!wsFile) throw new Error(`ZIP is missing ${WORKSPACE_FILENAME}`);

  const wsText = await wsFile.async('string');
  const workspace = JSON.parse(wsText);

  // Restore photos to IndexedDB
  const photoFiles = zip.folder(PHOTO_FOLDER);
  let photoCount = 0;
  if (photoFiles) {
    const entries = [];
    photoFiles.forEach((relativePath, fileObj) => {
      if (!fileObj.dir) entries.push({ path: relativePath, file: fileObj });
    });
    for (const { path, file: f } of entries) {
      try {
        const bytes = await f.async('arraybuffer');
        // file name shape: "<evidence_id>.jpg" → id is basename without ext
        const id = path.replace(/\.[^.]+$/, '');
        const mime = path.endsWith('.png') ? 'image/png' : 'image/jpeg';
        await PhotoStorage.put(id, new Blob([bytes], { type: mime }), path);
        photoCount += 1;
      } catch (err) {
        console.warn('Failed to restore photo', path, err);
      }
    }
  }

  return { workspace, photoCount };
}

/**
 * Trigger a browser download for the given blob.
 */
export function downloadBlob(blob, filename) {
  const a = document.createElement('a');
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 100);
}

// ============================================================================
// SINGLE-STRATEGY BUNDLES
//
// Export is per-strategy. A workspace ZIP holding five strategies is a blob
// nobody can act on; one strategy per file is the unit people exchange and the
// unit the research compares. The bundle has to stand alone, so it carries the
// artefact and the conditions too — a plan whose steps reference parts and
// conditions that aren't in the file is unreadable.
// ============================================================================

const MANIFEST_FILENAME = 'manifest.json';
export const BUNDLE_VERSION = 1;

/**
 * Slug for one filename segment.
 *
 * German transliteration matters here: this is built for a German-language
 * workshop, and "Türsturz" becoming "trsturz" (or worse, "t-rsturz") makes a
 * folder of thirty exports unreadable at exactly the moment you need to find
 * one. Umlauts expand the way German expects them to.
 */
export function slugSegment(text, { max = 40, fallback = 'untitled' } = {}) {
  const map = { ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss', å: 'a', æ: 'ae', ø: 'oe', é: 'e', è: 'e', ê: 'e', ç: 'c', ñ: 'n' };
  const slug = String(text ?? '')
    .toLowerCase()
    .replace(/[äöüßåæøéèêçñ]/g, c => map[c] || c)
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')   // strip remaining accents
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/, '');
  return slug || fallback;
}

/**
 * Filename for a strategy bundle, ordered artefact → author → strategy → date.
 *
 * That order is deliberate: collect thirty of these from a workshop into one
 * folder and an alphabetical sort groups them by artefact first, then by
 * person — which is how you actually read them when comparing strategies for
 * the same object.
 */
export function strategyBundleName({ artefactName, authorName, strategyLabel, planId, date, taken }) {
  const parts = [
    slugSegment(artefactName, { fallback: 'artefact' }),
    authorName ? slugSegment(authorName, { max: 30 }) : null,
    slugSegment(strategyLabel, { fallback: 'untitled-strategy' }),
    (date instanceof Date ? date : new Date(date || Date.now())).toISOString().slice(0, 10),
  ].filter(Boolean);

  let name = parts.join('__');
  // Two strategies can carry the same label. Disambiguate with a short slice
  // of the plan id rather than "(1)", so the suffix is stable across re-exports
  // of the same strategy instead of drifting with folder contents.
  if (taken?.has?.(`${name}.zip`) && planId) {
    name += '__' + String(planId).replace(/^plan_/, '').slice(-4);
  }
  return `${name}.zip`;
}

/**
 * Everything a single strategy needs to stand on its own.
 *
 * Included: the artefact and its parts, every condition (the strategy was
 * formed against the whole survey, not just the conditions its steps happen to
 * name), this plan only, its chat thread, execution entries for its steps, its
 * renderings, and the photos any condition references.
 */
export function projectStrategy(workspace, planId) {
  const plan = (workspace.plans || []).find(p => p.id === planId);
  if (!plan) throw new Error(`No strategy with id ${planId}`);

  const stepIds = new Set((plan.steps || []).map(s => s.id));
  const conditions = workspace.conditions || [];
  const conditionIds = new Set(conditions.map(c => c.id));

  const evidence = (workspace.evidence || []).filter(e => {
    if (e.kind === 'rendering') return e.planRef === plan.id;
    if (e.attachedTo?.type === 'condition') return conditionIds.has(e.attachedTo.id);
    if (e.attachedTo?.type === 'step') return stepIds.has(e.attachedTo.id);
    return true;   // artefact-level evidence travels with the artefact
  });

  return {
    ...workspace,
    plans: [plan],
    currentPlanId: plan.id,
    conditions,
    evidence,
    executionLog: (workspace.executionLog || []).filter(e => stepIds.has(e.stepRef)),
    conversations: (workspace.conversations || []).filter(t =>
      (t.scope === 'plan' && t.ref === plan.id)
      || (t.scope === 'step' && stepIds.has(t.ref))
      || t.scope === 'global'
    ),
  };
}

/**
 * Build a single-strategy ZIP. Returns { blob, filename, photoCount }.
 */
export async function exportStrategyBundle(workspace, planId, { authorName = null, takenNames = null, corpus = null } = {}) {
  const plan = (workspace.plans || []).find(p => p.id === planId);
  if (!plan) throw new Error(`No strategy with id ${planId}`);
  const scoped = projectStrategy(workspace, planId);

  const zip = new JSZip();
  zip.file(MANIFEST_FILENAME, JSON.stringify({
    bundleVersion: BUNDLE_VERSION,
    scope: 'strategy',
    schemaVersion: workspace.schemaVersion,
    artefactId: workspace.instance?.id || null,
    artefactName: workspace.instance?.name || null,
    projectId: workspace.collaboration?.projectId || null,
    planId: plan.id,
    strategyLabel: plan.label,
    authorName: authorName || null,
    exportedAt: new Date().toISOString(),
    counts: {
      parts: (workspace.instance?.parts || []).length,
      conditions: (scoped.conditions || []).length,
      steps: (plan.steps || []).length,
      renderings: (scoped.evidence || []).filter(e => e.kind === 'rendering').length,
    },
    corpus: 'see corpus/index.json',
  }, null, 2));
  zip.file(WORKSPACE_FILENAME, JSON.stringify(scoped, null, 2));

  // The corpus travels with the strategy.
  //
  // Without it the bundle is not self-explaining: the plan's reasoning cites
  // documents, and a reader holding only the plan cannot see what it reasoned
  // FROM. The corpus is also what will make the derived intent axes traceable,
  // so leaving it out strips the bundle of its provenance.
  //
  // What travels and what does not: every in-scope document's record and
  // extracted text goes in, because that is small and is what actually
  // explains the reasoning. Original binaries go in only for strategy-scoped
  // documents — the ones unique to this strategy. Project documents are shared
  // by everyone, so copying a 20 MB manual into ten participants' exports is
  // 200 MB spent saying the same thing ten times. The manifest records exactly
  // what was referenced but not embedded, so nothing goes missing silently.
  const omittedOriginals = [];
  if (corpus && corpus.listForPlan) {
    try {
      const docs = await corpus.listForPlan(planId);
      const index = [];
      for (const doc of docs) {
        let text = null;
        try { text = await corpus.getText(doc.id); } catch (err) { void err; }
        index.push({
          id: doc.id,
          filename: doc.filename,
          scope: doc.scope,
          docKind: doc.docKind,
          summary: doc.summary || null,
          keyFacts: doc.keyFacts || [],
          indications: doc.indications || [],
          figures: doc.figures || [],
          byteSize: doc.byteSize,
          mimeType: doc.mimeType,
          authorName: doc.authorName || null,
          originalIncluded: doc.scope === 'strategy',
        });
        if (text) zip.file('corpus/text/' + doc.id + '.txt', text);

        if (doc.scope === 'strategy' && corpus.getOriginal) {
          try {
            const original = await corpus.getOriginal(doc.id);
            if (original) {
              const name = String(doc.filename || '');
              const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : 'bin';
              zip.file('corpus/files/' + doc.id + '.' + ext, await original.arrayBuffer());
            }
          } catch (err) {
            omittedOriginals.push({ id: doc.id, filename: doc.filename, reason: err.message });
          }
        } else if (doc.scope === 'project') {
          omittedOriginals.push({
            id: doc.id,
            filename: doc.filename,
            reason: 'shared project document; its text is included, the original stays with the project',
          });
        }
      }
      zip.file('corpus/index.json', JSON.stringify({ documents: index, omittedOriginals }, null, 2));
    } catch (err) {
      console.warn('Corpus could not be included in the bundle:', err.message);
    }
  }

  let included = 0;
  for (const ev of binaryEvidence(scoped)) {
    try {
      const rec = await PhotoStorage.get(ev.id);
      if (!rec?.blob) continue;
      const ext = (rec.mime || ev.mimeType || '').includes('png') ? 'png' : 'jpg';
      zip.file(`${PHOTO_FOLDER}/${ev.id}.${ext}`, await rec.blob.arrayBuffer());
      included += 1;
    } catch (err) {
      console.warn('Failed to include image', ev.id, err);
    }
  }

  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  const filename = strategyBundleName({
    artefactName: workspace.instance?.name,
    authorName,
    strategyLabel: plan.label,
    planId: plan.id,
    date: new Date(),
    taken: takenNames,
  });
  return { blob, filename, photoCount: included };
}
