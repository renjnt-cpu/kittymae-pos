// Payment Verification -- getting a payment-proof picture ready, entirely in the browser: an exact fingerprint (SHA-256 of the file, so the very same picture is always
// recognised), a look-alike fingerprint (a 64-bit "difference hash" of what the picture looks like, so a re-saved or resized copy is still recognised) and a small
// preview picture for the lists. The original file is never changed. No imports: the ERP and the POS carry an identical copy of this file.

export const MAX_IMAGE = 15 * 1024 * 1024;
export const IMAGE_TYPE = /^image\/(jpeg|png|webp|gif|heic|heif)$/i;

export async function sha256Hex(blob) {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function decode(file) {
  if (typeof createImageBitmap === 'function') {
    try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (e) { /* try the next way */ }
    try { return await createImageBitmap(file); } catch (e) { /* try the next way */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return img;
  } finally { URL.revokeObjectURL(url); }
}
const sizeOf = (src) => ({ w: src.naturalWidth || src.videoWidth || src.width, h: src.naturalHeight || src.videoHeight || src.height });

function canvasOf(src, w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h));
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);   // a transparent picture is compared on white, like it is seen
  ctx.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

/** 64-bit difference hash as 16 hex digits. The picture is shrunk in steps (averaging the pixels) to 72x64, cut into 9x8 blocks, and each block is compared with
 * the one to its right: "brighter than its neighbour" = 1. The same picture gives the same hash on every device; a resized / re-compressed copy differs by a few bits. */
export function differenceHash(src) {
  const { w: sw, h: sh } = sizeOf(src);
  let cur = src, w = sw, h = sh;
  while (w > 288 || h > 256) {
    w = Math.max(144, Math.ceil(w / 2)); h = Math.max(128, Math.ceil(h / 2));
    cur = canvasOf(cur, w, h);
  }
  const px = canvasOf(cur, 72, 64).getContext('2d').getImageData(0, 0, 72, 64).data;
  const grid = [];
  for (let r = 0; r < 8; r++) {
    const row = [];
    for (let c = 0; c < 9; c++) {
      let sum = 0;
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) { const i = ((r * 8 + y) * 72 + (c * 8 + x)) * 4; sum += 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]; }
      row.push(sum / 64);
    }
    grid.push(row);
  }
  let bits = '';
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) bits += grid[r][c] > grid[r][c + 1] ? '1' : '0';
  let hex = '';
  for (let i = 0; i < 64; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}

function thumbBlob(src, maxW = 360, maxH = 640) {
  const { w, h } = sizeOf(src);
  const k = Math.min(1, maxW / w, maxH / h);
  const c = canvasOf(src, w * k, h * k);
  return new Promise((resolve) => c.toBlob((b) => resolve(b), 'image/jpeg', 0.8));
}

/** Everything the form needs from one picked file. Never throws: a picture the browser cannot read is still kept (and saved as is), just without the look-alike
 * fingerprint and the preview. `problem` is the sentence to show the person when the file cannot be used at all. */
export async function prepareImage(file) {
  const out = { file, name: file.name || 'proof.jpg', mime: file.type || '', size: file.size, width: null, height: null, sha256: null, phash: null, thumb: null, previewUrl: null, problem: null, note: null };
  if (!IMAGE_TYPE.test(out.mime)) { out.problem = 'Only photos and screenshots can be added (JPG, PNG, WEBP, GIF, HEIC).'; return out; }
  if (file.size > MAX_IMAGE) { out.problem = 'That picture is too large (15 MB at most).'; return out; }
  if (file.size < 200) { out.problem = 'That file looks empty.'; return out; }
  try { out.sha256 = await sha256Hex(file); } catch (e) { out.note = 'The exact fingerprint could not be made on this device.'; }
  let src = null;
  try { src = await decode(file); } catch (e) { src = null; }
  if (src) {
    const s = sizeOf(src);
    out.width = s.w; out.height = s.h;
    try { out.phash = differenceHash(src); } catch (e) { out.note = 'The look-alike fingerprint could not be made.'; }
    try { out.thumb = await thumbBlob(src); } catch (e) { out.thumb = null; }
    if (src.close) { try { src.close(); } catch (e) { /* harmless */ } }
  } else {
    out.note = 'This picture cannot be previewed in the browser (for example HEIC). It will still be saved as it is.';
  }
  out.previewUrl = URL.createObjectURL(out.thumb || file);
  return out;
}

const safeName = (name) => String(name || 'proof').replace(/[^A-Za-z0-9._-]+/g, '_').slice(-60) || 'proof';
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); }));

/** Puts a prepared picture into the private "payment-proofs" bucket (never overwriting anything) and returns the JSON pv_submit / pv_add_image expect. */
export async function uploadPrepared(supabase, bucket, p) {
  const id = uuid();
  const path = 'orig/' + id + '/' + safeName(p.name);
  const up = await supabase.storage.from(bucket).upload(path, p.file, { upsert: false, contentType: p.mime || 'image/jpeg' });
  if (up.error) throw new Error(up.error.message);
  let thumb = null;
  if (p.thumb) {
    const tpath = 'thumb/' + id + '/' + safeName(p.name).replace(/\.[A-Za-z0-9]+$/, '') + '.jpg';
    const t = await supabase.storage.from(bucket).upload(tpath, p.thumb, { upsert: false, contentType: 'image/jpeg' });
    if (!t.error) thumb = tpath;     // a missing preview is not worth failing the proof for
  }
  return { storage_path: path, thumb_path: thumb, sha256: p.sha256, phash: p.phash, size: p.size, width: p.width, height: p.height, mime: p.mime };
}

/** The Hamming distance between two 16-hex-digit hashes (0 = identical, 64 = opposite) -- used to say "these two pictures look alike" next to a match. */
export function hashDistance(a, b) {
  if (!a || !b || a.length !== 16 || b.length !== 16) return null;
  let n = 0;
  for (let i = 0; i < 16; i++) { let x = parseInt(a[i], 16) ^ parseInt(b[i], 16); while (x) { n += x & 1; x >>= 1; } }
  return n;
}
