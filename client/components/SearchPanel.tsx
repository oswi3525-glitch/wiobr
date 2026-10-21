import { FormEvent, useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { SearchHandler } from './WorkspaceBrowser';

export type SearchResult = { title: string; url: string; snippet: string; domain: string; favicon?: string };
export type SearchState = { query: string; results: SearchResult[]; tookMs: number | null; cacheHit: boolean };
type SearchHistoryRow = { id: number; query: string; privateSession: boolean; createdAt: string };

export function SearchPanel({
  state,
  loading,
  error,
  onSearch,
}: {
  state: SearchState | null;
  loading: boolean;
  error: string;
  onSearch: SearchHandler;
}) {
  const [query, setQuery] = useState(state?.query || '');
  const [privateSession, setPrivateSession] = useState(false);
  const [history, setHistory] = useState<SearchHistoryRow[]>([]);
  const [historyVisible, setHistoryVisible] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const [historyCursor, setHistoryCursor] = useState<number | null>(null);

  useEffect(() => { if (state?.query) setQuery(state.query); }, [state?.query]);

  const loadHistory = async (before?: number) => {
    setHistoryError('');
    try {
      const params = new URLSearchParams({ limit: '50' });
      if (before) params.set('before', String(before));
      const result = await api<{ history: SearchHistoryRow[] }>(`/api/search/history?${params}`);
      setHistory((current) => before ? [...current, ...result.history] : result.history);
      setHistoryCursor(result.history.length === 50 ? result.history[result.history.length - 1].id : null);
    } catch (loadError) {
      setHistoryError(loadError instanceof Error ? loadError.message : 'Search history could not be loaded.');
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (query.trim()) void onSearch(query.trim(), privateSession);
  };

  const clearHistory = async () => {
    if (!window.confirm('Delete all of your search history up to now? This only affects WioBrowse search records.')) return;
    try {
      const result = await api<{ deleted: number }>('/api/search/history', {
        method: 'DELETE',
        body: JSON.stringify({ before: new Date().toISOString(), confirm: true }),
      });
      setHistory([]);
      setHistoryError(`${result.deleted} search records deleted.`);
    } catch (deleteError) {
      setHistoryError(deleteError instanceof Error ? deleteError.message : 'Search history could not be deleted.');
    }
  };

  return (
    <section className="module-view">
      <header className="page-heading">
        <div><h1>Cloud Search</h1><p>Queries are sent by WioBrowse to DuckDuckGo’s HTML search endpoint.</p></div>
      </header>
      <div className="notice notice-warning">
        <strong>Privacy note:</strong> search requests originate from this server. Private Session does not prevent server-side history retention under system policy, and it does not hide visits from external websites.
      </div>
      <form className="cloud-search-form" onSubmit={submit}>
        <label className="sr-only" htmlFor="cloud-search-query">Search the web</label>
        <input id="cloud-search-query" className="input" value={query} onChange={(event) => setQuery(event.target.value)} maxLength={200} placeholder="Search the web" />
        <button className="button button-primary" type="submit" disabled={loading || !query.trim()}>{loading ? 'Searching…' : 'Search'}</button>
      </form>
      <label className="private-toggle search-private-toggle">
        <input type="checkbox" checked={privateSession} onChange={(event) => setPrivateSession(event.target.checked)} />
        <span>Private Session</span>
      </label>
      {error && <div className="error-block" role="alert"><p>{error}</p><button className="text-button" onClick={() => void onSearch(query, privateSession)}>Retry</button></div>}
      {state && (
        <section className="search-results" aria-live="polite">
          <div className="section-heading">
            <div><h2>Results for “{state.query}”</h2><p className="muted">{state.results.length} results · {state.tookMs ?? '—'} ms{state.cacheHit ? ' · cached for 60 seconds' : ''}</p></div>
          </div>
          {state.results.length === 0 ? <p className="empty-state">The provider returned no results for this query.</p> : state.results.map((result) => (
            <article className="search-result" key={result.url}>
              <p className="search-result-domain">{result.domain}</p>
              <h3><a href={result.url} target="_blank" rel="noopener noreferrer">{result.title}</a></h3>
              <p>{result.snippet || 'No description provided by the search provider.'}</p>
              <a className="result-url" href={result.url} target="_blank" rel="noopener noreferrer">{result.url}</a>
            </article>
          ))}
        </section>
      )}
      <section className="panel search-history-panel">
        <div className="section-heading">
          <div><h2>Your search history</h2><p className="muted">Stored server-side for up to 90 days, including searches marked Private Session.</p></div>
          <div className="button-row">
            <button className="button" onClick={() => { setHistoryVisible((visible) => !visible); if (!historyVisible) void loadHistory(); }}>{historyVisible ? 'Hide history' : 'View history'}</button>
            <button className="text-button destructive-link" onClick={() => void clearHistory()}>Clear</button>
          </div>
        </div>
        {historyVisible && (
          <div>
            {historyError && <p className="inline-error" role="status">{historyError}</p>}
            {history.length === 0 ? <p className="empty-state">No stored searches found.</p> : (
              <div className="history-list">{history.map((item) => (
                <article className="history-row" key={item.id}>
                  <button className="item-title" onClick={() => { setQuery(item.query); void onSearch(item.query, item.privateSession); }}>{item.query}</button>
                  <span className="muted">{item.privateSession ? 'Private Session · server stored' : 'Standard session'}</span>
                  <time className="muted" dateTime={item.createdAt}>{new Date(`${item.createdAt.replace(' ', 'T')}Z`).toLocaleString()}</time>
                </article>
              ))}</div>
            )}
            {historyCursor && <button className="button" onClick={() => void loadHistory(historyCursor)}>Load older searches</button>}
          </div>
        )}
      </section>
    </section>
  );
}
