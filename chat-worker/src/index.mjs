import { ChatRoom } from './chat-room.mjs';
import { ChatRegistry } from './chat-registry.mjs';

export { ChatRoom, ChatRegistry };

// ─── Auth ────────────────────────────────────────────────────

function validateAuth(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const cookie = request.headers.get('Cookie') || '';
  const token = auth.replace(/^Bearer /, '') || cookie.match(/bagh_session=([^;]+)/)?.[1] || '';
  return token === env.AGENT_TOKEN ? env.AGENT_NAME : null;
}

// ─── KV helpers ──────────────────────────────────────────────

const KV_PREFIX = 'chat:';

function msgKey(roomId, msgId) {
  return `${KV_PREFIX}room:${roomId}:msg:${String(msgId).padStart(10, '0')}`;
}
function roomMetaKey(roomId) { return `${KV_PREFIX}room:${roomId}:meta`; }
function roomListKey() { return `${KV_PREFIX}rooms`; }
function msgCounterKey(roomId) { return `${KV_PREFIX}room:${roomId}:counter`; }

async function getRoomMeta(env, roomId) {
  const val = await env.CHAT_KV.get(roomMetaKey(roomId), 'json');
  return val || null;
}

async function setRoomMeta(env, roomId, meta) {
  await env.CHAT_KV.put(roomMetaKey(roomId), JSON.stringify(meta));
}

async function listMessages(env, roomId, afterId = 0) {
  const prefix = `${KV_PREFIX}room:${roomId}:msg:`;
  const all = await env.CHAT_KV.list({ prefix, limit: 100 });
  const msgs = [];
  for (const key of all.keys) {
    if (!key.name.includes(':msg:')) continue;
    const raw = await env.CHAT_KV.get(key.name);
    try {
      const msg = JSON.parse(raw);
      if (msg && msg.id > afterId) msgs.push(msg);
    } catch {}
  }
  msgs.sort((a, b) => a.id - b.id);
  return msgs;
}

async function sendMessage(env, roomId, senderRole, senderName, content) {
  const counter = await env.CHAT_KV.get(msgCounterKey(roomId), 'json') || 0;
  const msgId = counter + 1;
  const msg = {
    id: msgId,
    sender_role: senderRole,
    sender_name: senderName,
    content: content.trim().slice(0, 5000),
    created_at: new Date().toISOString(),
  };
  await env.CHAT_KV.put(msgKey(roomId, msgId), JSON.stringify(msg));
  await env.CHAT_KV.put(msgCounterKey(roomId), JSON.stringify(msgId));

  // Update room meta
  let meta = await getRoomMeta(env, roomId);
  if (meta) {
    meta.last_message_at = msg.created_at;
    meta.last_message_preview = msg.content.slice(0, 120);
    meta.message_count = (meta.message_count || 0) + 1;
    if (senderRole === 'visitor') meta.unread_agent = (meta.unread_agent || 0) + 1;
    await setRoomMeta(env, roomId, meta);
  }

  return msg;
}

// ─── CORS ────────────────────────────────────────────────────

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Chat-Role, X-Chat-Name',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

function html(body) {
  return new Response(body, {
    headers: { ...CORS, 'Content-Type': 'text/html; charset=utf-8' },
  });
}

function js(body) {
  return new Response(body, {
    headers: { ...CORS, 'Content-Type': 'application/javascript; charset=utf-8' },
  });
}

