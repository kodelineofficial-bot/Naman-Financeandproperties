import { useRef } from 'react';
import { useToast } from './Toast.jsx';
import { useAction } from '../lib/hooks.js';
import { photoThumb, removePhoto, uploadPhoto } from '../lib/photos.js';

const initials = (name = '') => name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();

/** Profile photo with upload / change / remove. kind = 'borrowers' | 'employees'. */
export default function ProfilePhoto({ kind, person }) {
  const toast = useToast();
  const [busy, run] = useAction(toast);
  const input = useRef(null);

  async function onPick(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) await run(() => uploadPhoto(kind, person.id, file), 'Photo saved');
  }

  async function onRemove() {
    if (!window.confirm(`Remove ${person.name}'s photo?`)) return;
    await run(() => removePhoto(kind, person.id), 'Photo removed');
  }

  return (
    <div className="profile-photo">
      <button
        type="button"
        className="avatar avatar-lg"
        disabled={busy}
        title={person.photo_url ? 'Change photo' : 'Upload photo'}
        onClick={() => (person.photo_url ? window.open(person.photo_url, '_blank', 'noopener') : input.current?.click())}
      >
        {person.photo_url ? <img src={photoThumb(person.photo_url, 240)} alt={person.name} /> : <span>{initials(person.name)}</span>}
        {busy && <span className="avatar-busy"><span className="spinner" /></span>}
      </button>
      <div className="profile-photo-actions no-print">
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => input.current?.click()}>
          {person.photo_url ? 'Change photo' : '📷 Upload photo'}
        </button>
        {person.photo_url && (
          <button type="button" className="btn btn-sm btn-danger-outline" disabled={busy} onClick={onRemove}>Remove</button>
        )}
      </div>
      <input ref={input} type="file" accept="image/*" hidden onChange={onPick} />
    </div>
  );
}
