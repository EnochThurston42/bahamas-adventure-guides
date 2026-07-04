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

      // POST /notify — called by worker to push a message to all connected sessions
      if (request.method === 'POST' && path.includes('/notify')) {
        return this.handleNotify(request);
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
    const url = new URL(request.url);
    const name = request.headers.get('X-Chat-Name') || url.searchParams.get('name') || 'Guest';
    // Role: check header first, then query param, default visitor
    const roleFromHeader = request.headers.get('X-Chat-Role') || url.searchParams.get('role') || 'visitor';

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    server.accept();
    const sessionId = ++this.sessionCounter;

    const session = { ws: server, name, role: roleFromHeader };
    this.sessions.set(sessionId, session);

    // Send connected info
    server.send(JSON.stringify({ type: 'connected', session_id: sessionId, name, role: roleFromHeader }));

    // Broadcast presence to everyone
    this.broadcastPresence();

    // Handle incoming
    server.addEventListener('message', async (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'message') {
          const clean = (data.content || '').trim().slice(0, 5000);
          if (!clean) return;

          const msg = {
            sender_role: roleFromHeader,
            sender_name: name,
            content: clean,
            created_at: new Date().toISOString(),
          };

          // Broadcast to all other sessions
          this.broadcast({ type: 'message', ...msg }, sessionId);
          // Echo back
          server.send(JSON.stringify({ type: 'message_ack', ...msg }));
        } else if (data.type === 'set_name') {
          session.name = data.name;
          this.broadcastPresence();
        } else if (data.type === 'typing') {
          this.broadcast({ type: 'typing', session_id: sessionId, name, is_typing: data.is_typing }, sessionId);
        }
      } catch {}
    });

    server.addEventListener('close', () => {
      this.sessions.delete(sessionId);
      this.broadcastPresence();
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  broadcastPresence() {
    const agents = [];
    const visitors = [];
    for (const [, s] of this.sessions) {
      if (s.role === 'agent') agents.push({ name: s.name });
      else visitors.push({ name: s.name });
    }
    this.broadcast({
      type: 'presence',
      agents_online: agents.length,
      visitors_online: visitors.length,
      agents,
    });
  }

  broadcast(data, excludeSessionId = null) {
    const payload = JSON.stringify(data);
    for (const [sid, session] of this.sessions) {
      if (sid !== excludeSessionId) {
        try { session.ws.send(payload); } catch {}
      }
    }
  }

  async handleNotify(request) {
    try {
      const body = await request.json();
      const payload = JSON.stringify({ type: 'message', ...body });

      let count = 0;
      for (const [, session] of this.sessions) {
        try {
          session.ws.send(payload);
          count++;
        } catch {}
      }

      return new Response(JSON.stringify({ ok: true, broadcast_to: count }), {
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500, headers: { 'Content-Type': 'application/json' },
      });
    }
  }
}
