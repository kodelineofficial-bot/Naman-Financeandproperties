import { q, supabase } from './supabase.js';

const MAX_BYTES = 10 * 1024 * 1024; // Cloudinary free plan image limit

/** Call the Vercel function that signs Cloudinary requests (admins only). */
async function callApi(body) {
  const { data } = await supabase.auth.getSession();
  const r = await fetch('/api/cloudinary', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.session?.access_token || ''}` },
    body: JSON.stringify(body),
  });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(out.error || `Photo service error (${r.status})`);
  return out;
}

/** Upload a profile photo for a borrower / employee and save its URL on the row. */
export async function uploadPhoto(kind, id, file) {
  if (!file.type.startsWith('image/')) throw new Error('Please choose an image file.');
  if (file.size > MAX_BYTES) throw new Error('Image is too large (max 10 MB).');
  const { uploadUrl, params } = await callApi({ action: 'sign', kind, id });
  const form = new FormData();
  Object.entries(params).forEach(([k, v]) => form.append(k, v));
  form.append('file', file);
  const r = await fetch(uploadUrl, { method: 'POST', body: form });
  const img = await r.json();
  if (!r.ok) throw new Error(img.error?.message || 'Upload failed');
  await q(supabase.from(kind).update({ photo_url: img.secure_url, photo_public_id: img.public_id }).eq('id', id));
}

export async function removePhoto(kind, id) {
  await callApi({ action: 'delete', kind, id });
  await q(supabase.from(kind).update({ photo_url: null, photo_public_id: null }).eq('id', id));
}

/** Cloudinary URL resized/cropped to a square around the face. */
export function photoThumb(url, size = 160) {
  if (!url) return null;
  return url.replace('/image/upload/', `/image/upload/c_fill,g_face,w_${size},h_${size},q_auto,f_auto/`);
}
