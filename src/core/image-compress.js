/**
 * image-compress.js — client-side photo compression
 *
 * Phones produce 3-8 MB photos. We don't need that resolution for damage
 * documentation. Resizing to a max long-edge of 1600px with JPEG quality
 * 0.82 typically brings them to 200-500 KB with no perceptible quality
 * loss for inspection purposes.
 *
 * EXIF metadata (including GPS) is implicitly stripped because we draw
 * to a canvas — the resulting blob has no EXIF.
 *
 * Returns a Blob ready to be stored in IndexedDB.
 */

const DEFAULT_MAX_DIM = 1600;
const DEFAULT_QUALITY = 0.82;

/**
 * Compress an image File/Blob to a Blob.
 */
export async function compressImage(file, opts = {}) {
  const maxDim = opts.maxDim || DEFAULT_MAX_DIM;
  const quality = opts.quality || DEFAULT_QUALITY;

  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch (err) {
    bitmap = await loadImageElement(file);
  }

  const { width: srcW, height: srcH } = bitmap;
  const longEdge = Math.max(srcW, srcH);
  const scale = longEdge > maxDim ? (maxDim / longEdge) : 1;
  const dstW = Math.round(srcW * scale);
  const dstH = Math.round(srcH * scale);

  const canvas = document.createElement('canvas');
  canvas.width = dstW;
  canvas.height = dstH;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, dstW, dstH);

  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
  if (bitmap.close) bitmap.close();

  if (!blob) return file;
  if (blob.size >= file.size && file.type === 'image/jpeg') return file;
  return blob;
}

function loadImageElement(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
    img.src = url;
  });
}

/** Convert a Blob to a base64 string (without the data: prefix). */
export async function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = () => reject(new Error('read error'));
    r.readAsDataURL(blob);
  });
}

/** Convert a Blob to an object URL for display. Caller must revoke it. */
export function blobToObjectUrl(blob) {
  return URL.createObjectURL(blob);
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
