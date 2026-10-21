import { FormEvent, useEffect, useState } from 'react';
import { api } from '../lib/api';

type Task = {
  id: number;
  name: string;
  url: string;
  type: 'monitor';
  status: 'queued' | 'starting' | 'running' | 'degraded' | 'stopped' | 'failed';
  startedAt: string | null;
  uptimeMs: number;
  lastHeartbeatAt: string | null;
  restartCount: number;
  lastError: string | null;
  updatedAt: string;
};
type TaskCheck = { checkedAt: string; httpStatus: number | null; latencyMs: number | null; outcome: 'ok' | 'error'; message: string | null };
type TasksResponse = {
  tasks: Task[];
  status: { enabled: boolean; activeChecks: number; intervalMs: number; executionMode: string };
};

function duration(ms: number) {
  const totalMinutes = Math.floor(ms / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  return days ? `${days}d ${hours}h` : hours ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function statusLabel(status: Task['status']) {
  return status[0].toUpperCase() + status.slice(1);
}

export function TasksPanel() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [runtime, setRuntime] = useState<TasksResponse['status'] | null>(null);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<Task | null>(null);
  const [checks, setChecks] = useState<TaskCheck[]>([]);
  const [logError, setLogError] = useState('');

  const load = async () => {
    setError('');
    try {
      const result = await api<TasksResponse>('/api/tasks');
      setTasks(result.tasks);
      setRuntime(result.status);
      setSelected((previous) => result.tasks.find((task) => task.id === previous?.id) ?? null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Website monitors could not be loaded.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => { void load(); }, 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    setCreating(true);
    setError('');
    try {
      await api('/api/tasks', {
        method: 'POST',
        body: JSON.stringify({ name, url, type: 'monitor' }),
      });
      setName('');
      setUrl('');
      await load();
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Website monitor could not be created.');
    } finally {
      setCreating(false);
    }
  };

  const action = async (task: Task, actionName: 'start' | 'stop' | 'restart') => {
    setError('');
    try {
      await api(`/api/tasks/${task.id}/${actionName}`, { method: 'POST', body: JSON.stringify({}) });
      await load();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : 'Monitor action failed.');
    }
  };

  const remove = async (task: Task) => {
    if (!window.confirm(`Delete monitor "${task.name}" and its check history? This cannot be undone.`)) return;
    try {
      await api(`/api/tasks/${task.id}`, { method: 'DELETE', body: JSON.stringify({ confirm: true }) });
      await load();
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : 'Monitor could not be deleted.');
    }
  };

  const showLogs = async (task: Task) => {
    setSelected(task);
    setLogError('');
    try {
      const result = await api<{ checks: TaskCheck[] }>(`/api/tasks/${task.id}/logs`);
      setChecks(result.checks);
    } catch (loadError) {
      setChecks([]);
      setLogError(loadError instanceof Error ? loadError.message : 'Check history could not be loaded.');
    }
  };

  return (
    <section className="module-view">
      <header className="page-heading">
        <div>
          <h1>Always-On Websites</h1>
          <p>Website Monitor checks public HTTP(S) availability on the server while the app is closed.</p>
        </div>
        {runtime && <span className={`pill ${runtime.enabled ? 'pill-positive' : 'pill-negative'}`}>{runtime.enabled ? 'Server checks enabled' : 'Paused by admin'}</span>}
      </header>
      <div className="notice notice-warning">
        <strong>Monitor is not a browser.</strong> It makes a limited HTTP(S) availability request every five minutes; it does not run JavaScript, preserve website logins or generate traffic. Persistent Web Task is unavailable until the host is verified for isolated long-running processes.
      </div>
      {runtime && <p className="muted runtime-detail">{runtime.executionMode} · up to 3 active monitors per account · one check at a time</p>}
      <div className="tasks-layout">
        <section className="panel">
          <div className="section-heading">
            <div><h2>Your monitors</h2><p className="muted">{tasks.length} saved · {tasks.filter((task) => task.status !== 'stopped').length} active</p></div>
            <button className="text-button" onClick={() => void load()}>Refresh</button>
          </div>
          {loading ? <p role="status">Loading monitors…</p> : error ? <div className="error-block"><p role="alert">{error}</p><button className="text-button" onClick={() => void load()}>Retry</button></div> : (
            <div className="task-list">
              {tasks.length === 0 && <p className="empty-state">No website monitors yet. Add a public site you are authorized to check.</p>}
              {tasks.map((task) => (
                <article className="task-row" key={task.id}>
                  <div className="task-row-main">
                    <div className="task-title-line"><h3>{task.name}</h3><span className={`pill task-${task.status}`}>{statusLabel(task.status)}</span></div>
                    <p className="task-url">{task.url}</p>
                    <p className="muted task-meta">
                      {task.startedAt ? `Uptime ${duration(task.uptimeMs)}` : 'Not started'}
                      {task.lastHeartbeatAt ? ` · checked ${new Date(task.lastHeartbeatAt.replace(' ', 'T') + (task.lastHeartbeatAt.includes('Z') ? '' : 'Z')).toLocaleString()}` : ''}
                      {task.restartCount ? ` · ${task.restartCount} restart${task.restartCount === 1 ? '' : 's'}` : ''}
                    </p>
                    {task.lastError && <p className="inline-error task-error">{task.lastError}</p>}
                  </div>
                  <div className="item-actions">
                    <button className="text-button" onClick={() => void showLogs(task)}>Check history</button>
                    {task.status === 'stopped'
                      ? <button className="text-button" disabled={!runtime?.enabled} onClick={() => void action(task, 'start')}>Start</button>
                      : <button className="text-button" onClick={() => void action(task, 'stop')}>Stop</button>}
                    <button className="text-button" disabled={!runtime?.enabled || task.status === 'stopped'} onClick={() => void action(task, 'restart')}>Restart</button>
                    <button className="text-button destructive-link" onClick={() => void remove(task)}>Delete</button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
        <section className="panel">
          <h2>Create a monitor</h2>
          <p className="muted">Use public sites you have permission to check. Local, private, reserved and metadata addresses are blocked.</p>
          <form className="stacked-form" onSubmit={create}>
            <label className="field"><span>Task name</span><input className="input" value={name} onChange={(event) => setName(event.target.value)} maxLength={80} required /></label>
            <label className="field"><span>Public website URL</span><input className="input" type="url" value={url} onChange={(event) => setUrl(event.target.value)} maxLength={2048} placeholder="https://example.org" required /></label>
            <label className="field"><span>Task mode</span>
              <select className="input" value="monitor" onChange={() => undefined}>
                <option value="monitor">Website Monitor — HTTP(S) checks</option>
                <option value="persistent" disabled>Persistent Web Task — unavailable on this host</option>
              </select>
            </label>
            <button className="button button-primary" type="submit" disabled={creating || !runtime?.enabled}>{creating ? 'Creating…' : 'Create monitor'}</button>
          </form>
          {!runtime?.enabled && <p className="inline-error">An administrator has paused all monitors.</p>}
        </section>
      </div>
      {selected && (
        <div className="modal-backdrop" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) setSelected(null); }}>
          <section className="modal panel" aria-labelledby="monitor-log-title">
            <div className="section-heading"><div><h2 id="monitor-log-title">Check history · {selected.name}</h2><p className="muted">Most recent 100 checks</p></div><button className="text-button" onClick={() => setSelected(null)}>Close</button></div>
            {logError ? <p className="inline-error" role="alert">{logError}</p> : checks.length === 0 ? <p className="empty-state">No completed checks yet.</p> : (
              <div className="table-scroll"><table><thead><tr><th>Checked</th><th>Status</th><th>Latency</th><th>Result</th></tr></thead>
                <tbody>{checks.map((check, index) => <tr key={`${check.checkedAt}:${index}`}>
                  <td>{new Date(check.checkedAt.replace(' ', 'T') + (check.checkedAt.includes('Z') ? '' : 'Z')).toLocaleString()}</td>
                  <td className="num">{check.httpStatus ?? '—'}</td>
                  <td className="num">{check.latencyMs === null ? '—' : `${check.latencyMs} ms`}</td>
                  <td><span className={`pill ${check.outcome === 'ok' ? 'pill-positive' : 'pill-negative'}`}>{check.outcome === 'ok' ? 'Available' : check.message || 'Error'}</span></td>
                </tr>)}</tbody>
              </table></div>
            )}
          </section>
        </div>
      )}
    </section>
  );
}
