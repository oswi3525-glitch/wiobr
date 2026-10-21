import { useCallback, useEffect, useState } from 'react';
import { AdminPanel } from '../components/AdminPanel';
import { ChatPanel } from '../components/ChatPanel';
import { ExtensionsPanel } from '../components/ExtensionsPanel';
import { PeoplePanel } from '../components/PeoplePanel';
import { SearchPanel, SearchState } from '../components/SearchPanel';
import { SettingsPanel } from '../components/SettingsPanel';
import { StoragePanel } from '../components/StoragePanel';
import { TasksPanel } from '../components/TasksPanel';
import { WorkspaceBrowser } from '../components/WorkspaceBrowser';
import { useAuth } from '../auth';
import { api } from '../lib/api';

type Section = 'workspace' | 'search' | 'chat' | 'storage' | 'tasks' | 'people' | 'extensions' | 'settings' | 'admin';
type Health = { status: string; uptimeSeconds: number; runtime?: { enabled: boolean; activeChecks: number } };

const navigation: Array<{ id: Section; label: string; icon: string }> = [
  { id: 'workspace', label: 'Workspace', icon: '▱' },
  { id: 'search', label: 'Cloud Search', icon: '⌕' },
  { id: 'chat', label: 'Group chat', icon: '◌' },
  { id: 'storage', label: 'Cloud storage', icon: '▤' },
  { id: 'tasks', label: 'Always-On', icon: '◷' },
  { id: 'people', label: 'Members', icon: '◎' },
  { id: 'extensions', label: 'Extensions', icon: '◇' },
  { id: 'settings', label: 'Settings', icon: '⚙' },
];

