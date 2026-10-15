// Vercel serverless function: signs Cloudinary uploads/deletes for profile photos.
// The API secret never reaches the browser. Only signed-in admins (checked with
// Supabase's is_admin() using the caller's own token) get a signature.
//
// Env (Vercel → Project → Settings → Environment Variables):
//   CLOUDINARY_URL = cloudinary://<api_key>:<api_secret>@<cloud_name>
//   VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY (already set for the frontend)
//
// POST /api/cloudinary  (Authorization: Bearer <supabase access token>)
//   { action: 'sign',   kind: 'borrowers' | 'employees', id }  → upload params
//   { action: 'delete', kind, id }                              → removes the image
import crypto from 'node:crypto';

const KINDS = ['borrowers', 'employees'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cloudinaryConfig() {
  const u = new URL(process.env.CLOUDINARY_URL || '');
  if (u.protocol !== 'cloudinary:') throw new Error('CLOUDINARY_URL is not set');
  return { apiKey: decodeURIComponent(u.username), apiSecret: decodeURIComponent(u.password), cloudName: u.hostname };
}

function sign(params, secret) {
  const str = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('&');
  return crypto.createHash('sha1').update(str + secret).digest('hex');
}

async function isAdmin(token) {
  const url = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const anon = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
  if (!url || !anon || !token) return false;
  const r = await fetch(`${url}/rest/v1/rpc/is_admin`, {
    method: 'POST',
    headers: { apikey: anon, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: '{}',
  });
  return r.ok && (await r.json()) === true;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!(await isAdmin(token))) return res.status(401).json({ error: 'Admins only' });

    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
    const { action, kind, id } = body;
    if (!KINDS.includes(kind) || !UUID.test(id || '')) return res.status(400).json({ error: 'Bad request' });

    const { apiKey, apiSecret, cloudName } = cloudinaryConfig();
    // One image per person: re-uploading overwrites the same public_id.
    const publicId = `naman/${kind}/${id}`;
    const timestamp = Math.floor(Date.now() / 1000);

    if (action === 'sign') {
      const params = { invalidate: 'true', overwrite: 'true', public_id: publicId, timestamp };
      return res.status(200).json({
        uploadUrl: `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`,
        params: { ...params, api_key: apiKey, signature: sign(params, apiSecret) },
      });
    }

    if (action === 'delete') {
      const params = { invalidate: 'true', public_id: publicId, timestamp };
      const form = new URLSearchParams({ ...params, api_key: apiKey, signature: sign(params, apiSecret) });
      const r = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/destroy`, { method: 'POST', body: form });
      const out = await r.json();
      if (!r.ok) return res.status(502).json({ error: out.error?.message || 'Cloudinary delete failed' });
      return res.status(200).json({ result: out.result });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || 'Server error' });
  }
}
