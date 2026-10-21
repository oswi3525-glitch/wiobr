import { FormEvent, useEffect, useState } from 'react';
import { api } from '../lib/api';

type AdminUser = { id: number; username: string; role: 'admin' | 'member'; disabled: boolean; created_at: string; active_sessions?: number };
type AuditLog = { id: number; actor_user_id: number | null; action: string; target_type: string | null; target_id: string | null; scope: string | null; metadata: string | null; created_at: string };
type HistoryEntry = { id: number; userId: number; username: string; query: string; privateSession: boolean; createdAt: string };
type TechnicalLog = { id: number; level: string; message: string; context: string | null; createdAt: string };
type RuntimeInfo = { alwaysOnEnabled: boolean; tasks: { total: number; active: number }; memory: { rss: number; heapUsed: number; external: number; arrayBuffers: number; heapTotal: number }; uptimeSeconds: number; limitation: string };

export function AdminPanel({ currentUserId }: { currentUserId: number }) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [technicalLogs, setTechnicalLogs] = useState<TechnicalLog[]>([]);
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'member' | 'admin'>('member');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setError('');
    try {
      const [userResult, auditResult, historyResult, technicalResult, runtimeResult] = await Promise.all([
        api<{ users: AdminUser[] }>('/api/admin/users'),
        api<{ logs: AuditLog[] }>('/api/admin/audit-logs?limit=100'),
        api<{ history: HistoryEntry[] }>('/api/admin/search-history?limit=100'),
        api<{ logs: TechnicalLog[] }>('/api/admin/technical-logs?limit=100'),
        api<RuntimeInfo>('/api/admin/runtime'),
      ]);
      setUsers(userResult.users);
      setAuditLogs(auditResult.logs);
      setHistory(historyResult.history);
      setTechnicalLogs(technicalResult.logs);
      setRuntime(runtimeResult);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Admin data could not be loaded.');
    }
  };

  useEffect(() => { void load(); }, []);

  const createUser = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await api('/api/admin/users', { method: 'POST', body: JSON.stringify({ username, password, role }) });
      setUsername('');
      setPassword('');
      setRole('member');
      setNotice('Account created. Share the initial password through a secure channel.');
      await load();
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Account could not be created.');
    } finally {
      setBusy(false);
    }
  };

  const updateUser = async (user: AdminUser, update: { disabled?: boolean; role?: 'admin' | 'member'; password?: string }) => {
    setError('');
    setNotice('');
    try {
      await api(`/api/admin/users/${user.id}`, { method: 'PATCH', body: JSON.stringify(update) });
      setNotice(`Updated ${user.username}.`);
      await load();
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : 'Account update failed.');
    }
  };

  const revokeSessions = async (user: AdminUser) => {
    if (!window.confirm(`Revoke all active sessions for ${user.username}?`)) return;
    try {
      await api(`/api/admin/users/${user.id}/revoke-sessions`, { method: 'POST', body: JSON.stringify({}) });
      setNotice(`Sessions revoked for ${user.username}.`);
      await load();
    } catch (revokeError) {
      setError(revokeError instanceof Error ? revokeError.message : 'Session revocation failed.');
    }
  };

  const toggleRuntime = async () => {
    if (!runtime) return;
    const next = !runtime.alwaysOnEnabled;
    if (!window.confirm(`${next ? 'Resume' : 'Pause'} all active website monitors?`)) return;
    try {
      await api('/api/admin/runtime', { method: 'PUT', body: JSON.stringify({ alwaysOnEnabled: next }) });
      await load();
    } catch (toggleError) {
      setError(toggleError instanceof Error ? toggleError.message : 'Runtime setting could not be changed.');
    }
  };

  const clearHistory = async () => {
    const before = window.prompt('Delete search history older than this ISO date/time? (The affected record count is limited to 1,000 per request.)', new Date().toISOString());
    if (!before) return;
    if (!window.confirm(`Confirm deleting search records before ${before}? This action will be recorded in the audit trail.`)) return;
    try {
      const result = await api<{ deleted: number }>('/api/admin/search-history', {
        method: 'DELETE',
        body: JSON.stringify({ before, confirm: true }),
      });
      setNotice(`${result.deleted} search records deleted.`);
      await load();
    } catch (clearError) {
      setError(clearError instanceof Error ? clearError.message : 'Search history could not be deleted.');
    }
  };

  const clearTechnicalLogs = async () => {
    const before = window.prompt('Delete technical logs older than this ISO date/time? (The affected record count is limited to 1,000 per request.)', new Date().toISOString());
    if (!before) return;
    if (!window.confirm(`Confirm deleting technical logs before ${before}? This action will be recorded in the audit trail.`)) return;
    try {
      const result = await api<{ deleted: number }>('/api/admin/technical-logs', {
        method: 'DELETE',
        body: JSON.stringify({ before, confirm: true }),
      });
      setNotice(`${result.deleted} technical log records deleted.`);
      await load();
    } catch (clearError) {
      setError(clearError instanceof Error ? clearError.message : 'Technical logs could not be deleted.');
    }
  };

  return (
    <section className="module-view admin-view">
      <header className="page-heading">
        <div><h1>Admin console</h1><p>Account controls, retained data, audit records and server resource state.</p></div>
        <button className="button" onClick={() => void load()}>Refresh</button>
      </header>
      {error && <div className="error-block" role="alert"><p>{error}</p></div>}
      {notice && <p className="inline-success" role="status">{notice}</p>}
      <div className="admin-grid">
        <section className="panel">
          <div className="section-heading"><div><h2>Server resources</h2><p className="muted">Live values from this process</p></div></div>
          {runtime ? (
            <>
              <div className="resource-values">
                <div><span>Process memory</span><strong>{(runtime.memory.rss / 1024 / 1024).toFixed(0)} MB RSS</strong></div>
                <div><span>Heap used</span><strong>{(runtime.memory.heapUsed / 1024 / 1024).toFixed(0)} MB</strong></div>
                <div><span>Uptime</span><strong>{Math.floor(runtime.uptimeSeconds / 3600)} h</strong></div>
                <div><span>Website monitors</span><strong>{runtime.tasks.active} active / {runtime.tasks.total} saved</strong></div>
              </div>
              <p className="muted">{runtime.limitation}</p>
              <div className="button-row">
                <button className={`button ${runtime.alwaysOnEnabled ? 'button-danger' : 'button-primary'}`} onClick={() => void toggleRuntime()}>
                  {runtime.alwaysOnEnabled ? 'Pause all monitors' : 'Resume monitors'}
                </button>
                <span className="muted">Global kill switch</span>
              </div>
            </>
          ) : <p className="muted">Runtime data unavailable.</p>}
        </section>
        <section className="panel">
          <h2>Create an account</h2>
          <p className="muted">Initial credentials are shown once. Send them outside this app through a secure channel.</p>
          <form className="stacked-form" onSubmit={createUser}>
            <label className="field"><span>Username</span><input className="input" value={username} onChange={(event) => setUsername(event.target.value)} minLength={3} maxLength={64} required /></label>
            <label className="field"><span>Initial password</span><input className="input" type="password" value={password} onChange={(event) => setPassword(event.target.value)} minLength={12} maxLength={256} autoComplete="new-password" required /></label>
            <label className="field"><span>Role</span><select className="input" value={role} onChange={(event) => setRole(event.target.value as typeof role)}><option value="member">Member</option><option value="admin">Admin</option></select></label>
            <button className="button button-primary" type="submit" disabled={busy}>{busy ? 'Creating…' : 'Create account'}</button>
          </form>
        </section>
      </div>
      <section className="panel admin-data-panel">
        <div className="section-heading"><div><h2>Member accounts</h2><p className="muted">{users.length} account{users.length === 1 ? '' : 's'} · session details are private to each user</p></div></div>
        {users.length === 0 ? <p className="empty-state">No member accounts.</p> : (
          <div className="table-scroll"><table>
            <thead><tr><th>Account</th><th>Role</th><th>State</th><th>Active sessions</th><th>Actions</th></tr></thead>
            <tbody>{users.map((user) => (
              <tr key={user.id}>
                <td><strong>{user.username}</strong><span className="table-sub">Created {new Date(`${user.created_at.replace(' ', 'T')}Z`).toLocaleDateString()}</span></td>
                <td>
                  <select aria-label={`Role for ${user.username}`} className="input compact-input" value={user.role} disabled={user.id === currentUserId} onChange={(event) => void updateUser(user, { role: event.target.value as AdminUser['role'] })}>
                    <option value="member">Member</option><option value="admin">Admin</option>
                  </select>
                </td>
                <td><span className={`pill ${user.disabled ? 'pill-neutral' : 'pill-positive'}`}>{user.disabled ? 'Disabled' : 'Enabled'}</span></td>
                <td className="num">{user.active_sessions ?? 0}</td>
                <td><div className="table-actions">
                  <button className="text-button" disabled={user.id === currentUserId} onClick={() => void updateUser(user, { disabled: !user.disabled })}>{user.disabled ? 'Enable' : 'Disable'}</button>
                  <button className="text-button" onClick={() => { const nextPassword = window.prompt(`Set a new password for ${user.username} (minimum 12 characters)`); if (nextPassword) void updateUser(user, { password: nextPassword }); }}>Reset password</button>
                  <button className="text-button" onClick={() => void revokeSessions(user)}>Revoke sessions</button>
                </div></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </section>
      <div className="admin-grid admin-grid-equal">
        <section className="panel">
          <div className="section-heading"><div><h2>Search history</h2><p className="muted">Server-side records, including Private Session searches.</p></div><button className="text-button destructive-link" onClick={() => void clearHistory()}>Delete older records</button></div>
          {history.length === 0 ? <p className="empty-state">No search records found.</p> : <div className="admin-list">{history.map((entry) => (
            <article className="admin-list-row" key={entry.id}><strong>{entry.username}</strong><span>{entry.query}</span><span className="muted">{entry.privateSession ? 'Private Session' : 'Standard'}</span><time className="muted" dateTime={entry.createdAt}>{new Date(`${entry.createdAt.replace(' ', 'T')}Z`).toLocaleString()}</time></article>
          ))}</div>}
        </section>
        <section className="panel">
          <div className="section-heading"><div><h2>Technical logs</h2><p className="muted">30-day retention. Audit records are kept separately.</p></div><button className="text-button destructive-link" onClick={() => void clearTechnicalLogs()}>Delete older records</button></div>
          {technicalLogs.length === 0 ? <p className="empty-state">No technical errors recorded.</p> : <div className="admin-list">{technicalLogs.map((entry) => (
            <article className="admin-list-row log-row" key={entry.id}><span className={`pill ${entry.level === 'error' ? 'pill-negative' : 'pill-neutral'}`}>{entry.level}</span><span>{entry.message}</span><time className="muted" dateTime={entry.createdAt}>{new Date(`${entry.createdAt.replace(' ', 'T')}Z`).toLocaleString()}</time></article>
          ))}</div>}
        </section>
      </div>
      <section className="panel">
        <div className="section-heading"><div><h2>Audit trail</h2><p className="muted">Administrative and security events. Admins cannot delete audit records; retention is 365 days.</p></div></div>
        {auditLogs.length === 0 ? <p className="empty-state">No audit events recorded.</p> : <div className="table-scroll"><table><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Target</th><th>Scope</th></tr></thead><tbody>
          {auditLogs.map((entry) => <tr key={entry.id}><td>{new Date(`${entry.created_at.replace(' ', 'T')}Z`).toLocaleString()}</td><td>{users.find((user) => user.id === entry.actor_user_id)?.username || (entry.actor_user_id ? `Account ${entry.actor_user_id}` : 'System')}</td><td>{entry.action}</td><td>{entry.target_type || '—'}{entry.target_id ? ` · ${entry.target_id}` : ''}</td><td>{entry.scope || '—'}</td></tr>)}
        </tbody></table></div>}
      </section>
    </section>
  );
}
