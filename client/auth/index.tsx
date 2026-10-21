import React, { createContext, useContext, useEffect, useState } from 'react';
import { api } from '../lib/api';

type User = { id: number; username: string; role: 'admin' | 'member' } | null;

const Ctx = createContext<{ user: User; loading: boolean; error: string; refresh: () => Promise<void>; logout: () => Promise<void> }>({
  user: null, loading: true, error: '', refresh: async () => {}, logout: async () => {},
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const refresh = async () => {
    try {
      const r = await api<{ user: User }>('/api/auth/me');
      setUser(r.user);
      setError('');
    } catch (refreshError) {
      const message = refreshError instanceof Error ? refreshError.message : 'Authentication service is unavailable.';
      if (message === 'unauthorized') {
        setUser(null);
        setError('');
      } else {
        setError('Could not connect to WioBrowse. Check your connection and retry.');
      }
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { refresh(); }, []);
  const logout = async () => {
    await api('/api/auth/logout', { method: 'POST' });
    setUser(null);
  };
  return <Ctx.Provider value={{ user, loading, error, refresh, logout }}>{children}</Ctx.Provider>;
}

export function useAuth() { return useContext(Ctx); }