export function Dashboard() {
  const { user, logout } = useAuth();
  const [section, setSection] = useState<Section>('workspace');
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    try {
      return localStorage.getItem('wiobr.theme') === 'dark' ? 'dark' : 'light';
    } catch {
      return 'light';
    }
  });
  const [search, setSearch] = useState<SearchState | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [health, setHealth] = useState<Health | null>(null);
  const [healthError, setHealthError] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [actionError, setActionError] = useState('');
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('wiobr.theme', theme); } catch { /* Theme remains available for this session. */ }
  }, [theme]);

  useEffect(() => {
    let disposed = false;
    const loadHealth = async () => {
      try {
        const result = await api<Health>('/api/health');
        if (!disposed) {
          setHealth(result);
          setHealthError(false);
        }
      } catch {
        if (!disposed) setHealthError(true);
      }
    };
    void loadHealth();
    const timer = window.setInterval(() => { void loadHealth(); }, 60_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, []);

  const runSearch = useCallback(async (query: string, privateSession: boolean) => {
    setSearchLoading(true);
    setSearchError('');
    setSection('search');
    try {
      const result = await api<Omit<SearchState, 'query'>>('/api/search', {
        method: 'POST',
        body: JSON.stringify({ query, privateSession }),
      });
      setSearch({ ...result, query });
    } catch (error) {
      setSearchError(error instanceof Error ? error.message : 'Search could not be completed.');
    } finally {
      setSearchLoading(false);
    }
  }, []);

  const navigate = (next: Section) => {
    setSection(next);
    setSidebarOpen(false);
    setActionError('');
  };

  const signOut = async () => {
    setSigningOut(true);
    setActionError('');
    try {
      await logout();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Could not sign out. Please retry.');
    } finally {
      setSigningOut(false);
    }
  };

  const activeLabel = navigation.find((item) => item.id === section)?.label ?? 'Admin console';

  return (
    <div className="app-shell">
      <aside className={`sidebar${sidebarOpen ? ' sidebar-open' : ''}`}>
        <div className="sidebar-brand">
          <span className="brand-mark" aria-hidden="true">W</span>
          <span><strong>WioBrowse</strong><small>Cloud workspace</small></span>
          <button className="icon-button sidebar-close" aria-label="Close navigation" onClick={() => setSidebarOpen(false)}>×</button>
        </div>
        <div className="sidebar-caption">YOUR SPACE</div>
        <nav className="side-nav" aria-label="Main navigation">
          {navigation.map((item) => (
            <button key={item.id} className={`nav-item${section === item.id ? ' is-active' : ''}`} onClick={() => navigate(item.id)} aria-current={section === item.id ? 'page' : undefined}>
              <span className="nav-icon" aria-hidden="true">{item.icon}</span>{item.label}
              {item.id === 'tasks' && health?.runtime?.activeChecks ? <span className="nav-count">{health.runtime.activeChecks}</span> : null}
            </button>
          ))}
          {user?.role === 'admin' && (
            <>
              <div className="sidebar-caption admin-caption">MANAGEMENT</div>
              <button className={`nav-item${section === 'admin' ? ' is-active' : ''}`} onClick={() => navigate('admin')} aria-current={section === 'admin' ? 'page' : undefined}>
                <span className="nav-icon" aria-hidden="true">▦</span>Admin console
              </button>
            </>
          )}
        </nav>
        <div className="sidebar-bottom">
          <div className="server-status">
            <span className={`status-dot ${healthError ? 'status-offline' : health ? 'status-online' : ''}`} />
            <span><strong>{healthError ? 'Server unavailable' : health ? 'Server connected' : 'Checking server'}</strong><small>{health?.runtime ? `${health.runtime.activeChecks} monitor checks active` : 'WioBrowse services'}</small></span>
          </div>
          <div className="account-card">
            <span className="account-avatar">{(user?.username || 'U').slice(0, 1).toUpperCase()}</span>
            <span className="account-meta"><strong>{user?.username}</strong><small>{user?.role}</small></span>
            <button className="icon-button signout-button" onClick={() => void signOut()} disabled={signingOut} aria-label="Sign out" title="Sign out">↗</button>
          </div>
        </div>
      </aside>
      {sidebarOpen && <button className="mobile-scrim" aria-label="Close navigation" onClick={() => setSidebarOpen(false)} />}
      <main className="main-shell">
        <header className="topbar">
          <button className="icon-button menu-button" aria-label="Open navigation" aria-expanded={sidebarOpen} onClick={() => setSidebarOpen(true)}>☰</button>
          <div className="breadcrumb"><span>WioBrowse</span><span aria-hidden="true">/</span><strong>{activeLabel}</strong></div>
          <div className="topbar-actions">
            <span className={`top-status ${healthError ? 'top-status-offline' : ''}`}><span className="status-dot" />{healthError ? 'Offline' : health ? 'Operational' : 'Checking'}</span>
            <button className="theme-button" onClick={() => setTheme((current) => current === 'light' ? 'dark' : 'light')} aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} theme`} title={`Switch to ${theme === 'light' ? 'dark' : 'light'} theme`}>{theme === 'light' ? '◐' : '☼'}</button>
          </div>
        </header>
        {actionError && <div className="global-notice error-block" role="alert"><p>{actionError}</p><button className="text-button" onClick={() => setActionError('')}>Dismiss</button></div>}
        <div className="content-area">
          {section === 'workspace' && user && <WorkspaceBrowser userId={user.id} onSearch={runSearch} />}
          {section === 'search' && <SearchPanel state={search} loading={searchLoading} error={searchError} onSearch={runSearch} />}
          {section === 'chat' && <ChatPanel />}
          {section === 'storage' && <StoragePanel />}
          {section === 'tasks' && <TasksPanel />}
          {section === 'people' && <PeoplePanel />}
          {section === 'extensions' && <ExtensionsPanel />}
          {section === 'settings' && <SettingsPanel theme={theme} setTheme={setTheme} />}
          {section === 'admin' && user?.role === 'admin' && <AdminPanel currentUserId={user.id} />}
        </div>
        <footer className="app-footer"><span>WioBrowse Cloud</span><span>Saving the workspace does not keep external websites running.</span></footer>
      </main>
    </div>
  );
}
