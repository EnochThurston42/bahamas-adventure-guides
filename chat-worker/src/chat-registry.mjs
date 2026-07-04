// ChatRegistry — single Durable Object that tracks all conversations.
// Provides the agent dashboard its list of conversations.

export class ChatRegistry {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async ensureSchema() {
    if (this._schemaDone) return;
    await this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        room_id TEXT PRIMARY KEY,
        visitor_name TEXT DEFAULT '',
        visitor_email TEXT DEFAULT '',
        status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_message_at TEXT,
        last_message_preview TEXT DEFAULT '',
        unread_agent INTEGER DEFAULT 0,
        unread_visitor INTEGER DEFAULT 0,
        message_count INTEGER DEFAULT 0
      )
    `);
    this._schemaDone = true;
  }

  async fetch(request) {
    await this.ensureSchema();

    const url = new URL(request.url);
    const path = url.pathname;

    // POST /update — called by ChatRoom to update metadata
    if (request.method === 'POST' && path === '/update') {
      const body = await request.json();
      return this.handleUpdate(body);
    }

    // POST /create — create a new conversation entry
    if (request.method === 'POST' && path === '/create') {
      const body = await request.json();
      return this.handleCreate(body);
    }

    // GET /conversations — list all conversations for agent dashboard
    if (request.method === 'GET' && path === '/conversations') {
      return this.handleList(request);
    }

    // POST /close — close a conversation
    if (request.method === 'POST' && path === '/close') {
      const body = await request.json();
      return this.handleClose(body);
    }

    // POST /reopen — reopen a conversation
    if (request.method === 'POST' && path === '/reopen') {
      const body = await request.json();
      return this.handleReopen(body);
    }

    return new Response('Not found', { status: 404 });
  }

  async handleCreate(body) {
    const { room_id, visitor_name, visitor_email } = body;
    if (!room_id) {
      return new Response(JSON.stringify({ error: 'room_id required' }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      });
    }

    // Check if already exists
    const existing = await this.ctx.storage.sql.exec(
      'SELECT room_id FROM conversations WHERE room_id = ?', room_id
    );
    if (existing && existing.length > 0) {
      return new Response(JSON.stringify({ ok: true, existing: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    await this.ctx.storage.sql.exec(
      `INSERT INTO conversations (room_id, visitor_name, visitor_email, status, created_at)
       VALUES (?, ?, ?, 'open', datetime('now'))`,
      room_id, visitor_name || '', visitor_email || ''
    );

    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  async handleUpdate(body) {
    const { room_id, last_message_preview, visitor_name, visitor_email } = body;
    if (!room_id) return new Response('{}', { headers: { 'Content-Type': 'application/json' } });

    // Increment unread counts for agents
    const existing = await this.ctx.storage.sql.exec(
      'SELECT visitor_name, visitor_email FROM conversations WHERE room_id = ?', room_id
    );

    const currentVisitorName = existing?.[0]?.visitor_name || '';
    const finalName = visitor_name || currentVisitorName;
    const finalEmail = visitor_email || existing?.[0]?.visitor_email || '';

    await this.ctx.storage.sql.exec(
      `UPDATE conversations SET
        last_message_at = datetime('now'),
        last_message_preview = ?,
        visitor_name = ?,
        visitor_email = ?,
        message_count = message_count + 1,
        unread_agent = unread_agent + 1
       WHERE room_id = ?`,
      last_message_preview?.slice(0, 120) || '',
      finalName,
      finalEmail,
      room_id
    );

    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  async handleList(request) {
    const url = new URL(request.url);
    const includeClosed = url.searchParams.get('closed') === 'true';

    const rows = await this.ctx.storage.sql.exec(
      `SELECT room_id, visitor_name, visitor_email, status, created_at,
              last_message_at, last_message_preview, unread_agent, unread_visitor, message_count
       FROM conversations
       WHERE (? = 1 OR status = 'open')
       ORDER BY last_message_at DESC, created_at DESC
       LIMIT 100`,
      includeClosed ? 1 : 0
    );

    return new Response(JSON.stringify({
      conversations: (rows || []).map(r => ({
        room_id: r.room_id,
        visitor_name: r.visitor_name,
        visitor_email: r.visitor_email,
        status: r.status,
        created_at: r.created_at,
        last_message_at: r.last_message_at,
        last_message_preview: r.last_message_preview,
        unread_agent: r.unread_agent,
        unread_visitor: r.unread_visitor,
        message_count: r.message_count,
      })),
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  async handleClose(body) {
    const { room_id } = body;
    if (!room_id) return new Response('{}', { headers: { 'Content-Type': 'application/json' } });

    await this.ctx.storage.sql.exec(
      "UPDATE conversations SET status = 'closed' WHERE room_id = ?", room_id
    );
    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  async handleReopen(body) {
    const { room_id } = body;
    if (!room_id) return new Response('{}', { headers: { 'Content-Type': 'application/json' } });

    await this.ctx.storage.sql.exec(
      "UPDATE conversations SET status = 'open', unread_agent = 0, unread_visitor = 0 WHERE room_id = ?",
      room_id
    );
    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
