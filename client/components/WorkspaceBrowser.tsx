import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';
import { ChatPanel } from './ChatPanel';

type BrowserTab = { url: string; title: string };
type WorkspaceData = { tabs: BrowserTab[]; activeTab: number; theme: 'light' | 'dark' | 'system' };
type Workspace = { id: number; name: string; data: WorkspaceData; version: number; updatedAt: string };
type WorkspaceResponse = { workspaces: Workspace[] };

const emptyData: WorkspaceData = { tabs: [{ url: '', title: 'New tab' }], activeTab: 0, theme: 'system' };

function resolveAddress(value: string): { kind: 'url'; url: string } | { kind: 'search'; query: string } | { kind: 'invalid' } {
  const text = value.trim();
  if (!text) return { kind: 'invalid' };
  if (!/^[a-z][a-z\d+.-]*:/i.test(text) && (/\s/.test(text) || (!text.includes('.') && !text.includes(':')))) {
    return { kind: 'search', query: text };
  }
  try {
    const url = new URL(/^[a-z][a-z\d+.-]*:/i.test(text) ? text : `https://${text}`);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return { kind: 'invalid' };
    return { kind: 'url', url: url.href };
  } catch {
    return { kind: 'invalid' };
  }
}

function localDraftKey(userId: number) {
  return `wiobr.workspace-draft.${userId}`;
}

export type SearchHandler = (query: string, privateSession: boolean) => Promise<void>;

