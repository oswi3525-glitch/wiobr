import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth';
import { LoginPage } from './pages/Login';
import { Dashboard } from './pages/Dashboard';

function Protected({ children }: { children: React.ReactNode }) {
  const { user, loading, error, refresh } = useAuth();
  if (loading) return <main className="auth-state"><p role="status">Loading your WioBrowse account…</p></main>;
  if (error) return <main className="auth-state"><section className="auth-card"><h1>WioBrowse is unavailable</h1><p role="alert">{error}</p><button className="button button-primary" onClick={() => { void refresh(); }}>Try again</button></section></main>;
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/" element={<Protected><Dashboard /></Protected>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