// ─── Routes ──────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    // Static
    if (path === '/widget.js') return js(WIDGET_JS);
    if (path === '/dashboard' || path === '/dashboard/') return html(DASHBOARD_HTML);

    // API: Init chat
    if (request.method === 'POST' && path === '/api/init') {
      try {
        const body = await request.json();
        const visitorName = (body.name || 'Guest').trim().slice(0, 100);
        const visitorEmail = (body.email || '').trim().slice(0, 200);
        const roomId = crypto.randomUUID().slice(0, 8);

        // Create room meta in KV
        const meta = {
          room_id: roomId,
          visitor_name: visitorName,
          visitor_email: visitorEmail,
          status: 'open',
          created_at: new Date().toISOString(),
          last_message_at: null,
          last_message_preview: '',
          unread_agent: 0,
          unread_visitor: 0,
          message_count: 0,
        };
        await setRoomMeta(env, roomId, meta);

        // Add to room list
        const rooms = JSON.parse(await env.CHAT_KV.get(roomListKey()) || '[]');
        if (!rooms.includes(roomId)) {
          rooms.push(roomId);
          await env.CHAT_KV.put(roomListKey(), JSON.stringify(rooms));
        }

        // Register in DO registry
        try {
          const registryId = env.CHAT_REGISTRY.idFromName('global');
          const stub = env.CHAT_REGISTRY.get(registryId);
          await stub.fetch('http://dummy/create', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ room_id: roomId, visitor_name: visitorName, visitor_email: visitorEmail }),
          });
        } catch {}

        return json({
          ok: true, room_id: roomId,
          ws_url: `/api/ws/${roomId}`,
          rest_url: `/api/messages/${roomId}`,
        });
      } catch (err) {
        return json({ error: 'Failed to start chat: ' + err.message }, 500);
      }
    }

    // API: WebSocket upgrade
    const wsMatch = path.match(/^\/api\/ws\/([a-zA-Z0-9-]+)$/);
    if (request.method === 'GET' && wsMatch) {
      const roomId = wsMatch[1];
      const doId = env.CHAT_ROOM.idFromName(roomId);
      const stub = env.CHAT_ROOM.get(doId);
      return stub.fetch(request.url, { headers: request.headers });
    }

    // API: Send message (from visitor widget)
    if (request.method === 'POST' && path.match(/^\/api\/send\/([a-zA-Z0-9-]+)$/)) {
      const roomId = path.match(/^\/api\/send\/([a-zA-Z0-9-]+)$/)[1];
      try {
        const body = await request.json();
        const role = body.role || 'visitor';
        const name = body.name || 'Guest';
        const content = body.content || '';

        // Store in KV
        const msg = await sendMessage(env, roomId, role, name, content);

        // Broadcast via DO WebSocket (fire-and-forget)
        try {
          const doId = env.CHAT_ROOM.idFromName(roomId);
          const stub = env.CHAT_ROOM.get(doId);
          stub.fetch('http://dummy/notify', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'message', ...msg }),
          }).catch(() => {});
        } catch {}

        return json({ ok: true, message: msg });
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // API: Get messages
    const msgMatch = path.match(/^\/api\/messages\/([a-zA-Z0-9-]+)$/);
    if (request.method === 'GET' && msgMatch) {
      const roomId = msgMatch[1];
      const after = parseInt(url.searchParams.get('after') || '0', 10);
      const messages = await listMessages(env, roomId, after);
      return json({ messages });
    }

    // API: List conversations (agent auth required)
    if (request.method === 'GET' && path === '/api/conversations') {
      const agentName = validateAuth(request, env);
      if (!agentName) return json({ error: 'Unauthorized' }, 401);

      const includeClosed = url.searchParams.get('closed') === 'true';
      const rooms = JSON.parse(await env.CHAT_KV.get(roomListKey()) || '[]');
      const conversations = [];
      for (const roomId of rooms) {
        const meta = await getRoomMeta(env, roomId);
        if (meta && (includeClosed || meta.status !== 'closed')) {
          conversations.push(meta);
        }
      }
      conversations.sort((a, b) => {
        if (a.last_message_at && b.last_message_at) return b.last_message_at.localeCompare(a.last_message_at);
        if (a.last_message_at) return -1;
        if (b.last_message_at) return 1;
        return b.created_at.localeCompare(a.created_at);
      });
      return json({ conversations });
    }

    // API: Close conversation (agent auth required)
    if (request.method === 'POST' && path === '/api/close') {
      const agentName = validateAuth(request, env);
      if (!agentName) return json({ error: 'Unauthorized' }, 401);
      const body = await request.json();
      const meta = await getRoomMeta(env, body.room_id);
      if (meta) {
        meta.status = 'closed';
        await setRoomMeta(env, body.room_id, meta);
      }
      return json({ ok: true });
    }

    // API: Login
    if (request.method === 'POST' && path === '/api/login') {
      const body = await request.json();
      if (body.username === env.AGENT_USERNAME && body.password === env.AGENT_PASSWORD) {
        const headers = { ...CORS, 'Set-Cookie': `bagh_session=${env.AGENT_TOKEN}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800` };
        return new Response(JSON.stringify({ ok: true, agent: { name: env.AGENT_NAME || 'Agent' } }), {
          status: 200, headers: { ...headers, 'Content-Type': 'application/json' },
        });
      }
      return json({ error: 'Invalid credentials' }, 401);
    }

    // API: Check auth
    if (request.method === 'GET' && path === '/api/check-auth') {
      const name = validateAuth(request, env);
      if (name) return json({ ok: true, agent: { name } });
      return json({ ok: false }, 401);
    }

    return json({ error: 'Not found' }, 404);
  },
};