export function WorkspaceBrowser({ userId, onSearch }: { userId: number; onSearch: SearchHandler }) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [current, setCurrent] = useState<Workspace | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'conflict' | 'error'>('saved');
  const [address, setAddress] = useState('');
  const [privateSession, setPrivateSession] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(0);
  const [restoreDraft, setRestoreDraft] = useState<WorkspaceData | null>(null);
  const [bookmarks, setBookmarks] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem(`wiobr.bookmarks.${userId}`) || '[]') as string[]; }
    catch { return []; }
  });
  const [newWorkspaceName, setNewWorkspaceName] = useState('');
  const [workspaceActionError, setWorkspaceActionError] = useState('');
  const pending = useRef<{ workspaceId: number; data: WorkspaceData } | null>(null);
  const saveBusy = useRef(false);
  const saveTimer = useRef<number | undefined>(undefined);

  const selectedTab = current?.data.tabs[current.data.activeTab] ?? null;

  const loadWorkspaces = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const result = await api<WorkspaceResponse>('/api/workspaces');
      setWorkspaces(result.workspaces);
      setCurrent((existing) => result.workspaces.find((workspace) => workspace.id === existing?.id) ?? result.workspaces[0] ?? null);
      const stored = localStorage.getItem(localDraftKey(userId));
      if (stored) {
        const draft = JSON.parse(stored) as { workspaceId: number; version: number; savedAt: number; data: WorkspaceData };
        const remote = result.workspaces.find((workspace) => workspace.id === draft.workspaceId);
        if (remote && draft.version === remote.version && draft.savedAt > Date.parse(remote.updatedAt.replace(' ', 'T') + 'Z')) {
          setRestoreDraft(draft.data);
        }
      }
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Could not load workspaces.');
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => { void loadWorkspaces(); }, [loadWorkspaces]);

  useEffect(() => {
    setAddress(selectedTab?.url || '');
    setHistory(selectedTab?.url ? [selectedTab.url] : []);
    setHistoryIndex(selectedTab?.url ? 0 : -1);
  }, [current?.id, current?.data.activeTab, selectedTab?.url]);

  const flushSave = useCallback(async () => {
    if (saveBusy.current || !pending.current) return;
    saveBusy.current = true;
    const item = pending.current;
    pending.current = null;
    const base = workspaces.find((workspace) => workspace.id === item.workspaceId);
    if (!base) {
      saveBusy.current = false;
      return;
    }
    setSaveState('saving');
    try {
      const response = await api<{ version: number; updatedAt?: string }>(`/api/workspaces/${item.workspaceId}`, {
        method: 'PUT',
        headers: { 'If-Match': String(base.version) },
        body: JSON.stringify({ name: base.name, ...item.data }),
      });
      setWorkspaces((list) => list.map((workspace) => workspace.id === item.workspaceId
        ? { ...workspace, data: item.data, version: response.version, updatedAt: new Date().toISOString() }
        : workspace));
      setCurrent((workspace) => workspace?.id === item.workspaceId
        ? { ...workspace, data: item.data, version: response.version, updatedAt: new Date().toISOString() }
        : workspace);
      localStorage.setItem(localDraftKey(userId), JSON.stringify({
        workspaceId: item.workspaceId,
        version: response.version,
        savedAt: Date.now(),
        data: item.data,
      }));
      setSaveState('saved');
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      setSaveState(message.includes('changed in another session') ? 'conflict' : 'error');
      if (!message.includes('changed in another session')) setWorkspaceActionError(message || 'Workspace could not be saved.');
      pending.current = null;
    } finally {
      saveBusy.current = false;
      if (pending.current && saveState !== 'conflict') {
        saveTimer.current = window.setTimeout(() => { void flushSave(); }, 50);
      }
    }
  }, [saveState, userId, workspaces]);

  const scheduleSave = useCallback((workspace: Workspace, data: WorkspaceData) => {
    pending.current = { workspaceId: workspace.id, data };
    setCurrent({ ...workspace, data });
    localStorage.setItem(localDraftKey(userId), JSON.stringify({
      workspaceId: workspace.id,
      version: workspace.version,
      savedAt: Date.now(),
      data,
    }));
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => { void flushSave(); }, 650);
  }, [flushSave, userId]);

  useEffect(() => () => window.clearTimeout(saveTimer.current), []);

  const updateData = (update: (data: WorkspaceData) => WorkspaceData) => {
    if (!current) return;
    scheduleSave(current, update(current.data));
  };

  const createWorkspace = async (event: FormEvent) => {
    event.preventDefault();
    const name = newWorkspaceName.trim();
    if (!name) return;
    setWorkspaceActionError('');
    try {
      const created = await api<Workspace>('/api/workspaces', {
        method: 'POST',
        body: JSON.stringify({ name, ...emptyData }),
      });
      setWorkspaces((list) => [created, ...list]);
      setCurrent(created);
      setNewWorkspaceName('');
    } catch (error) {
      setWorkspaceActionError(error instanceof Error ? error.message : 'Could not create workspace.');
    }
  };

  const duplicateWorkspace = async () => {
    if (!current) return;
    const name = window.prompt('Name the copy');
    if (!name?.trim()) return;
    try {
      const duplicate = await api<Workspace>(`/api/workspaces/${current.id}/duplicate`, {
        method: 'POST',
        body: JSON.stringify({ name: name.trim() }),
      });
      setWorkspaces((list) => [duplicate, ...list]);
      setCurrent(duplicate);
    } catch (error) {
      setWorkspaceActionError(error instanceof Error ? error.message : 'Could not duplicate workspace.');
    }
  };

  const renameWorkspace = async () => {
    if (!current) return;
    const name = window.prompt('Rename workspace', current.name)?.trim();
    if (!name || name === current.name) return;
    try {
      const saved = await api<{ version: number }>(`/api/workspaces/${current.id}`, {
        method: 'PUT',
        headers: { 'If-Match': String(current.version) },
        body: JSON.stringify({ name, ...current.data }),
      });
      setWorkspaces((list) => list.map((workspace) => workspace.id === current.id ? { ...workspace, name, version: saved.version } : workspace));
      setCurrent({ ...current, name, version: saved.version });
      setSaveState('saved');
    } catch (error) {
      setSaveState('conflict');
      setWorkspaceActionError(error instanceof Error ? error.message : 'Could not rename workspace.');
    }
  };

  const deleteWorkspace = async () => {
    if (!current || !window.confirm(`Delete the "${current.name}" workspace and its saved tabs? This cannot be undone.`)) return;
    try {
      await api(`/api/workspaces/${current.id}`, { method: 'DELETE' });
      const remaining = workspaces.filter((workspace) => workspace.id !== current.id);
      setWorkspaces(remaining);
      setCurrent(remaining[0] ?? null);
    } catch (error) {
      setWorkspaceActionError(error instanceof Error ? error.message : 'Could not delete workspace.');
    }
  };

  const navigate = async (event: FormEvent) => {
    event.preventDefault();
    const target = resolveAddress(address);
    if (target.kind === 'invalid') {
      setWorkspaceActionError('Enter a valid HTTP(S) website address or search phrase.');
      return;
    }
    setWorkspaceActionError('');
    if (target.kind === 'url') {
      let destination = target.url;
      try {
        const prefs = await api<{ cleanTracking: boolean }>('/api/privacy/settings');
        if (prefs.cleanTracking) {
          const cleaned = await api<{ url: string }>('/api/privacy/clean-url', {
            method: 'POST',
            body: JSON.stringify({ url: target.url }),
          });
          destination = cleaned.url;
        }
      } catch {
        setWorkspaceActionError('Could not apply privacy settings. URL was not opened.');
        return;
      }
      setAddress(destination);
      updateTab(destination);
      setHistory((old) => [...old.slice(0, historyIndex + 1), destination]);
      setHistoryIndex((old) => old + 1);
      return;
    }
    await onSearch(target.query, privateSession);
  };

  const updateTab = (url: string) => {
    updateData((data) => ({
      ...data,
      tabs: data.tabs.map((tab, index) => index === data.activeTab ? { ...tab, url, title: new URL(url).hostname } : tab),
    }));
  };

  const addTab = () => updateData((data) => {
    const tabs = [...data.tabs, { url: '', title: 'New tab' }];
    return { ...data, tabs, activeTab: tabs.length - 1 };
  });

  const closeTab = (index: number) => updateData((data) => {
    const tabs = data.tabs.filter((_, tabIndex) => tabIndex !== index);
    if (!tabs.length) tabs.push({ url: '', title: 'New tab' });
    const activeTab = data.activeTab === index ? Math.max(0, index - 1) : data.activeTab > index ? data.activeTab - 1 : data.activeTab;
    return { ...data, tabs, activeTab: Math.min(activeTab, tabs.length - 1) };
  });

  const toggleBookmark = () => {
    if (!selectedTab?.url) return;
    const next = bookmarks.includes(selectedTab.url)
      ? bookmarks.filter((bookmark) => bookmark !== selectedTab.url)
      : [...bookmarks, selectedTab.url];
    setBookmarks(next);
    localStorage.setItem(`wiobr.bookmarks.${userId}`, JSON.stringify(next));
  };

  const goHistory = (offset: -1 | 1) => {
    const next = historyIndex + offset;
    if (next < 0 || next >= history.length) return;
    setHistoryIndex(next);
    setAddress(history[next]);
    updateTab(history[next]);
  };

  const resetToHome = () => {
    setAddress('');
    updateData((data) => ({
      ...data,
      tabs: data.tabs.map((tab, index) => index === data.activeTab ? { url: '', title: 'New tab' } : tab),
    }));
  };

  const tabLabel = useMemo(() => selectedTab?.title || 'New tab', [selectedTab?.title]);

  if (loading) return <section className="panel"><p role="status">Loading saved workspaces…</p></section>;
  if (loadError) {
    return <section className="panel error-panel"><h2>Workspaces are unavailable</h2><p>{loadError}</p><button className="button" onClick={() => void loadWorkspaces()}>Retry</button></section>;
  }
  if (!workspaces.length) {
    return (
      <section className="panel empty-workspace">
        <h2>Create your first workspace</h2>
        <p className="muted">Saved workspaces sync to your account. Saving a tab does not keep a website running while Safari is closed.</p>
        <form className="inline-form" onSubmit={createWorkspace}>
          <label className="sr-only" htmlFor="workspace-name-first">Workspace name</label>
          <input id="workspace-name-first" className="input" value={newWorkspaceName} onChange={(event) => setNewWorkspaceName(event.target.value)} maxLength={80} placeholder="Workspace name" />
          <button className="button button-primary" type="submit" disabled={!newWorkspaceName.trim()}>Create workspace</button>
        </form>
        {workspaceActionError && <p className="inline-error" role="alert">{workspaceActionError}</p>}
      </section>
    );
  }

  return (
    <div className="browser-layout">
      <div className="browser-column">
        <div className="browser-workspace-bar">
          <label htmlFor="workspace-picker">Workspace</label>
          <select
            id="workspace-picker"
            className="input workspace-picker"
            value={current?.id ?? ''}
            onChange={(event) => setCurrent(workspaces.find((workspace) => workspace.id === Number(event.target.value)) ?? null)}
          >
            {workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
          </select>
          <span className={`save-state save-${saveState}`} role="status">
            {saveState === 'saving' ? 'Saving' : saveState === 'conflict' ? 'Conflict' : saveState === 'error' ? 'Not saved' : 'Saved'}
          </span>
          <button type="button" className="text-button" onClick={() => void duplicateWorkspace()}>Duplicate</button>
          <button type="button" className="text-button" onClick={() => void renameWorkspace()}>Rename</button>
          <button type="button" className="text-button destructive-link" onClick={() => void deleteWorkspace()}>Delete</button>
        </div>
        <form className="new-workspace-form" onSubmit={createWorkspace}>
          <label className="sr-only" htmlFor="workspace-name">Create workspace</label>
          <input id="workspace-name" className="input" value={newWorkspaceName} onChange={(event) => setNewWorkspaceName(event.target.value)} maxLength={80} placeholder="New workspace name" />
          <button className="button" type="submit" disabled={!newWorkspaceName.trim()}>Add workspace</button>
        </form>
        {workspaceActionError && <p className="inline-error" role="alert">{workspaceActionError}</p>}
        {restoreDraft && (
          <div className="notice" role="status">
            <span>A newer local tab snapshot is available for this workspace.</span>
            <button className="text-button" onClick={() => { if (current) updateData(() => restoreDraft); setRestoreDraft(null); }}>Restore snapshot</button>
            <button className="text-button" onClick={() => { localStorage.removeItem(localDraftKey(userId)); setRestoreDraft(null); }}>Dismiss</button>
          </div>
        )}
        {saveState === 'conflict' && (
          <div className="notice notice-warning" role="alert">
            This workspace changed in another session. Your newer local snapshot was kept; reload only after you have copied anything you need.
            <button className="text-button" onClick={() => { setRestoreDraft(current?.data ?? null); void loadWorkspaces(); }}>Load server version</button>
          </div>
        )}
        <div className="tab-strip" role="tablist" aria-label="Workspace tabs">
          {current?.data.tabs.map((tab, index) => (
            <div className={`browser-tab${current.data.activeTab === index ? ' active' : ''}`} key={`${index}:${tab.url}`}>
              <button type="button" role="tab" aria-selected={current.data.activeTab === index} onClick={() => updateData((data) => ({ ...data, activeTab: index }))}>
                <span>{tab.title || 'New tab'}</span>
              </button>
              <button type="button" className="tab-close" aria-label={`Close ${tab.title || 'new tab'}`} onClick={() => closeTab(index)}>×</button>
            </div>
          ))}
          <button type="button" className="tab-add" aria-label="Add tab" onClick={addTab}>+</button>
        </div>
        <div className="browser-toolbar">
          <button type="button" className="toolbar-button" aria-label="Go back" disabled={historyIndex <= 0} onClick={() => goHistory(-1)}>←</button>
          <button type="button" className="toolbar-button" aria-label="Go forward" disabled={historyIndex < 0 || historyIndex >= history.length - 1} onClick={() => goHistory(1)}>→</button>
          <button type="button" className="toolbar-button" aria-label="Home" onClick={resetToHome}>⌂</button>
          <form className="address-form" onSubmit={navigate}>
            <label className="sr-only" htmlFor="address-bar">Website address or search</label>
            <input id="address-bar" className="input address-input" value={address} onChange={(event) => setAddress(event.target.value)} placeholder="Search the web or enter an address" autoComplete="off" />
            <button className="button button-primary address-submit" type="submit">Go</button>
          </form>
          <button type="button" className="toolbar-button" aria-label={selectedTab?.url ? 'Open website again in a new browser tab' : 'Reload'} disabled={!selectedTab?.url} onClick={() => { if (selectedTab?.url) window.open(selectedTab.url, '_blank', 'noopener,noreferrer'); }}>↻</button>
          <button type="button" className={`toolbar-button bookmark-button${selectedTab?.url && bookmarks.includes(selectedTab.url) ? ' is-bookmarked' : ''}`} aria-label={bookmarks.includes(selectedTab?.url || '') ? 'Remove bookmark' : 'Bookmark this website'} disabled={!selectedTab?.url} onClick={toggleBookmark}>☆</button>
        </div>
        <div className="browser-content">
          {!selectedTab?.url ? (
            <div className="browser-home">
              <div className="brand-mark large" aria-hidden="true">W</div>
              <h2>Search from your workspace</h2>
              <p className="muted">Search requests go through WioBrowse. Search history may still be stored server-side, including in Private Session.</p>
              <div className="bookmark-list">
                {bookmarks.length > 0 && <h3>Bookmarks saved on this device</h3>}
                {bookmarks.map((bookmark) => (
                  <button className="bookmark-link" type="button" key={bookmark} onClick={() => { setAddress(bookmark); updateTab(bookmark); }}>
                    {new URL(bookmark).hostname}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="external-site-notice">
              <h2>{tabLabel}</h2>
              <p>This website is not embedded. WioBrowse does not bypass the site’s frame security policies.</p>
              <a className="button button-primary" href={selectedTab.url} target="_blank" rel="noopener noreferrer">Open in your browser</a>
              <p className="muted">Closing this WioBrowse tab only saves the address. Use Always-On Websites to monitor public availability; that check does not run the website’s JavaScript.</p>
            </div>
          )}
        </div>
        <div className="browser-footer">
          <label className="private-toggle">
            <input type="checkbox" checked={privateSession} onChange={(event) => setPrivateSession(event.target.checked)} />
            <span>Private Session</span>
          </label>
          <p>Private Session skips local WioBrowse search history; server-side search history may still be retained by policy.</p>
        </div>
      </div>
      <div className="browser-chat-rail">
        <ChatPanel compact />
      </div>
    </div>
  );
}
