// ChatRoom — one Durable Object per conversation.
// Handles WebSocket connections in-memory. No persistence — the worker handles KV.

export class ChatRoom {
  constructor(ctx) {
    this.ctx = ctx;
    this.sessions = new Map();
    this.sessionCounter = 0;
  }

  async fetch(request) {
    try {
      const url = new URL(request.url);
      const path = url.pathname;

      if (path.includes('/ws')) {
        return this.handleWebSocket(request);
      }

      // Health check
      return new Response(JSON.stringify({ ok: true, sessions: this.sessions.size }), {
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500, headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  handleWebSocket(request) {
    const name = request.headers.get('X-Chat-Name') || 'Guest';

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    server.accept();
    const sessionId = ++this.sessionCounter;
    this.sessions.set(sessionId, { ws: server, name });

    // Connected
    server.send(JSON.stringify({
      type: 'connected',
      session_id: sessionId,
      name,
    }));

    // Welcome
    server.send(JSON.stringify({
      type: 'message',
      sender_role: 'system',
      sender_name: 'System',
      content: 'You are now connected. Messages will be saved automatically.',
      created_at: new Date().toISOString(),
    }));

    // Handle incoming
    server.addEventListener('message', async (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'message') {
          const clean = (data.content || '').trim().slice(0, 5000);
          if (!clean) return;

          const msg = {
            sender_role: 'visitor',
            sender_name: name,
            content: clean,
            created_at: new Date().toISOString(),
          };

          // Broadcast to all other sessions
          for (const [, session] of this.sessions) {
            if (session.ws !== server) {
              try { session.ws.send(JSON.stringify({ type: 'message', ...msg })); } catch {}
            }
          }
          // Echo back
          server.send(JSON.stringify({ type: 'message_ack', ...msg }));
        } else if (data.type === 'set_name') {
          const session = this.sessions.get(sessionId);
          if (session) session.name = data.name;
        }
      } catch {}
    });

    server.addEventListener('close', () => {
      const session = this.sessions.get(sessionId);
      const sessionName = session?.name || 'Someone';
      this.sessions.delete(sessionId);
      for (const [, s] of this.sessions) {
        try {
          s.ws.send(JSON.stringify({ type: 'status', message: `${sessionName} left` }));
        } catch {}
      }
    });

    return new Response(null, { status: 101, webSocket: client });
  }
}
