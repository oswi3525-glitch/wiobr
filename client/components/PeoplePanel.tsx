import { useEffect, useState } from 'react';
import { api } from '../lib/api';

type Member = { id: number; username: string; status: 'online' | 'idle' | 'offline'; lastActive: string | null; activeSessions: number };

function relativeTime(value: string | null) {
  if (!value) return 'No recent activity';
  const date = new Date(`${value.replace(' ', 'T')}${value.includes('Z') ? '' : 'Z'}`);
  const minutes = Math.max(0, Math.floor((Date.now() - date.getTime()) / 60_000));
  if (minutes < 1) return 'Active just now';
  if (minutes < 60) return `Active ${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Active ${hours} hr ago`;
  return `Active ${Math.floor(hours / 24)} days ago`;
}

export function PeoplePanel() {
  const [members, setMembers] = useState<Member[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setError('');
    try {
      const result = await api<{ members: Member[] }>('/api/members');
      setMembers(result.members);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Member presence could not be loaded.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => { void load(); }, 45_000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <section className="module-view">
      <header className="page-heading">
        <div><h1>Members online</h1><p>Presence is based on authenticated app heartbeats; no IP addresses are shared.</p></div>
        <button className="button" onClick={() => void load()}>Refresh</button>
      </header>
      <section className="panel">
        <div className="section-heading"><div><h2>Team presence</h2><p className="muted">{members.filter((member) => member.status !== 'offline').length} online or idle</p></div></div>
        {loading ? <p role="status">Loading member presence…</p> : error ? <div className="error-block"><p role="alert">{error}</p><button className="text-button" onClick={() => void load()}>Retry</button></div> : members.length === 0
          ? <p className="empty-state">No active member accounts are available.</p>
          : <div className="member-list">{members.map((member) => (
            <article className="member-row" key={member.id}>
              <div className="member-monogram" aria-hidden="true">{member.username.slice(0, 1).toUpperCase()}</div>
              <div className="member-details">
                <strong>{member.username}</strong>
                <span className="muted">{relativeTime(member.lastActive)}</span>
              </div>
              <span className={`presence-state presence-${member.status}`}><span aria-hidden="true" />{member.status[0].toUpperCase() + member.status.slice(1)}</span>
              <span className="muted session-count">{member.activeSessions} session{member.activeSessions === 1 ? '' : 's'}</span>
            </article>
          ))}</div>}
      </section>
    </section>
  );
}
