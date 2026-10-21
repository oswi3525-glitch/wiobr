import { ChangeEvent, FormEvent, useEffect, useMemo, useState } from 'react';
import { api, apiUrl } from '../lib/api';

type StorageItem = {
  id: number;
  kind: 'file' | 'folder' | 'note' | 'link' | 'snippet' | 'draft';
  parentId: number | null;
  name: string;
  content: string | null;
  mime: string | null;
  sizeBytes: number;
  expiresAt: string | null;
  createdAt: string;
};
type StorageResponse = { items: StorageItem[]; usedBytes: number; quotaBytes: number };

const readableSize = (bytes: number) => bytes < 1024 * 1024
  ? `${Math.max(1, Math.ceil(bytes / 1024))} KB`
  : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

export function StoragePanel() {
  const [parentId, setParentId] = useState<number | null>(null);
  const [parents, setParents] = useState<Array<{ id: number; name: string }>>([]);
  const [items, setItems] = useState<StorageItem[]>([]);
  const [usedBytes, setUsedBytes] = useState(0);
  const [quotaBytes, setQuotaBytes] = useState(0);
  const [kind, setKind] = useState<'folder' | 'note' | 'link' | 'snippet' | 'draft'>('note');
  const [name, setName] = useState('');
  const [content, setContent] = useState('');
  const [editing, setEditing] = useState<StorageItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [uploading, setUploading] = useState(false);

  const usedPercent = useMemo(() => quotaBytes ? Math.min(100, Math.round(usedBytes / quotaBytes * 100)) : 0, [usedBytes, quotaBytes]);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const query = parentId === null ? '' : `?parentId=${parentId}`;
      const result = await api<StorageResponse>(`/api/storage${query}`);
      setItems(result.items);
      setUsedBytes(result.usedBytes);
      setQuotaBytes(result.quotaBytes);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Cloud storage could not be loaded.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, [parentId]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    setNotice('');
    try {
      await api('/api/storage', {
        method: 'POST',
        body: JSON.stringify({ kind, name, content: kind === 'folder' ? '' : content, parentId }),
      });
      setName('');
      setContent('');
      await load();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'The item could not be saved.');
    }
  };

  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      setError('Files must be 5 MiB or smaller.');
      return;
    }
    setUploading(true);
    setError('');
    setNotice('');
    try {
      const params = new URLSearchParams({ name: file.name });
      if (parentId !== null) params.set('parentId', String(parentId));
      const response = await fetch(`${apiUrl('/api/storage/upload')}?${params}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/octet-stream', 'X-WioBr-Request': '1' },
        body: file,
      });
      if (!response.ok) {
        const result = await response.json() as { error?: string };
        throw new Error(result.error || `Upload failed (${response.status})`);
      }
      setNotice('File saved. It is served as a download and is not executed.');
      await load();
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : 'Upload failed.');
    } finally {
      setUploading(false);
    }
  };

  const remove = async (item: StorageItem) => {
    const consequence = item.kind === 'folder' ? ' and all items inside it' : '';
    if (!window.confirm(`Delete "${item.name}"${consequence}? This cannot be undone.`)) return;
    try {
      await api(`/api/storage/${item.id}`, { method: 'DELETE' });
      await load();
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : 'Could not delete this item.');
    }
  };

  const saveEdit = async (event: FormEvent) => {
    event.preventDefault();
    if (!editing) return;
    try {
      await api(`/api/storage/${editing.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: editing.name, ...(editing.kind === 'file' || editing.kind === 'folder' ? {} : { content: editing.content || '' }) }),
      });
      setEditing(null);
      await load();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not update this item.');
    }
  };

  const download = async (item: StorageItem) => {
    try {
      const response = await fetch(apiUrl(`/api/storage/${item.id}/download`), { credentials: 'include' });
      if (!response.ok) throw new Error(response.status === 404 ? 'File not found.' : `Download failed (${response.status})`);
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = item.name;
      link.click();
      URL.revokeObjectURL(objectUrl);
    } catch (downloadError) {
      setError(downloadError instanceof Error ? downloadError.message : 'Download failed.');
    }
  };

  return (
    <section className="module-view">
      <header className="page-heading">
        <div>
          <h1>Temporary cloud storage</h1>
          <p>Files and notes are account-owned, expire after 30 days, and use the configured data disk.</p>
        </div>
        <label className="button upload-button">
          {uploading ? 'Uploading…' : 'Upload file'}
          <input type="file" onChange={upload} disabled={uploading} />
        </label>
      </header>
      <div className="storage-quota panel">
        <div>
          <strong>{readableSize(usedBytes)}</strong>
          <span className="muted"> of {readableSize(quotaBytes)} used</span>
        </div>
        <div className="quota-track" role="progressbar" aria-label="Storage quota used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={usedPercent}>
          <span style={{ width: `${usedPercent}%` }} />
        </div>
        <span className="muted">5 MiB max per file · 100 MiB per account</span>
      </div>
      <div className="storage-grid">
        <section className="panel">
          <div className="section-heading">
            <div>
              <h2>{parentId === null ? 'Your items' : parents.at(-1)?.name || 'Folder'}</h2>
              <p className="muted">{items.length} item{items.length === 1 ? '' : 's'} in this folder</p>
            </div>
            {parentId !== null && <button className="button" onClick={() => { setParents((path) => path.slice(0, -1)); setParentId(parents.length > 1 ? parents[parents.length - 2].id : null); }}>Back</button>}
          </div>
          {loading ? <p role="status">Loading items…</p> : error ? <div className="error-block"><p role="alert">{error}</p><button className="text-button" onClick={() => void load()}>Retry</button></div> : (
            <div className="storage-items">
              {items.length === 0 && <p className="empty-state">This folder is empty. Create a folder, save a note or upload a file.</p>}
              {items.map((item) => (
                <article className="storage-item" key={item.id}>
                  <div className="storage-item-main">
                    {item.kind === 'folder'
                      ? <button className="item-title" onClick={() => { setParents((path) => [...path, { id: item.id, name: item.name }]); setParentId(item.id); }}>{item.name}</button>
                      : <strong>{item.name}</strong>}
                    <p className="muted">{item.kind} · {item.sizeBytes ? readableSize(item.sizeBytes) : 'No file data'}</p>
                    {item.kind === 'link' && item.content && <a className="text-button" href={item.content} target="_blank" rel="noopener noreferrer">Open saved link</a>}
                    {item.kind !== 'file' && item.kind !== 'folder' && item.content && <p className="storage-preview">{item.content}</p>}
                    {item.expiresAt && <time className="muted" dateTime={item.expiresAt}>Expires {new Date(`${item.expiresAt.replace(' ', 'T')}Z`).toLocaleDateString()}</time>}
                  </div>
                  <div className="item-actions">
                    {item.kind === 'file' && <button className="text-button" onClick={() => void download(item)}>Download</button>}
                    {item.kind !== 'file' && <button className="text-button" onClick={() => setEditing(item)}>Edit</button>}
                    <button className="text-button destructive-link" onClick={() => void remove(item)}>Delete</button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
        <section className="panel storage-create">
          <h2>Save something</h2>
          <p className="muted">Items expire after 30 days. The hosting disk’s persistence still needs verification before production use.</p>
          <form className="stacked-form" onSubmit={submit}>
            <label className="field">
              <span>Item type</span>
              <select className="input" value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}>
                <option value="note">Note</option>
                <option value="snippet">Snippet</option>
                <option value="link">Link</option>
                <option value="draft">Draft</option>
                <option value="folder">Folder</option>
              </select>
            </label>
            <label className="field">
              <span>Name</span>
              <input className="input" value={name} onChange={(event) => setName(event.target.value)} maxLength={160} required />
            </label>
            {kind !== 'folder' && (
              <label className="field">
                <span>{kind === 'link' ? 'HTTP(S) URL' : 'Content'}</span>
                <textarea className="input textarea" value={content} onChange={(event) => setContent(event.target.value)} maxLength={200_000} required />
              </label>
            )}
            <button className="button button-primary" type="submit" disabled={!name.trim() || (kind !== 'folder' && !content.trim())}>Save item</button>
          </form>
        </section>
      </div>
      {notice && <p className="inline-success" role="status">{notice}</p>}
      {editing && (
        <div className="modal-backdrop" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) setEditing(null); }}>
          <form className="modal panel" onSubmit={saveEdit} aria-labelledby="storage-edit-title">
            <h2 id="storage-edit-title">Edit {editing.kind}</h2>
            <label className="field"><span>Name</span><input className="input" value={editing.name} onChange={(event) => setEditing({ ...editing, name: event.target.value })} maxLength={160} required /></label>
            {editing.kind !== 'folder' && <label className="field"><span>Content</span><textarea className="input textarea" value={editing.content || ''} onChange={(event) => setEditing({ ...editing, content: event.target.value })} maxLength={200_000} /></label>}
            <div className="button-row"><button className="button" type="button" onClick={() => setEditing(null)}>Cancel</button><button className="button button-primary" type="submit">Save changes</button></div>
          </form>
        </div>
      )}
    </section>
  );
}