// ─── Widget JS ────────────────────────────────────────────────

const WIDGET_JS = `
(function() {
  'use strict';

  const API = '';
  const ROOM_META_KEY = 'bagh_chat_room';

  let state = {
    roomId: localStorage.getItem(ROOM_META_KEY) || null,
    ws: null,
    messages: [],
    connected: false,
    visitorName: '',
    visitorEmail: '',
    pollTimer: null,
  };

  const style = document.createElement('style');
  style.textContent = [
    '#bagh-chat * { box-sizing: border-box; }',
    '#bagh-chat { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }',
    '#bagh-chat-btn { position: fixed; bottom: 24px; right: 24px; z-index: 9999; width: 60px; height: 60px; border-radius: 50%; background: #c8a97e; color: #fff; border: none; cursor: pointer; box-shadow: 0 6px 24px rgba(0,0,0,0.2); display: flex; align-items: center; justify-content: center; transition: transform 0.2s; }',
    '#bagh-chat-btn:hover { transform: scale(1.08); }',
    '#bagh-chat-btn svg { width: 28px; height: 28px; fill: currentColor; }',
    '#bagh-chat-panel { position: fixed; bottom: 96px; right: 24px; z-index: 9998; width: 360px; height: 520px; max-height: calc(100vh - 140px); background: #fff; border-radius: 16px; box-shadow: 0 12px 48px rgba(0,0,0,0.18); display: none; flex-direction: column; overflow: hidden; animation: bagh-up 0.25s ease; }',
    '#bagh-chat-panel.open { display: flex; }',
    '@keyframes bagh-up { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }',
    '.bagh-hdr { background: #c8a97e; color: #fff; padding: 16px 20px; position: relative; }',
    '.bagh-hdr h3 { margin: 0; font-size: 1rem; font-weight: 600; }',
    '.bagh-hdr p { margin: 4px 0 0; font-size: 0.8rem; opacity: 0.85; }',
    '.bagh-close { position: absolute; top: 12px; right: 16px; background: none; border: none; color: #fff; font-size: 1.3rem; cursor: pointer; }',
    '.bagh-msgs { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 8px; }',
    '.bagh-msg { max-width: 80%; padding: 10px 14px; border-radius: 12px; font-size: 0.9rem; line-height: 1.4; word-wrap: break-word; }',
    '.bagh-msg--visitor { background: #f0f0f0; color: #1a1a1a; align-self: flex-end; }',
    '.bagh-msg--agent { background: #c8a97e; color: #fff; align-self: flex-start; }',
    '.bagh-msg--system { background: transparent; color: #888; align-self: center; font-size: 0.8rem; font-style: italic; }',
    '.bagh-input { padding: 12px 16px; border-top: 1px solid #eee; display: flex; gap: 8px; }',
    '.bagh-input textarea { flex: 1; border: 1px solid #ddd; border-radius: 10px; padding: 10px 14px; font-size: 0.9rem; resize: none; outline: none; font-family: inherit; }',
    '.bagh-input button { background: #c8a97e; color: #fff; border: none; border-radius: 10px; padding: 10px 16px; cursor: pointer; font-weight: 600; }',
    '.bagh-form { padding: 24px 20px; display: flex; flex-direction: column; gap: 12px; flex: 1; justify-content: center; }',
    '.bagh-form h3 { margin: 0; font-size: 1.05rem; }',
    '.bagh-form p { margin: 0 0 8px; color: #666; font-size: 0.85rem; }',
    '.bagh-form input { padding: 10px 14px; border: 1px solid #ddd; border-radius: 10px; font-size: 0.9rem; outline: none; }',
    '.bagh-form button { background: #c8a97e; color: #fff; border: none; border-radius: 10px; padding: 12px; cursor: pointer; font-weight: 600; }',
    '.bagh-loading { display: flex; align-items: center; justify-content: center; flex: 1; color: #888; }',
    '@media (max-width: 480px) { #bagh-chat-panel { width: 100vw; height: 100vh; bottom: 0; right: 0; border-radius: 0; max-height: none; } #bagh-chat-btn { bottom: 16px; right: 16px; width: 54px; height: 54px; } }'
  ].join(' ');
  document.head.appendChild(style);

  const chat = document.createElement('div');
  chat.id = 'bagh-chat';
  chat.innerHTML = [
    '<button id="bagh-chat-btn" aria-label="Chat"><svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/></svg></button>',
    '<div id="bagh-chat-panel">',
    '<div class="bagh-hdr"><h3>Bahamas Adventure Guides</h3><p>Ask us anything</p><button class="bagh-close" id="bagh-close">&times;</button></div>',
    '<div id="bagh-form" class="bagh-form"><h3>Start chatting</h3><p>Leave your name and we\'ll be right with you.</p><input type="text" id="bagh-name" placeholder="Your name" maxlength="100" /><button id="bagh-start">Start Chat</button></div>',
    '<div id="bagh-loading" class="bagh-loading" style="display:none">Connecting...</div>',
    '<div id="bagh-chat-view" style="display:none;flex-direction:column;flex:1"><div class="bagh-msgs" id="bagh-msgs"></div><div class="bagh-input"><textarea id="bagh-input" placeholder="Type..." rows="1"></textarea><button id="bagh-send">Send</button></div></div>',
    '</div>'
  ].join('');
  document.body.appendChild(chat);

  const btn = document.getElementById('bagh-chat-btn');
  const panel = document.getElementById('bagh-chat-panel');
  const form = document.getElementById('bagh-form');
  const loading = document.getElementById('bagh-loading');
  const chatView = document.getElementById('bagh-chat-view');
  const msgs = document.getElementById('bagh-msgs');
  const input = document.getElementById('bagh-input');
  const sendBtn = document.getElementById('bagh-send');
  const nameInput = document.getElementById('bagh-name');
  const startBtn = document.getElementById('bagh-start');

  btn.onclick = () => {
    panel.classList.toggle('open');
    if (panel.classList.contains('open') && state.roomId) loadHistory();
  };
  document.getElementById('bagh-close').onclick = () => panel.classList.remove('open');

  nameInput.onkeydown = (e) => { if (e.key === 'Enter') startBtn.click(); };

  startBtn.onclick = async () => {
    const name = nameInput.value.trim();
    if (!name) return;
    state.visitorName = name;
    form.style.display = 'none';
    loading.style.display = 'flex';
    try {
      const resp = await fetch(API + '/api/init', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: state.visitorName, email: '' }),
      });
      const data = await resp.json();
      if (!data.ok) throw new Error();
      state.roomId = data.room_id;
      localStorage.setItem(ROOM_META_KEY, state.roomId);
      loading.style.display = 'none';
      chatView.style.display = 'flex';
      connectWs(data.ws_url);
      loadHistory();
    } catch (e) {
      loading.innerHTML = 'Failed to connect. <button onclick="location.reload()" style="margin-top:8px;padding:8px;border:1px solid #ccc;border-radius:8px;background:#fff;cursor:pointer;">Retry</button>';
    }
  };

  function connectWs(wsPath) {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = proto + '//' + location.host + wsPath;
    const ws = new WebSocket(wsUrl);
    state.ws = ws;
    ws.onopen = () => {
      state.connected = true;
      ws.send(JSON.stringify({ type: 'set_name', name: state.visitorName }));
    };
    ws.onmessage = (e) => {
      const data = JSON.parse(e.data);
      if (data.type === 'message' || data.type === 'message_ack') {
        addMsg(data.sender_role === 'visitor' ? 'visitor' : 'agent', data.sender_name || 'Agent', data.content);
      }
    };
    ws.onclose = () => { state.connected = false; startPolling(); };
  }

  function startPolling() {
    if (state.pollTimer) return;
    state.pollTimer = setInterval(async () => {
      if (!state.roomId || state.connected) return;
      await loadHistory();
    }, 3000);
  }

  async function loadHistory() {
    if (!state.roomId) return;
    try {
      const resp = await fetch(API + '/api/messages/' + state.roomId);
      const data = await resp.json();
      if (data.messages) {
        state.messages = data.messages;
        renderMsgs();
      }
    } catch {}
  }

  function addMsg(role, name, text) {
    state.messages.push({ sender_role: role, sender_name: name, content: text, id: Date.now() });
    renderMsgs();
  }

  function renderMsgs() {
    msgs.innerHTML = '';
    for (const m of state.messages) {
      const el = document.createElement('div');
      el.className = 'bagh-msg bagh-msg--' + (m.sender_role === 'visitor' ? 'visitor' : 'agent');
      el.textContent = m.content;
      msgs.appendChild(el);
    }
    msgs.scrollTop = msgs.scrollHeight;
  }

  async function sendMessage() {
    const text = input.value.trim();
    if (!text || !state.roomId) return;
    input.value = '';
    addMsg('visitor', 'You', text);
    try {
      await fetch(API + '/api/send/' + state.roomId, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'visitor', name: state.visitorName, content: text }),
      });
      if (state.connected && state.ws) {
        state.ws.send(JSON.stringify({ type: 'message', content: text }));
      }
    } catch {}
  }

  sendBtn.onclick = sendMessage;
  input.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } };

  // If returning visitor, skip form
  if (state.roomId) {
    form.style.display = 'none';
    loading.style.display = 'flex';
    chatView.style.display = 'flex';
    loading.style.display = 'none';
    loadHistory();
  }
})();
`;

