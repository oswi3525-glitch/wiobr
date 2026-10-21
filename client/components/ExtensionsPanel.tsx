import { useEffect, useState } from 'react';
import { api } from '../lib/api';

type Extension = {
  id: number;
  name: string;
  version: string;
  description: string;
  sourceUrl: string;
  permissions: string[];
  enabled: boolean;
};

export function ExtensionsPanel() {
  const [extensions, setExtensions] = useState<Extension[]>([]);
  const [runtime, setRuntime] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setError('');
    try {
      const result = await api<{ extensions: Extension[]; runtime: string }>('/api/extensions');
      setExtensions(result.extensions);
      setRuntime(result.runtime);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Extension catalog could not be loaded.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  const toggle = async (extension: Extension) => {
    setError('');
    try {
      await api(`/api/extensions/${extension.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: !extension.enabled }),
      });
      await load();
    } catch (toggleError) {
      setError(toggleError instanceof Error ? toggleError.message : 'Extension preference could not be saved.');
    }
  };

  return (
    <section className="module-view">
      <header className="page-heading"><div><h1>Extensions</h1><p>Manage approved WioBrowse capabilities and their requested permissions.</p></div></header>
      <div className="notice notice-warning">Extension records are metadata only. The server does not download or execute third-party code, and Chrome/Firefox extensions are not supported.</div>
      {loading ? <p role="status">Loading extension catalog…</p> : error ? <div className="error-block" role="alert"><p>{error}</p><button className="text-button" onClick={() => void load()}>Retry</button></div> : extensions.length === 0
        ? <section className="panel"><p className="empty-state">No extensions have been approved by an administrator.</p></section>
        : <div className="extension-list">{extensions.map((extension) => (
          <article className="panel extension-row" key={extension.id}>
            <div><div className="section-heading"><h2>{extension.name}</h2><span className="muted">Version {extension.version}</span></div><p>{extension.description}</p>
              <p className="muted">Permissions: {extension.permissions.length ? extension.permissions.join(', ') : 'None declared'}</p>
              <a className="text-button" href={extension.sourceUrl} target="_blank" rel="noopener noreferrer">View source</a>
            </div>
            <label className="toggle-row extension-toggle"><span>{extension.enabled ? 'Enabled' : 'Disabled'}</span><input type="checkbox" checked={extension.enabled} onChange={() => void toggle(extension)} aria-label={`${extension.enabled ? 'Disable' : 'Enable'} ${extension.name}`} /></label>
          </article>
        ))}</div>}
      <p className="muted">{runtime}</p>
    </section>
  );
}
