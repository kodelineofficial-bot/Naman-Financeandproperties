-- =====================================================================
-- 013: Profile photos for borrowers and employees (stored in Cloudinary)
--
-- photo_url        Cloudinary secure_url shown on the profile page.
-- photo_public_id  Cloudinary public_id, used to replace / delete it.
-- The upload itself is signed by the Vercel function api/cloudinary.js,
-- which only signs for signed-in admins.
--
-- Changed: borrowers + photo_url, photo_public_id
--          employees + photo_url, photo_public_id
-- =====================================================================

alter table public.borrowers
  add column if not exists photo_url       text,
  add column if not exists photo_public_id text;

alter table public.employees
  add column if not exists photo_url       text,
  add column if not exists photo_public_id text;
