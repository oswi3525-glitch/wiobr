import { FormEvent, useEffect, useRef, useState } from 'react';
import { api, apiUrl } from '../lib/api';

type Message = { id: number; userId: number; username: string; content: string; createdAt: string };
type ChatHistory = { messages: Message[]; nextCursor: number | null };

export function ChatPanel({ compact = false }: { compact?: boolean }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [state, setState] = useState<'connecting' | 'connected' | 'reconnecting' | 'offline'>('connecting');
  const [error, setError] = useState('');
  const [historyCursor, setHistoryCursor] = useState<number | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const socket = useRef<WebSocket | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const messageTimes = useRef<number[]>([]);

  useEffect(() => {
    let disposed = false;
    let retryTimer = 0;
    let heartbeatTimer = 0;
    let attempt = 0;

    api<ChatHistory>('/api/chat')
      .then((data) => { if (!disposed) { setMessages(data.messages); setHistoryCursor(data.nextCursor); } })
      .catch(() => { if (!disposed) setError('Could not load earlier messages.'); });

    const connect = () => {
      if (disposed) return;
      setState(attempt ? 'reconnecting' : 'connecting');
      const apiOrigin = new URL(apiUrl('/'), window.location.href);
      const protocol = apiOrigin.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${protocol}//${apiOrigin.host}/ws`);
      socket.current = ws;
      ws.onopen = () => {
        attempt = 0;
        setState('connected');
        ws.send(JSON.stringify({ type: 'heartbeat', idle: document.visibilityState === 'hidden' }));
        heartbeatTimer = window.setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'heartbeat', idle: document.visibilityState === 'hidden' }));
          }
        }, 30_000);
      };
      ws.onmessage = (event) => {
        let payload: { type?: string; message?: Message; error?: string };
        try { payload = JSON.parse(String(event.data)) as typeof payload; }
        catch { return; }
        if (payload.type === 'chat' && payload.message) {
          setMessages((current) => current.some((message) => message.id === payload.message?.id)
            ? current
            : [...current, payload.message!].slice(-200));
          setError('');
        } else if (payload.type === 'error' && payload.error) {
          setError(payload.error);
        }
      };
      ws.onclose = () => {
        window.clearInterval(heartbeatTimer);
        socket.current = null;
        if (disposed) return;
        attempt += 1;
        setState('reconnecting');
        retryTimer = window.setTimeout(connect, Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5)));
      };
      ws.onerror = () => setState('offline');
    };

    connect();
    return () => {
      disposed = true;
      window.clearTimeout(retryTimer);
      window.clearInterval(heartbeatTimer);
      socket.current?.close();
      socket.current = null;
    };
  }, []);

  useEffect(() => {
    end.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const content = draft.trim();
    const ws = socket.current;
    if (!content || content.length > 2000 || ws?.readyState !== WebSocket.OPEN) {
      if (ws?.readyState !== WebSocket.OPEN) setError('Chat is reconnecting. Your draft is still here.');
      return;
    }
    const now = Date.now();
    messageTimes.current = messageTimes.current.filter((time) => now - time < 60_000);
    if (messageTimes.current.length >= 10) {
      setError('Message limit reached. Try again in a moment.');
      return;
    }
    messageTimes.current.push(now);
    ws.send(JSON.stringify({ type: 'chat', content }));
    setDraft('');
    setError('');
  };

  const loadOlder = async () => {
    if (!historyCursor || loadingHistory) return;
    setLoadingHistory(true);
    try {
      const result = await api<ChatHistory>(`/api/chat?before=${historyCursor}`);
      setMessages((current) => [...result.messages.filter((item) => !current.some((message) => message.id === item.id)), ...current]);
      setHistoryCursor(result.nextCursor);
      setError('');
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Earlier messages could not be loaded.');
    } finally {
      setLoadingHistory(false);
    }
  };

  return (
    <section className={`chat-panel${compact ? ' chat-panel-compact' : ''}`} aria-label="Group chat">
      <header className="section-heading">
        <div>
          <h2>Group chat</h2>
          <p className="muted">Shared with active members</p>
        </div>
        <span className={`connection-state state-${state}`} role="status">
          <span aria-hidden="true" />
          {state === 'connected' ? 'Connected' : state === 'connecting' ? 'Connecting' : state === 'offline' ? 'Offline' : 'Reconnecting'}
        </span>
      </header>
      {error && <p className="inline-error" role="status">{error}</p>}
      {historyCursor && <button className="text-button chat-history-button" onClick={() => void loadOlder()} disabled={loadingHistory}>{loadingHistory ? 'Loading earlier messages…' : 'Load earlier messages'}</button>}
      <div className="chat-messages" aria-live="polite" aria-relevant="additions text">
        {messages.length === 0
          ? <p className="empty-state">No messages yet. Start the conversation.</p>
          : messages.map((message) => (
            <article className="chat-message" key={message.id}>
              <div className="chat-message-meta">
                <strong>{message.username}</strong>
                <time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time>
              </div>
              <p>{message.content}</p>
            </article>
          ))}
        <div ref={end} />
      </div>
      <form className="chat-compose" onSubmit={submit}>
        <label className="sr-only" htmlFor={compact ? 'chat-message-compact' : 'chat-message'}>Message</label>
        <textarea
          id={compact ? 'chat-message-compact' : 'chat-message'}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          maxLength={2000}
          rows={2}
          placeholder="Write a message"
          aria-describedby="chat-limit"
        />
        <div className="chat-compose-footer">
          <span id="chat-limit" className="muted">{draft.length}/2,000</span>
          <button className="button button-primary" type="submit" disabled={state !== 'connected' || !draft.trim()}>
            Send
          </button>
        </div>
      </form>
    </section>
  );
}
