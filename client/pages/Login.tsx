import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../auth';

export function LoginPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const { refresh } = useAuth();
  const navigate = useNavigate();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(''); setLoading(true);
    try {
      await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) });
      await refresh();
      navigate('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 px-4">
      <form onSubmit={submit} className="w-full max-w-sm bg-white rounded-xl shadow p-6 space-y-4">
        <h1 className="text-xl font-semibold text-slate-800">WioBrowse Cloud</h1>
        <p className="text-sm text-slate-500">Sign in to continue</p>
        {error && <div className="text-sm text-red-600 bg-red-50 rounded p-2">{error}</div>}
        <input className="w-full border rounded px-3 py-2" placeholder="Username" value={username} onChange={e=>setUsername(e.target.value)} autoFocus />
        <input className="w-full border rounded px-3 py-2" type="password" placeholder="Password" value={password} onChange={e=>setPassword(e.target.value)} />
        <button disabled={loading} className="w-full bg-blue-600 text-white rounded py-2 disabled:opacity-50">{loading ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </div>
  );
}
