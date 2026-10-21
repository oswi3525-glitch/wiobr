import { FormEvent, useEffect, useState } from 'react';
import { api } from '../lib/api';

type Session = { createdAt: string; lastSeenAt: string; expiresAt: string; userAgent: string | null; current: boolean; revoked: boolean };

export function SettingsPanel({ theme, setTheme }: { theme: 'light' | 'dark'; setTheme: (theme: 'light' | 'dark') => void }) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [cleanTracking, setCleanTracking] = useState(true);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [egressIp, setEgressIp] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = async () => {
    setError('');
    try {
      const [sessionResult, privacyResult] = await Promise.all([
        api<{ sessions: Session[] }>('/api/auth/sessions'),
        api<{ cleanTracking: boolean }>('/api/privacy/settings'),
      ]);
      setSessions(sessionResult.sessions);
      setCleanTracking(privacyResult.cleanTracking);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Settings could not be loaded.');
    }
  };

  useEffect(() => { void load(); }, []);

  const updatePrivacy = async (value: boolean) => {
    setCleanTracking(value);
    try {
      await api('/api/privacy/settings', { method: 'PUT', body: JSON.stringify({ cleanTracking: value }) });
      setNotice('Privacy setting saved.');
    } catch (saveError) {
      setCleanTracking(!value);
      setError(saveError instanceof Error ? saveError.message : 'Privacy setting could not be saved.');
    }
  };

  const changePassword = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    setNotice('');
    try {
      const result = await api<{ message: string }>('/api/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      setCurrentPassword('');
      setNewPassword('');
      setNotice(result.message);
      await load();
    } catch (changeError) {
      setError(changeError instanceof Error ? changeError.message : 'Password could not be changed.');
    }
  };

  const revokeOtherSessions = async () => {
    if (!window.confirm('Revoke every other session for this account? This session will remain signed in.')) return;
    try {
      await api('/api/auth/sessions/revoke-others', { method: 'POST', body: JSON.stringify({}) });
      setNotice('Other sessions revoked.');
      await load();
    } catch (revokeError) {
      setError(revokeError instanceof Error ? revokeError.message : 'Other sessions could not be revoked.');
    }
  };

  const checkCloudIp = async () => {
    setEgressIp('');
    setError('');
    try {
      const result = await api<{ egressIp: string; checkedAt: string }>('/api/privacy/cloud-ip');
      setEgressIp(`${result.egressIp} · checked ${new Date(result.checkedAt).toLocaleTimeString()}`);
    } catch (ipError) {
      setError(ipError instanceof Error ? ipError.message : 'The server egress IP could not be checked.');
    }
  };

  return (
    <section className="module-view">
      <header className="page-heading"><div><h1>Settings</h1><p>Control this WioBrowse account and local application preferences.</p></div></header>
      {error && <div className="error-block" role="alert"><p>{error}</p></div>}
      {notice && <p className="inline-success" role="status">{notice}</p>}
      <div className="settings-list">
        <section className="settings-section">
          <div className="settings-description"><h2>Appearance</h2><p>Theme is stored on this device and does not change other sessions.</p></div>
          <div className="panel settings-content">
            <label className="field"><span>Theme</span>
              <select className="input" value={theme} onChange={(event) => setTheme(event.target.value as 'light' | 'dark')}>
                <option value="light">Light</option><option value="dark">Dark</option>
              </select>
            </label>
          </div>
        </section>
        <section className="settings-section">
          <div className="settings-description"><h2>Privacy Shield</h2><p>WioBrowse cleans common tracking parameters from URLs opened from this app. It does not block requests made directly by external websites.</p></div>
          <div className="panel settings-content">
            <label className="toggle-row">
              <span><strong>Clean tracking parameters</strong><small>Removes common UTM and click-tracking query parameters when you open an HTTP(S) URL.</small></span>
              <input type="checkbox" checked={cleanTracking} onChange={(event) => void updatePrivacy(event.target.checked)} />
            </label>
            <div className="setting-action">
              <div><strong>Cloud IP check</strong><p className="muted">Checks this server’s actual public egress address using a fixed IP-check provider.</p>{egressIp && <p role="status">{egressIp}</p>}</div>
              <button className="button" onClick={() => void checkCloudIp()}>Check server IP</button>
            </div>
            <p className="muted">The Panic Button is not available: it cannot clear Safari’s history, cookies or website sessions.</p>
          </div>
        </section>
        <section className="settings-section">
          <div className="settings-description"><h2>Change password</h2><p>Other active sessions are revoked after a successful change.</p></div>
          <form className="panel settings-content stacked-form" onSubmit={changePassword}>
            <label className="field"><span>Current password</span><input className="input" type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} autoComplete="current-password" required /></label>
            <label className="field"><span>New password</span><input className="input" type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} minLength={12} maxLength={256} autoComplete="new-password" required /><small className="muted">Use at least 12 characters.</small></label>
            <button className="button button-primary" type="submit">Change password</button>
          </form>
        </section>
        <section className="settings-section">
          <div className="settings-description"><h2>Sessions</h2><p>Only session metadata for your own account is shown here.</p></div>
          <div className="panel settings-content">
            {sessions.length === 0 ? <p className="empty-state">No active sessions.</p> : sessions.map((session, index) => (
              <article className="session-row" key={`${session.createdAt}:${index}`}>
                <div><strong>{session.current ? 'This session' : 'Other session'}</strong><p className="muted">{session.userAgent || 'Unknown device'}</p><p className="muted">Started {new Date(session.createdAt).toLocaleString()} · last seen {new Date(session.lastSeenAt).toLocaleString()}</p></div>
                {!session.revoked && session.current && <span className="pill pill-positive">Current</span>}
              </article>
            ))}
            {sessions.some((session) => !session.current && !session.revoked) && <button className="button button-danger" onClick={() => void revokeOtherSessions()}>Sign out other sessions</button>}
          </div>
        </section>
        <section className="settings-section destructive-section">
          <div className="settings-description"><h2>Account recovery</h2><p>Self-service email recovery is not configured. Contact an administrator to reset your account password.</p></div>
          <div className="panel settings-content"><p>Password reset does not send email or issue recovery tokens because no mail service is configured.</p></div>
        </section>
      </div>
    </section>
  );
}