// ─── Dashboard HTML ──────────────────────────────────────────

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Agent Dashboard — Bahamas Adventure Guides</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f5f0; color: #1a1a1a; }
.login-page { display: flex; align-items: center; justify-content: center; min-height: 100vh; background: #2d4a2d; }
.login-box { background: #fff; padding: 40px; border-radius: 16px; width: 360px; max-width: 90vw; }
.login-box h1 { font-size: 1.4rem; margin-bottom: 4px; }
.login-box p { color: #666; font-size: 0.9rem; margin-bottom: 24px; }
.login-box input { width: 100%; padding: 12px 14px; border: 1px solid #ddd; border-radius: 10px; font-size: 0.95rem; margin-bottom: 12px; outline: none; }
.login-box input:focus { border-color: #c8a97e; }
.login-box button { width: 100%; padding: 12px; background: #c8a97e; color: #fff; border: none; border-radius: 10px; font-size: 1rem; font-weight: 600; cursor: pointer; }
.login-box button:hover { opacity: 0.9; }
.login-error { color: #e74c3c; font-size: 0.85rem; margin-top: 8px; display: none; }
.app { display: none; height: 100vh; }
.app.auth { display: flex; }
.sidebar { width: 340px; background: #fff; border-right: 1px solid #e0ddd5; display: flex; flex-direction: column; }
.sidebar-header { padding: 16px 20px; border-bottom: 1px solid #e0ddd5; }
.sidebar-header h2 { font-size: 1.1rem; }
.conv-list { flex: 1; overflow-y: auto; }
.conv-item { padding: 14px 20px; border-bottom: 1px solid #f0eee8; cursor: pointer; }
.conv-item:hover { background: #f9f8f5; }
.conv-item.active { background: #f0ede6; }
.conv-item h4 { font-size: 0.9rem; margin-bottom: 4px; }
.conv-item p { font-size: 0.82rem; color: #888; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.conv-item .meta { font-size: 0.75rem; color: #aaa; margin-top: 4px; }
.main-area { flex: 1; display: flex; flex-direction: column; background: #fff; }
.chat-header { padding: 16px 24px; border-bottom: 1px solid #e0ddd5; display: flex; justify-content: space-between; align-items: center; }
.chat-header h3 { font-size: 1rem; }
.chat-header .info { font-size: 0.8rem; color: #888; }
.chat-header button { background: none; border: 1px solid #ddd; border-radius: 8px; padding: 6px 14px; font-size: 0.8rem; cursor: pointer; }
.msgs-area { flex: 1; overflow-y: auto; padding: 20px 24px; display: flex; flex-direction: column; gap: 10px; }
.dmsg { max-width: 70%; padding: 10px 14px; border-radius: 12px; font-size: 0.9rem; line-height: 1.4; }
.dmsg--visitor { background: #f0f0f0; align-self: flex-end; }
.dmsg--agent { background: #c8a97e; color: #fff; align-self: flex-start; }
.dmsg--system { align-self: center; font-size: 0.8rem; color: #888; font-style: italic; }
.input-area { padding: 16px 24px; border-top: 1px solid #e0ddd5; display: flex; gap: 10px; }
.input-area textarea { flex: 1; border: 1px solid #ddd; border-radius: 10px; padding: 10px 14px; font-size: 0.9rem; resize: none; outline: none; font-family: inherit; }
.input-area textarea:focus { border-color: #c8a97e; }
.input-area button { background: #c8a97e; color: #fff; border: none; border-radius: 10px; padding: 10px 20px; cursor: pointer; font-weight: 600; }
.no-conv { flex: 1; display: flex; align-items: center; justify-content: center; color: #888; }
@media (max-width: 768px) { .sidebar { width: 100%; } .app { flex-direction: column; } }
</style>
</head>
<body>
<div class="login-page" id="login-page">
  <div class="login-box">
    <h1>Agent Dashboard</h1>
    <p>Sign in to reply to visitors</p>
    <input type="text" id="login-user" placeholder="Username" autocomplete="username">
    <input type="password" id="login-pass" placeholder="Password" autocomplete="current-password">
    <button id="login-btn">Sign In</button>
    <p class="login-error" id="login-error">Invalid credentials</p>
  </div>
</div>

<div class="app" id="app">
  <div class="sidebar">
    <div class="sidebar-header"><h2>Conversations</h2><p id="conv-count">Loading...</p></div>
    <div class="conv-list" id="conv-list"></div>
  </div>
  <div class="main-area">
    <div class="chat-header">
      <div><h3 id="chat-title">Select a conversation</h3><div class="info" id="visitor-info"></div></div>
      <button id="close-btn" style="display:none">Close</button>
    </div>
    <div class="msgs-area" id="msgs-area"><div class="no-conv">Select a conversation</div></div>
    <div class="input-area" id="input-area" style="display:none">
      <textarea id="reply-input" placeholder="Type your reply..." rows="1"></textarea>
      <button id="reply-btn">Send</button>
    </div>
  </div>
</div>

<script>
(function() {
  const API = '';
  const TOKEN = localStorage.getItem('bagh_token');
  let activeRoom = null;
  let pollTimer = null;

  if (TOKEN) checkAuth();

  document.getElementById('login-btn').onclick = login;
  document.getElementById('login-pass').onkeydown = e => { if (e.key === 'Enter') login(); };

  async function login() {
    const u = document.getElementById('login-user').value;
    const p = document.getElementById('login-pass').value;
    const r = await fetch(API + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) });
    if (!r.ok) { document.getElementById('login-error').style.display = 'block'; return; }
    const d = await r.json();
    localStorage.setItem('bagh_token', '1');
    document.getElementById('login-page').style.display = 'none';
    document.getElementById('app').classList.add('auth');
    load();
  }

  async function checkAuth() {
    const r = await fetch(API + '/api/check-auth');
    if (r.ok) {
      document.getElementById('login-page').style.display = 'none';
      document.getElementById('app').classList.add('auth');
      load();
    } else {
      localStorage.removeItem('bagh_token');
    }
  }

  function headers() {
    return { 'Authorization': 'Bearer ' + '' };
  }

  async function load() {
    await loadConvs();
    setInterval(loadConvs, 5000);
    setInterval(loadMsgs, 3000);
  }

  async function loadConvs() {
    try {
      const r = await fetch(API + '/api/conversations', { headers: headers() });
      const d = await r.json();
      const list = document.getElementById('conv-list');
      list.innerHTML = '';
      document.getElementById('conv-count').textContent = (d.conversations || []).length + ' conversations';
      for (const c of (d.conversations || [])) {
        const el = document.createElement('div');
        el.className = 'conv-item' + (c.room_id === activeRoom ? ' active' : '');
        el.innerHTML = '<h4>' + (c.visitor_name || 'Anonymous') + '</h4><p>' + (c.last_message_preview || 'No messages') + '</p><div class="meta">' + c.status + '</div>';
        el.onclick = () => selectConv(c.room_id);
        list.appendChild(el);
      }
    } catch {}
  }

  async function selectConv(roomId) {
    activeRoom = roomId;
    document.getElementById('close-btn').style.display = 'inline-block';
    document.getElementById('input-area').style.display = 'flex';
    document.querySelector('.no-conv') && (document.querySelector('.no-conv').style.display = 'none');
    loadConvs();
    await loadMsgs();
  }

  async function loadMsgs() {
    if (!activeRoom) return;
    try {
      const r = await fetch(API + '/api/messages/' + activeRoom);
      const d = await r.json();
      const area = document.getElementById('msgs-area');
      area.innerHTML = '';
      for (const m of (d.messages || [])) {
        const el = document.createElement('div');
        el.className = 'dmsg dmsg--' + (m.sender_role === 'visitor' ? 'visitor' : 'agent');
        el.textContent = m.content;
        area.appendChild(el);
      }
      area.scrollTop = area.scrollHeight;
      
      // Update title
      const meta = (d.messages && d.messages.length > 0) ? d.messages[0] : null;
      if (meta) document.getElementById('chat-title').textContent = meta.sender_name || 'Visitor';
    } catch {}
  }

  document.getElementById('reply-btn').onclick = sendReply;
  document.getElementById('reply-input').onkeydown = e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendReply(); }
  };

  async function sendReply() {
    const text = document.getElementById('reply-input').value.trim();
    if (!text || !activeRoom) return;
    document.getElementById('reply-input').value = '';
    try {
      await fetch(API + '/api/send/' + activeRoom, {
        method: 'POST', headers: { ...headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'agent', name: 'Adventure Guide Agent', content: text }),
      });
      await loadMsgs();
    } catch {}
  }

  document.getElementById('close-btn').onclick = async () => {
    if (!activeRoom) return;
    await fetch(API + '/api/close', { method: 'POST', headers: { ...headers(), 'Content-Type': 'application/json' }, body: JSON.stringify({ room_id: activeRoom }) });
    activeRoom = null;
    document.getElementById('close-btn').style.display = 'none';
    document.getElementById('input-area').style.display = 'none';
    document.getElementById('chat-title').textContent = 'Select a conversation';
    document.getElementById('visitor-info').textContent = '';
    document.getElementById('msgs-area').innerHTML = '<div class="no-conv">Select a conversation</div>';
  };
})();
</script>
</body>
</html>`;
