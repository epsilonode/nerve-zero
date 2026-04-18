import { useRef, useCallback, useState, useEffect } from 'react';
import type { GatewayEvent, ChatMessage } from '@/types';

type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

interface UseWebSocketReturn {
  connectionState: ConnectionState;
  connect: (url: string, token: string) => Promise<void>;
  disconnect: () => void;
  rpc: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  onEvent: React.MutableRefObject<((msg: GatewayEvent) => void) | null>;
  connectError: string;
  reconnectAttempt: number;
}

const RECONNECT_BASE_DELAY = 1000;
const RECONNECT_MAX_DELAY = 30000;
const CONNECT_TIMEOUT_MS = 5000;
const INSTANCE_ID_STORAGE_KEY = 'oc-webchat-instance-id';
const SESSION_ID_STORAGE_KEY = 'nerve-zero-session-id';
const DEFAULT_SESSION_KEY = 'agent:main:main';

function generateStableId(prefix: string): string {
  return crypto.randomUUID ? `${prefix}-${crypto.randomUUID()}` : `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function getOrCreateSessionValue(storageKey: string, prefix: string): string {
  const fallback = generateStableId(prefix);
  if (typeof window === 'undefined') return fallback;

  try {
    const existing = window.sessionStorage.getItem(storageKey);
    if (existing) return existing;
    window.sessionStorage.setItem(storageKey, fallback);
    return fallback;
  } catch {
    return fallback;
  }
}

function getOrCreateInstanceId(): string {
  return getOrCreateSessionValue(INSTANCE_ID_STORAGE_KEY, 'inst');
}

function getOrCreateGatewaySessionId(): string {
  return getOrCreateSessionValue(SESSION_ID_STORAGE_KEY, 'session');
}

function makeAssistantMessage(content: string): ChatMessage {
  return {
    role: 'assistant',
    content,
    timestamp: Date.now(),
  };
}

function makeUserMessage(content: string): ChatMessage {
  return {
    role: 'user',
    content,
    timestamp: Date.now(),
  };
}

/**
 * ZeroClaw `/ws/chat` client with a compatibility shim for Nerve's existing UI.
 *
 * The gateway authenticates at upgrade time and streams `session_start`,
 * `chunk`, `tool_call`, `tool_result`, `done`, and `error` frames over `/ws/chat`.
 */
export function useWebSocket(): UseWebSocketReturn {
  const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected');
  const [connectError, setConnectError] = useState('');
  const [reconnectAttempt, setReconnectAttempt] = useState(0);

  const wsRef = useRef<WebSocket | null>(null);
  const connectResolveRef = useRef<(() => void) | null>(null);
  const connectRejectRef = useRef<((e: Error) => void) | null>(null);
  const onEvent = useRef<((msg: GatewayEvent) => void) | null>(null);

  const credentialsRef = useRef<{ url: string; token: string } | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptRef = useRef(0);
  const intentionalDisconnectRef = useRef(false);
  const hasConnectedRef = useRef(false);
  const doConnectRef = useRef<((url: string, token: string, isReconnect: boolean) => Promise<void>) | null>(null);
  const instanceIdRef = useRef(getOrCreateInstanceId());
  const sessionIdRef = useRef(getOrCreateGatewaySessionId());
  const connectionGenRef = useRef(0);
  const connectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const currentRunIdRef = useRef<string | null>(null);
  const nextChatSeqRef = useRef(0);
  const historyRef = useRef<ChatMessage[]>([]);
  const toolCallQueueRef = useRef<Array<{ toolCallId: string; name: string }>>([]);

  const emitEvent = useCallback((event: GatewayEvent) => {
    onEvent.current?.(event);
  }, []);

  const appendHistory = useCallback((message: ChatMessage) => {
    historyRef.current = [...historyRef.current, message];
  }, []);

  const clearReconnectTimeout = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
  }, []);

  const clearConnectTimeout = useCallback(() => {
    if (connectTimeoutRef.current) {
      clearTimeout(connectTimeoutRef.current);
      connectTimeoutRef.current = null;
    }
  }, []);

  const ensureRunStarted = useCallback((): string => {
    if (currentRunIdRef.current) return currentRunIdRef.current;

    const runId = generateStableId(`run-${instanceIdRef.current}`);
    currentRunIdRef.current = runId;
    nextChatSeqRef.current = 0;
    emitEvent({
      type: 'event',
      event: 'chat',
      payload: {
        sessionKey: DEFAULT_SESSION_KEY,
        state: 'started',
        runId,
        seq: ++nextChatSeqRef.current,
      },
    });
    return runId;
  }, [emitEvent]);

  const rpc = useCallback(async (method: string, params: Record<string, unknown> = {}): Promise<unknown> => {
    if (method === 'chat.send') {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error('Not connected');

      const content = typeof params.message === 'string' ? params.message : '';
      if (!content.trim()) throw new Error('Message content cannot be empty');

      const runId = generateStableId(`run-${instanceIdRef.current}`);
      currentRunIdRef.current = runId;
      nextChatSeqRef.current = 0;
      toolCallQueueRef.current = [];
      appendHistory(makeUserMessage(content));
      emitEvent({
        type: 'event',
        event: 'chat',
        payload: {
          sessionKey: DEFAULT_SESSION_KEY,
          state: 'started',
          runId,
          seq: ++nextChatSeqRef.current,
        },
      });
      ws.send(JSON.stringify({ type: 'message', content }));
      return { runId, status: 'started' };
    }

    if (method === 'chat.history') {
      return { messages: historyRef.current };
    }

    if (method === 'status') {
      const response = await fetch('/api/gateway/session-info');
      if (!response.ok) return {};
      return await response.json();
    }

    if (method === 'sessions.list') {
      return {
        sessions: [{
          sessionKey: DEFAULT_SESSION_KEY,
          key: DEFAULT_SESSION_KEY,
          id: sessionIdRef.current,
          label: 'Main',
          displayName: 'Main',
          updatedAt: Date.now(),
        }],
      };
    }

    if (method === 'sessions.patch') {
      const payload = {
        sessionKey: typeof params.key === 'string' ? params.key : undefined,
        model: typeof params.model === 'string' ? params.model : undefined,
        thinkingLevel: params.thinkingLevel === null || typeof params.thinkingLevel === 'string'
          ? params.thinkingLevel as string | null | undefined
          : undefined,
      };

      if (payload.model !== undefined || payload.thinkingLevel !== undefined) {
        const response = await fetch('/api/gateway/session-patch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data?.ok === false) {
          throw new Error((data as { error?: string }).error || `HTTP ${response.status}`);
        }
        return data;
      }

      return { ok: true };
    }

    if (method === 'sessions.delete' || method === 'agents.create') {
      return { ok: true };
    }

    if (method === 'sessions.reset') {
      historyRef.current = [];
      currentRunIdRef.current = null;
      nextChatSeqRef.current = 0;
      toolCallQueueRef.current = [];
      return { ok: true };
    }

    if (method === 'chat.abort') {
      return { ok: false, unsupported: true };
    }

    throw new Error(`Unsupported ZeroClaw websocket RPC shim method: ${method}`);
  }, [appendHistory, emitEvent]);

  const doConnect = useCallback((url: string, token: string, isReconnect: boolean): Promise<void> => {
    return new Promise((resolve, reject) => {
      const gen = ++connectionGenRef.current;
      if (!isReconnect) setConnectError('');

      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }

      connectResolveRef.current = resolve;
      connectRejectRef.current = reject;
      clearConnectTimeout();
      setConnectionState(isReconnect ? 'reconnecting' : 'connecting');

      let ws: WebSocket;
      try {
        const proxyProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const proxyBase = `${proxyProtocol}//${window.location.host}/ws`;
        const connectUrl = `${proxyBase}?target=${encodeURIComponent(url)}&session_id=${encodeURIComponent(sessionIdRef.current)}&token=${encodeURIComponent(token)}`;
        ws = new WebSocket(connectUrl, ['zeroclaw.v1']);
      } catch (e: unknown) {
        const errMsg = e instanceof Error ? e.message : String(e);
        setConnectError('Invalid URL: ' + errMsg);
        setConnectionState('disconnected');
        reject(e);
        return;
      }

      wsRef.current = ws;
      connectTimeoutRef.current = setTimeout(() => {
        if (gen !== connectionGenRef.current) return;
        const err = new Error('Gateway session start timed out');
        if (!isReconnect) setConnectError('Gateway session start timed out');
        setConnectionState('disconnected');
        connectRejectRef.current?.(err);
        if (wsRef.current === ws) wsRef.current = null;
        ws.close();
      }, CONNECT_TIMEOUT_MS);

      ws.onopen = () => {
        setConnectionState(isReconnect ? 'reconnecting' : 'connecting');
      };

      ws.onmessage = (ev) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(ev.data) as Record<string, unknown>;
        } catch {
          return;
        }

        const type = typeof msg.type === 'string' ? msg.type : '';

        if (type === 'session_start') {
          const sessionId = typeof msg.session_id === 'string' ? msg.session_id : '';
          if (sessionId) sessionIdRef.current = sessionId;
          clearConnectTimeout();
          reconnectAttemptRef.current = 0;
          hasConnectedRef.current = true;
          setReconnectAttempt(0);
          setConnectError('');
          setConnectionState('connected');
          connectResolveRef.current?.();
          return;
        }

        if (type === 'thinking') {
          emitEvent({
            type: 'event',
            event: 'agent',
            payload: {
              sessionKey: DEFAULT_SESSION_KEY,
              state: 'thinking',
              agentState: 'thinking',
            },
          });
          return;
        }

        if (type === 'chunk') {
          const runId = ensureRunStarted();
          const content = typeof msg.content === 'string' ? msg.content : '';
          emitEvent({
            type: 'event',
            event: 'chat',
            payload: {
              sessionKey: DEFAULT_SESSION_KEY,
              state: 'delta',
              runId,
              seq: ++nextChatSeqRef.current,
              message: makeAssistantMessage(content),
            },
          });
          return;
        }

        if (type === 'tool_call') {
          const toolCallId = generateStableId('tool');
          const name = typeof msg.name === 'string' ? msg.name : 'tool';
          toolCallQueueRef.current.push({ toolCallId, name });
          emitEvent({
            type: 'event',
            event: 'agent',
            payload: {
              sessionKey: DEFAULT_SESSION_KEY,
              stream: 'tool',
              data: {
                phase: 'start',
                name,
                args: msg.args,
                toolCallId,
              },
            },
          });
          return;
        }

        if (type === 'tool_result') {
          const name = typeof msg.name === 'string' ? msg.name : 'tool';
          const matchIndex = toolCallQueueRef.current.findIndex((entry) => entry.name === name);
          const match = matchIndex >= 0 ? toolCallQueueRef.current.splice(matchIndex, 1)[0] : undefined;
          emitEvent({
            type: 'event',
            event: 'agent',
            payload: {
              sessionKey: DEFAULT_SESSION_KEY,
              stream: 'tool',
              data: {
                phase: 'result',
                name,
                output: msg.output,
                toolCallId: match?.toolCallId || generateStableId('tool'),
              },
            },
          });
          return;
        }

        if (type === 'done') {
          const runId = currentRunIdRef.current || ensureRunStarted();
          const fullResponse = typeof msg.full_response === 'string' ? msg.full_response : '';
          appendHistory(makeAssistantMessage(fullResponse));
          emitEvent({
            type: 'event',
            event: 'chat',
            payload: {
              sessionKey: DEFAULT_SESSION_KEY,
              state: 'final',
              runId,
              seq: ++nextChatSeqRef.current,
              message: makeAssistantMessage(fullResponse),
            },
          });
          currentRunIdRef.current = null;
          toolCallQueueRef.current = [];
          return;
        }

        if (type === 'error') {
          const message = typeof msg.message === 'string' ? msg.message : 'Gateway error';
          emitEvent({
            type: 'event',
            event: 'chat',
            payload: {
              sessionKey: DEFAULT_SESSION_KEY,
              state: 'error',
              runId: currentRunIdRef.current || undefined,
              seq: ++nextChatSeqRef.current,
              error: message,
              errorMessage: message,
            },
          });
          currentRunIdRef.current = null;
          toolCallQueueRef.current = [];
        }
      };

      ws.onerror = () => {
        if (!isReconnect) setConnectError('WebSocket error — check URL or token');
      };

      ws.onclose = () => {
        clearConnectTimeout();

        if (gen !== connectionGenRef.current) return;

        if (intentionalDisconnectRef.current || !credentialsRef.current || !hasConnectedRef.current) {
          setConnectionState('disconnected');
          return;
        }

        const attempt = ++reconnectAttemptRef.current;
        setReconnectAttempt(attempt);

        const delay = Math.min(
          RECONNECT_BASE_DELAY * Math.pow(1.5, attempt - 1) + Math.random() * 500,
          RECONNECT_MAX_DELAY,
        );

        console.debug(`[WS] Reconnecting in ${Math.round(delay)}ms (attempt ${attempt})`);
        setConnectionState('reconnecting');

        reconnectTimeoutRef.current = setTimeout(() => {
          const creds = credentialsRef.current;
          if (creds && !intentionalDisconnectRef.current && doConnectRef.current) {
            doConnectRef.current(creds.url, creds.token, true).catch(() => {});
          }
        }, delay);
      };
    });
  }, [appendHistory, clearConnectTimeout, emitEvent, ensureRunStarted]);

  useEffect(() => {
    doConnectRef.current = doConnect;
  }, [doConnect]);

  useEffect(() => {
    return () => {
      clearReconnectTimeout();
      clearConnectTimeout();
      if (wsRef.current) {
        intentionalDisconnectRef.current = true;
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [clearConnectTimeout, clearReconnectTimeout]);

  const disconnect = useCallback(() => {
    intentionalDisconnectRef.current = true;
    clearReconnectTimeout();
    clearConnectTimeout();
    reconnectAttemptRef.current = 0;
    setReconnectAttempt(0);
    credentialsRef.current = null;
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    setConnectionState('disconnected');
  }, [clearConnectTimeout, clearReconnectTimeout]);

  const connect = useCallback((url: string, token: string): Promise<void> => {
    credentialsRef.current = { url, token };
    intentionalDisconnectRef.current = false;
    clearReconnectTimeout();
    reconnectAttemptRef.current = 0;
    setReconnectAttempt(0);
    return doConnect(url, token, false);
  }, [clearReconnectTimeout, doConnect]);

  return { connectionState, connect, disconnect, rpc, onEvent, connectError, reconnectAttempt };
}
