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

/**
 * Build a ZIP Blob containing the workspace and any photos it references.
 * Returns { blob, photoCount } or { blob, photoCount: 0 } if no photos.
 */
export async function exportWorkspaceBundle(workspace) {
  const zip = new JSZip();
  zip.file(WORKSPACE_FILENAME, JSON.stringify(workspace, null, 2));

  const photoEvidence = (workspace.evidence || []).filter(e => e.kind === 'photo');
  let included = 0;
  for (const ev of photoEvidence) {
    try {
      const rec = await PhotoStorage.get(ev.id);
      if (!rec || !rec.blob) continue;
      const ext = rec.mime?.includes('png') ? 'png' : 'jpg';
      zip.file(`${PHOTO_FOLDER}/${ev.id}.${ext}`, rec.blob);
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

  const zip = await JSZip.loadAsync(file);
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
        const blob = await f.async('blob');
        // file name shape: "<evidence_id>.jpg" → id is basename without ext
        const id = path.replace(/\.[^.]+$/, '');
        // Set mime hint
        const mime = path.endsWith('.png') ? 'image/png' : 'image/jpeg';
        const typed = blob.type ? blob : new Blob([await blob.arrayBuffer()], { type: mime });
        await PhotoStorage.put(id, typed, path);
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
