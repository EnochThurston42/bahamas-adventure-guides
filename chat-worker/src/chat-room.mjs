// ChatRoom — one Durable Object per conversation.
// Owns a SQLite store via `this.ctx.storage.sql`.
// Accepts WebSocket connections from visitor + agents and broadcasts messages.

export class ChatRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    // Connected WebSocket sessions: Map<sessionId, { ws, role, name }>
    this.sessions = new Map();
    this.sessionCounter = 0;
  }

  // Initialize SQL schema on first use
  async ensureSchema() {
    if (this._schemaDone) return;
    await this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT,
        sender_role TEXT NOT NULL CHECK(sender_role IN ('visitor','agent','system')),
        sender_name TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this._schemaDone = true;
  }

  async fetch(request) {
    await this.ensureSchema();

    const url = new URL(request.url);
    const path = url.pathname;

    // WebSocket upgrade — the main entry point for chat
    if (path.endsWith('/ws')) {
      return this.handleWebSocket(request);
    }

    // REST endpoints for history and polling fallback
    if (request.method === 'GET' && path.endsWith('/messages')) {
      return this.handleGetMessages(request);
    }

    return new Response('Not found', { status: 404 });
  }

  // ─── WebSocket handling ─────────────────────────────────────

  async handleWebSocket(request) {
    const role = request.headers.get('X-Chat-Role') || 'visitor';
    const name = request.headers.get('X-Chat-Name') || 'Guest';

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    server.accept();
    const sessionId = ++this.sessionCounter;
    this.sessions.set(sessionId, { ws: server, role, name });

    // Send welcome message with session info
    server.send(JSON.stringify({
      type: 'connected',
      session_id: sessionId,
      role,
      name,
    }));

    // Broadcast join event to agents
    this.broadcast({
      type: 'status',
      message: `${name} joined the conversation`,
      session_count: this.sessions.size,
    }, [sessionId]);

    // Load and send recent message history
    const history = await this.ctx.storage.sql.exec(
      'SELECT id, sender_role, sender_name, content, created_at FROM messages ORDER BY id ASC LIMIT 100'
    );
    if (history && history.length > 0) {
      server.send(JSON.stringify({
        type: 'history',
        messages: history.map(r => ({
          id: r.id,
          sender_role: r.sender_role,
          sender_name: r.sender_name,
          content: r.content,
          created_at: r.created_at,
        })),
      }));
    }

    // Handle incoming messages from this connection
    server.addEventListener('message', async (event) => {
      try {
        const data = JSON.parse(event.data);

        if (data.type === 'message') {
          await this.handleIncomingMessage(sessionId, role, name, data.content);
        } else if (data.type === 'typing') {
          this.broadcast({
            type: 'typing',
            session_id: sessionId,
            name,
            is_typing: data.is_typing,
          }, [sessionId]);
        } else if (data.type === 'set_name') {
          const session = this.sessions.get(sessionId);
          if (session) {
            session.name = data.name;
          }
        }
      } catch (err) {
        server.send(JSON.stringify({ type: 'error', message: 'Invalid message' }));
      }
    });

    // Handle disconnect
    server.addEventListener('close', async () => {
      const session = this.sessions.get(sessionId);
      const sessionName = session?.name || 'Someone';
      this.sessions.delete(sessionId);
      this.broadcast({
        type: 'status',
        message: `${sessionName} left the conversation`,
        session_count: this.sessions.size,
      });
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  // ─── Message handling ───────────────────────────────────────

  async handleIncomingMessage(sessionId, role, name, content) {
    // Sanitize
    const clean = content.trim().slice(0, 5000);
    if (!clean) return;

    // Persist
    const result = await this.ctx.storage.sql.exec(
      'INSERT INTO messages (session_id, sender_role, sender_name, content) VALUES (?, ?, ?, ?)',
      String(sessionId), role, name, clean
    );

    const msgId = result?.lastRowId || 0;

    const msg = {
      type: 'message',
      id: msgId,
      session_id: sessionId,
      sender_role: role,
      sender_name: name,
      content: clean,
      created_at: new Date().toISOString(),
    };

    // Broadcast to all other sessions
    this.broadcast(msg, [sessionId]);

    // Also echo back to sender for confirmation
    const sender = this.sessions.get(sessionId);
    if (sender) {
      sender.ws.send(JSON.stringify({ ...msg, type: 'message_ack' }));
    }

    // Update registry (conversation list)
    await this.updateRegistry(clean);
  }

  async updateRegistry(lastMessage) {
    try {
      const roomId = this.ctx.id.name;
      const registryId = this.env.CHAT_REGISTRY.idFromName('global');
      const stub = this.env.CHAT_REGISTRY.get(registryId);
      await stub.fetch('http://dummy/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          room_id: roomId,
          last_message_preview: lastMessage.slice(0, 120),
          unread_visitor: this.detectUnread(),
        }),
      });
    } catch (err) {
      // Registry update is non-critical
      console.error('Registry update failed:', err);
    }
  }

  detectUnread() {
    let visitorHasUnread = false;
    let agentHasUnread = false;
    for (const [, session] of this.sessions) {
      if (session.role === 'visitor') visitorHasUnread = true;
      if (session.role === 'agent') agentHasUnread = true;
    }
    // If no agents are connected, there are unread messages for agents
    return { agent: !agentHasUnread, visitor: !visitorHasUnread };
  }

  // ─── REST fallback ──────────────────────────────────────────

  async handleGetMessages(request) {
    const url = new URL(request.url);
    const after = parseInt(url.searchParams.get('after') || '0', 10);

    const rows = await this.ctx.storage.sql.exec(
      'SELECT id, sender_role, sender_name, content, created_at FROM messages WHERE id > ? ORDER BY id ASC LIMIT 100',
      after
    );

    return new Response(JSON.stringify({
      messages: (rows || []).map(r => ({
        id: r.id,
        sender_role: r.sender_role,
        sender_name: r.sender_name,
        content: r.content,
        created_at: r.created_at,
      })),
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // ─── Utility ────────────────────────────────────────────────

  broadcast(data, excludeSessionIds = []) {
    const msg = JSON.stringify(data);
    for (const [sid, session] of this.sessions) {
      if (!excludeSessionIds.includes(sid)) {
        try {
          session.ws.send(msg);
        } catch {
          this.sessions.delete(sid);
        }
      }
    }
  }
}
