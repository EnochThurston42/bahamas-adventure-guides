// ChatRegistry — single Durable Object that stores conversation metadata in memory.
// The worker persists data to KV, but uses this DO for fast in-memory lookups.

export class ChatRegistry {
  constructor(ctx) {
    this.ctx = ctx;
    this.conversations = new Map();
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === 'POST' && path === '/create') {
      const body = await request.json();
      this.conversations.set(body.room_id, {
        room_id: body.room_id,
        visitor_name: body.visitor_name || '',
        visitor_email: body.visitor_email || '',
        status: 'open',
        created_at: new Date().toISOString(),
        last_message_at: null,
        last_message_preview: '',
        unread_agent: 0,
        unread_visitor: 0,
        message_count: 0,
      });
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (method === 'POST' && path === '/update') {
      const body = await request.json();
      const conv = this.conversations.get(body.room_id);
      if (conv) {
        conv.last_message_at = new Date().toISOString();
        conv.last_message_preview = (body.last_message_preview || '').slice(0, 120);
        conv.message_count = (conv.message_count || 0) + 1;
        if (body.visitor_name) conv.visitor_name = body.visitor_name;
        if (body.visitor_email) conv.visitor_email = body.visitor_email;
      }
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (method === 'GET' && path === '/list') {
      const includeClosed = url.searchParams.get('closed') === 'true';
      const list = [];
      for (const conv of this.conversations.values()) {
        if (!includeClosed && conv.status === 'closed') continue;
        list.push(conv);
      }
      list.sort((a, b) => {
        if (a.last_message_at && b.last_message_at) return b.last_message_at.localeCompare(a.last_message_at);
        if (a.last_message_at) return -1;
        if (b.last_message_at) return 1;
        return b.created_at.localeCompare(a.created_at);
      });
      return new Response(JSON.stringify({ conversations: list }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (method === 'POST' && path === '/close') {
      const body = await request.json();
      const conv = this.conversations.get(body.room_id);
      if (conv) conv.status = 'closed';
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response('Not found', { status: 404 });
  }
}
