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
  return msgs.map(m => ({
    id: m.id,
    sender_role: m.sender_role,
    sender_name: m.sender_name,
    content: m.content,
    created_at: m.created_at,
    file_url: m.file_url || null,
    file_type: m.file_type || null,
    file_name: m.file_name || null,
  }));
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

// ─── Upload helpers ──────────────────────────────────────────

const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf'];
const MAX_UPLOAD = 10 * 1024 * 1024; // 10 MB

async function handleUpload(request, env, roomId) {
  try {
    const formData = await request.formData();
    const file = formData.get('file');
    if (!file) return json({ error: 'No file provided' }, 400);

    if (!ALLOWED_TYPES.includes(file.type)) {
      return json({ error: 'File type not allowed. Accepted: JPEG, PNG, GIF, WebP, PDF' }, 400);
    }
    if (file.size > MAX_UPLOAD) {
      return json({ error: 'File too large. Max 10 MB' }, 400);
    }

    const ext = file.name.split('.').pop() || 'jpg';
    const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const key = `uploads/${roomId}/${filename}`;

    const buffer = await file.arrayBuffer();
    await env.CHAT_UPLOADS.put(key, buffer, {
      httpMetadata: { contentType: file.type },
      customMetadata: { originalName: file.name },
    });

    const publicUrl = `/api/files/${key}`;

    // Create a message with the file
    const role = formData.get('role') || 'visitor';
    const name = formData.get('name') || 'Guest';
    const caption = (formData.get('caption') || '').trim().slice(0, 200);
    const content = caption || (file.type.startsWith('image/') ? ' Sent an image' : ' Sent a file');

    const msg = await sendMessage(env, roomId, role, name, content);
    msg.file_url = publicUrl;
    msg.file_type = file.type;
    msg.file_name = file.name;

    // Store file metadata with the message
    const msgKey2 = msgKey(roomId, msg.id);
    const existing = await env.CHAT_KV.get(msgKey2, 'json') || {};
    existing.file_url = publicUrl;
    existing.file_type = file.type;
    existing.file_name = file.name;
    await env.CHAT_KV.put(msgKey2, JSON.stringify(existing));

    // Broadcast to DO
    try {
      const doId = env.CHAT_ROOM.idFromName(roomId);
      const stub = env.CHAT_ROOM.get(doId);
      stub.fetch('http://dummy/notify', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'message', ...msg, file_url: publicUrl, file_type: file.type, file_name: file.name }),
      }).catch(() => {});
    } catch {}

    return json({ ok: true, message: { ...msg, file_url: publicUrl, file_type: file.type, file_name: file.name } });
  } catch (err) {
    return json({ error: 'Upload failed: ' + err.message }, 500);
  }
}

// ─── CORS ────────────────────────────────────────────────────

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Chat-Role, X-Chat-Name, X-Requested-With',
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
        const visitorPhone = (body.phone || '').trim().slice(0, 20);
        const visitorAge = (body.age || '').trim().slice(0, 3);
        const visitorFirstName = (body.first_name || '').trim().slice(0, 50);
        const visitorLastName = (body.last_name || '').trim().slice(0, 50);
        const roomId = crypto.randomUUID().slice(0, 8);

        // Create room meta in KV
        const meta = {
          room_id: roomId,
          visitor_name: visitorName,
          visitor_first_name: visitorFirstName,
          visitor_last_name: visitorLastName,
          visitor_email: visitorEmail,
          visitor_phone: visitorPhone,
          visitor_age: visitorAge,
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

    // API: Upload file
    const uploadMatch = path.match(/^\/api\/upload\/([a-zA-Z0-9-]+)$/);
    if (request.method === 'POST' && uploadMatch) {
      return handleUpload(request, env, uploadMatch[1]);
    }

    // API: Serve uploaded files
    const fileMatch = path.match(/^\/api\/files\/(.+)$/);
    if (request.method === 'GET' && fileMatch) {
      try {
        const key = fileMatch[1];
        const obj = await env.CHAT_UPLOADS.get(key);
        if (!obj) return json({ error: 'File not found' }, 404);
        const headers = {
          'Content-Type': obj.httpMetadata?.contentType || 'application/octet-stream',
          'Cache-Control': 'public, max-age=31536000',
          'Access-Control-Allow-Origin': '*',
        };
        if (obj.customMetadata?.originalName) {
          headers['Content-Disposition'] = `inline; filename="${obj.customMetadata.originalName}"`;
        }
        return new Response(obj.body, { headers });
      } catch (err) {
        return json({ error: 'File not found' }, 404);
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
    agentsOnline: 0,
    isTyping: false,
    typingTimer: null,
  };

  const statusDot = document.getElementById('bagh-dot');
  const statusText = document.getElementById('bagh-status-text');

  function setOnline(online) {
    statusDot.className = 'bagh-dot' + (online ? '' : ' bagh-dot--offline');
    statusText.textContent = online ? "We're online" : "Away - we will reply when back";
  }

  const style = document.createElement('style');
  style.textContent = [
    '#bagh-chat * { box-sizing: border-box; }',
    '#bagh-chat { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }',
    '#bagh-chat-btn { position: fixed; bottom: 24px; right: 24px; z-index: 9999; width: 60px; height: 60px; border-radius: 50%; background: #075f74; color: #fff; border: none; cursor: pointer; box-shadow: 0 6px 24px rgba(7,95,116,0.35); display: flex; align-items: center; justify-content: center; transition: transform 0.2s; }',
    '#bagh-chat-btn:hover { transform: scale(1.08); }',
    '#bagh-chat-btn svg { width: 28px; height: 28px; fill: currentColor; }',
    '#bagh-chat-panel { position: fixed; bottom: 96px; right: 24px; z-index: 9998; width: 360px; height: 520px; max-height: calc(100vh - 140px); background: #fff; border-radius: 16px; box-shadow: 0 12px 48px rgba(0,0,0,0.18); display: none; flex-direction: column; overflow: hidden; animation: bagh-up 0.25s ease; }',
    '#bagh-chat-panel.open { display: flex; }',
    '@keyframes bagh-up { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }',
    '.bagh-hdr { background: #075f74; color: #fff; padding: 16px 20px; position: relative; }',
    '.bagh-hdr h3 { margin: 0; font-size: 1rem; font-weight: 600; }',
    '.bagh-hdr p { margin: 4px 0 0; font-size: 0.8rem; opacity: 0.85; }',
    '.bagh-status { display: flex; align-items: center; gap: 6px; margin-top: 6px; font-size: 0.75rem; }',
    '.bagh-dot { width: 8px; height: 8px; border-radius: 50%; background: #4caf50; display: inline-block; }',
    '.bagh-dot--offline { background: #999; }',
    '.bagh-typing { font-size: 0.8rem; color: #888; font-style: italic; padding: 4px 16px; }',
    '.bagh-close { position: absolute; top: 12px; right: 16px; background: none; border: none; color: #fff; font-size: 1.3rem; cursor: pointer; }',
    '.bagh-msgs { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 8px; }',
    '.bagh-msg { max-width: 80%; padding: 10px 14px; border-radius: 12px; font-size: 0.9rem; line-height: 1.4; word-wrap: break-word; }',
'.bagh-msg--visitor { background: #f0f0f0; color: #1a1a1a; align-self: flex-start; }',
'.bagh-msg--agent { background: #075f74; color: #fff; align-self: flex-end; }',
    '.bagh-msg--system { background: transparent; color: #888; align-self: center; font-size: 0.8rem; font-style: italic; }',
'.bagh-input { padding: 12px 16px; border-top: 1px solid #eee; display: flex; gap: 6px; align-items: flex-end; }',
'.bagh-input textarea { flex: 1; border: 1px solid #ddd; border-radius: 10px; padding: 10px 14px; font-size: 0.9rem; resize: none; outline: none; font-family: inherit; }',
'.bagh-input button { background: #075f74; color: #fff; border: none; border-radius: 10px; padding: 10px 16px; cursor: pointer; font-weight: 600; font-size: 0.85rem; }',
'.bagh-input button:hover { background: #0d2538; }',
'.bagh-ico-btn { background: none; border: 1px solid #ddd; border-radius: 10px; padding: 8px 10px; cursor: pointer; color: #888; font-size: 1.1rem; line-height: 1; display: flex; align-items: center; flex-shrink: 0; }',
'.bagh-ico-btn:hover { background: #f5f5f0; color: #555; }',
'.bagh-img { max-width: 100%; border-radius: 8px; margin-top: 4px; display: block; }',
'.bagh-file-link { display: block; font-size: 0.8rem; color: #c8a97e; text-decoration: underline; margin-top: 4px; }',
'.bagh-map-wrap { margin-top: 6px; border-radius: 8px; overflow: hidden; border: 1px solid #e0ddd5; }',
'.bagh-map-wrap iframe { width: 100%; height: 200px; border: 0; display: block; border-radius: 8px; }',
    '.bagh-form { padding: 24px 20px; display: flex; flex-direction: column; gap: 10px; flex: 1; justify-content: center; }',
    '.bagh-form h3 { margin: 0; font-size: 1.05rem; }',
    '.bagh-form p { margin: 0 0 8px; color: #666; font-size: 0.85rem; }',
    '.bagh-form input { padding: 10px 14px; border: 1px solid #ddd; border-radius: 10px; font-size: 0.9rem; outline: none; }',
    '.bagh-form button { background: #075f74; color: #fff; border: none; border-radius: 10px; padding: 12px; cursor: pointer; font-weight: 600; }',
'.bagh-form button:hover { background: #0d2538; }',
    '.bagh-loading { display: flex; align-items: center; justify-content: center; flex: 1; color: #888; font-size: 0.9rem; } .bagh-loading::after { content: ''; width: 16px; height: 16px; margin-left: 8px; border: 2px solid #ddd; border-top-color: #075f74; border-radius: 50%; animation: bagh-spin 0.6s linear infinite; } @keyframes bagh-spin { to { transform: rotate(360deg); } }',
    '@media (max-width: 480px) { #bagh-chat-panel { width: 100vw; height: 100vh; bottom: 0; right: 0; border-radius: 0; max-height: none; } #bagh-chat-btn { bottom: 16px; right: 16px; width: 54px; height: 54px; } }'
  ].join(' ');
  document.head.appendChild(style);

  const chat = document.createElement('div');
  chat.id = 'bagh-chat';
  chat.innerHTML = [
    '<button id="bagh-chat-btn" aria-label="Chat"><svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/></svg></button>',
    '<div id="bagh-chat-panel">',
    '<div class="bagh-hdr"><h3>Bahamas Adventure Guides</h3><p>Ask us anything</p><div class="bagh-status" id="bagh-status"><span class="bagh-dot bagh-dot--offline" id="bagh-dot"></span><span id="bagh-status-text">Loading...</span></div><button class="bagh-close" id="bagh-close">&times;</button></div>',
    '<div id="bagh-form" class="bagh-form"><h3>Start chatting</h3><p>Leave your name and we\\'ll be right with you.</p><input type="text" id="bagh-name" placeholder="Your name" maxlength="100" /><button id="bagh-start">Start Chat</button></div>',
    '<div id="bagh-loading" class="bagh-loading" style="display:none">Connecting...</div>',
    '<div id="bagh-chat-view" style="display:none;flex-direction:column;flex:1"><div class="bagh-msgs" id="bagh-msgs"></div><div class="bagh-input"><button class="bagh-ico-btn" id="bagh-file-btn" title="Attach file">File</button><textarea id="bagh-input" placeholder="Type..." rows="1"></textarea><button class="bagh-ico-btn" id="bagh-loc-btn" title="Share location">Map</button><button id="bagh-send">Send</button></div></div>',
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
  const startBtn = document.getElementById('bagh-start');
  const fileBtn = document.getElementById('bagh-file-btn');
  const locBtn = document.getElementById('bagh-loc-btn');
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'image/jpeg,image/png,image/gif,image/webp,application/pdf';
  fileInput.style.display = 'none';
  document.body.appendChild(fileInput);

  // Global open function for site buttons — works immediately or with queuing
  window.baghOpenChat = function() {
    if (panel) {
      panel.classList.add('open');
      btn.classList.remove('bagh-has-unread');
      if (state.roomId) loadHistory();
    }
  };
  // Also set a flag so buttons can check readiness
  window.baghChatReady = true;

  btn.onclick = () => {
    panel.classList.toggle('open');
    if (panel.classList.contains('open') && state.roomId) loadHistory();
  };
  document.getElementById('bagh-close').onclick = () => panel.classList.remove('open');

  

  startBtn.onclick = async () => {
    const first = firstInput.value.trim();
    const last = lastInput.value.trim();
    if (!first || !last) {
      if (!first) firstInput.focus();
      else lastInput.focus();
      return;
    }
    state.visitorName = first + ' ' + last;
    state.visitorEmail = emailInput.value.trim();
    state.visitorPhone = phoneInput.value.trim();
    state.visitorAge = ageInput.value.trim();
    form.style.display = 'none';
    loading.style.display = 'flex';
    try {
      const resp = await fetch(API + '/api/init', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: state.visitorName,
          first_name: first,
          last_name: last,
          email: state.visitorEmail,
          phone: state.visitorPhone,
          age: state.visitorAge,
        }),
      });
      const data = await resp.json();
      if (!data.ok) throw new Error();
      state.roomId = data.room_id;
      localStorage.setItem(ROOM_META_KEY, state.roomId);
      loading.style.display = 'none';
      chatView.style.display = 'flex';
      connectWs(data.ws_url);
      loadHistory();
      setTimeout(function() {
        if (loading.style.display !== 'none') {
          loading.innerHTML = 'Still connecting...';
        }
      }, 8000);
    } catch (e) {
      loading.innerHTML = 'Failed to connect. <button onclick="location.reload()" style="margin-top:8px;padding:8px;border:1px solid #ccc;border-radius:8px;background:#fff;cursor:pointer;">Retry</button>';
    }
  };

  function connectWs(wsPath) {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = proto + '//' + location.host + wsPath + '?role=visitor';
    const ws = new WebSocket(wsUrl);
    state.ws = ws;
    ws.onopen = () => {
      state.connected = true;
      ws.send(JSON.stringify({ type: 'set_name', name: state.visitorName }));
      setOnline(true);
    };
    ws.onmessage = (e) => {
      const data = JSON.parse(e.data);
      if (data.type === 'message' || data.type === 'message_ack') {
        addMsg(data.sender_role === 'visitor' ? 'visitor' : 'agent', data.sender_name || 'Agent', data.content, data.file_url, data.file_type, data.file_name);
      } else if (data.type === 'presence') {
        state.agentsOnline = data.agents_online || 0;
        setOnline(data.agents_online > 0);
      } else if (data.type === 'typing') {
        if (data.is_typing) {
          state.isTyping = true;
          showTyping();
        } else {
          state.isTyping = false;
          hideTyping();
        }
      }
    };
    ws.onclose = () => {
      state.connected = false;
      setOnline(false);
      startPolling();
    };
  }

  function showTyping() {
    const existing = document.getElementById('bagh-typing');
    if (!existing) {
      const el = document.createElement('div');
      el.id = 'bagh-typing';
      el.className = 'bagh-typing';
      el.textContent = 'Agent is typing...';
      document.getElementById('bagh-msgs').after(el);
    }
  }
  function hideTyping() {
    const el = document.getElementById('bagh-typing');
    if (el) el.remove();
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
        state.messages = data.messages.map(m => ({
          id: m.id,
          sender_role: m.sender_role,
          sender_name: m.sender_name,
          content: m.content,
          file_url: m.file_url,
          file_type: m.file_type,
          file_name: m.file_name,
        }));
        renderMsgs();
      }
    } catch {}
  }

  function extractLocation(text) {
    if (!text) return null;
    // Pattern: lat,lng (e.g. 25.0780,-77.3389)
    const coordMatch = text.match(/(-?\d+\.?\d*),\s*(-?\d+\.?\d*)/);
    if (coordMatch) {
      const lat = parseFloat(coordMatch[1]);
      const lng = parseFloat(coordMatch[2]);
      if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
        return { lat, lng };
      }
    }
    // Pattern: /location place name - geocode via Nominatim
    const locCmd = text.match(/\\/location\\s+(.+)/i);
    if (locCmd) {
      return { query: locCmd[1].trim() };
    }
    return null;
  }

  function locationEmbedUrl(loc) {
    if (loc.lat && loc.lng) {
      return 'https://www.openstreetmap.org/export/embed.html?bbox=' + (loc.lng - 0.02) + ',' + (loc.lat - 0.02) + ',' + (loc.lng + 0.02) + ',' + (loc.lat + 0.02) + '&layer=mapnik&marker=' + loc.lat + ',' + loc.lng + ';'
    }
    return null;
  }

  function renderLocationMap(container, loc) {
    const url = locationEmbedUrl(loc);
    if (!url) return;
    const wrap = document.createElement('div');
    wrap.className = 'bagh-map-wrap';
    const iframe = document.createElement('iframe');
    iframe.src = url;
    iframe.loading = 'lazy';
    iframe.title = 'Map location';
    wrap.appendChild(iframe);
    container.appendChild(wrap);
  }

  function addMsg(role, name, text, fileUrl, fileType, fileName) {
    state.messages.push({
      sender_role: role, sender_name: name, content: text,
      file_url: fileUrl, file_type: fileType, file_name: fileName,
      id: Date.now(),
    });
    renderMsgs();
  }

  function renderMsgs() {
    msgs.innerHTML = '';
    for (const m of state.messages) {
      const el = document.createElement('div');
      el.className = 'bagh-msg bagh-msg--' + (m.sender_role === 'visitor' ? 'visitor' : 'agent');
      
      const textEl = document.createElement('div');
      textEl.textContent = m.content;
      el.appendChild(textEl);

      // Location map preview
      const loc = extractLocation(m.content);
      if (loc) {
        renderLocationMap(el, loc);
      }

      // File preview
      if (m.file_url) {
        if (m.file_type && m.file_type.startsWith('image/')) {
          const img = document.createElement('img');
          img.className = 'bagh-img';
          img.src = m.file_url;
          img.alt = m.file_name || 'Image';
          img.loading = 'lazy';
          el.appendChild(img);
        } else {
          const link = document.createElement('a');
          link.className = 'bagh-file-link';
          link.href = m.file_url;
          link.target = '_blank';
          link.textContent = ' ' + (m.file_name || 'View file');
          el.appendChild(link);
        }
      }

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

  // File upload
  fileBtn.onclick = () => fileInput.click();
  fileInput.onchange = async () => {
    const file = fileInput.files?.[0];
    if (!file || !state.roomId) return;
    fileInput.value = '';

    // Optimistically show uploading
    addMsg('visitor', 'You', ' Uploading...');

    const formData = new FormData();
    formData.append('file', file);
    formData.append('role', 'visitor');
    formData.append('name', state.visitorName);

    try {
      const resp = await fetch(API + '/api/upload/' + state.roomId, {
        method: 'POST', body: formData,
      });
      const data = await resp.json();
      if (data.ok) {
        // Real message with file URL will arrive via WS or poll
      }
    } catch {}
    loadHistory();
  };

  // Location sharing
  locBtn.onclick = async () => {
    const place = prompt('Enter a place name or coordinates (e.g. "Nassau Harbour" or "25.0780,-77.3389"):');
    if (!place || !state.roomId) return;
    const coordMatch = place.match(/(-?\d+\.?\d*),\s*(-?\d+\.?\d*)/);
    if (coordMatch) {
      const lat = parseFloat(coordMatch[1]);
      const lng = parseFloat(coordMatch[2]);
      input.value = lat + ',' + lng;
      sendMessage();
    } else {
      // Geocode via Nominatim
      addMsg('visitor', 'You', 'Searching for ' + place + '...');
      try {
        const resp = await fetch('https://nominatim.openstreetmap.org/search?format=json&q=' + encodeURIComponent(place) + '&countrycodes=bs&limit=5', {
          headers: { 'User-Agent': 'BahamasAdventureGuides/1.0' }
        });
        const data = await resp.json();
        if (data && data.length > 0) {
          const lat = parseFloat(data[0].lat);
          const lng = parseFloat(data[0].lon);
          const displayName = data[0].display_name.split(',')[0];
          input.value = displayName + ': ' + lat + ',' + lng;
          // Replace the searching message
          state.messages = state.messages.filter(m => m.content !== 'Searching for ' + place + '...');
          sendMessage();
        } else {
          state.messages = state.messages.filter(m => m.content !== 'Searching for ' + place + '...');
          addMsg('system', '', 'Could not find that place. Try coordinates (e.g. 25.0780,-77.3389)');
        }
      } catch {
        state.messages = state.messages.filter(m => m.content !== 'Searching for ' + place + '...');
        addMsg('system', '', 'Location search failed. Try coordinates (e.g. 25.0780,-77.3389)');
      }
    }
  };

  sendBtn.onclick = sendMessage;
  input.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    // Send typing indicator
    if (state.ws && state.connected) {
      state.ws.send(JSON.stringify({ type: 'typing', is_typing: true }));
      clearTimeout(state.typingTimer);
      state.typingTimer = setTimeout(() => {
        if (state.ws && state.connected) state.ws.send(JSON.stringify({ type: 'typing', is_typing: false }));
      }, 2000);
    }
  };
  input.onblur = () => {
    if (state.ws && state.connected) state.ws.send(JSON.stringify({ type: 'typing', is_typing: false }));
  };

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
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f4f2ed; color: #1a1a1a; }
.login-page { display: flex; align-items: center; justify-content: center; min-height: 100vh; background: linear-gradient(135deg, #0d2538 0%, #1a4a5e 50%, #0d2538 100%); }
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
.sidebar { width: 340px; background: #0d2538; border-right: 1px solid #1a3a4e; display: flex; flex-direction: column; color: #e8e4de; }
.sidebar-header { padding: 16px 20px; border-bottom: 1px solid #1a3a4e; }
.sidebar-header h2 { font-size: 1.1rem; color: #c8a97e; }
.sidebar-header p { color: #8a9aa8; }
.conv-list { flex: 1; overflow-y: auto; }
.conv-item { padding: 14px 20px; border-bottom: 1px solid #1a3a4e; cursor: pointer; transition: background 0.15s; }
.conv-item:hover { background: #153242; }
.conv-item.active { background: #1a3a4e; }
.conv-item h4 { font-size: 0.9rem; margin-bottom: 4px; color: #e8e4de; }
.conv-item p { font-size: 0.82rem; color: #8a9aa8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.conv-item .meta { font-size: 0.75rem; color: #5a7a8a; margin-top: 4px; }
.main-area { flex: 1; display: flex; flex-direction: column; background: #f4f2ed; }
.chat-header { padding: 16px 24px; border-bottom: 1px solid #e0ddd5; background: #fff; display: flex; justify-content: space-between; align-items: center; }
.chat-header h3 { font-size: 1rem; }
.chat-header .info { font-size: 0.8rem; color: #888; }
.chat-header button { background: none; border: 1px solid #ddd; border-radius: 8px; padding: 6px 14px; font-size: 0.8rem; cursor: pointer; }
.msgs-area { flex: 1; overflow-y: auto; padding: 20px 24px; display: flex; flex-direction: column; gap: 10px; background: #fff; margin: 16px; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.06); }
.dmsg { max-width: 70%; padding: 10px 14px; border-radius: 12px; font-size: 0.9rem; line-height: 1.4; }
.dmsg--visitor { background: #e8e4de; align-self: flex-start; }
.dmsg--agent { background: #0d2538; color: #fff; align-self: flex-end; }
.dmsg--system { align-self: center; font-size: 0.8rem; color: #888; font-style: italic; }
.input-area { padding: 12px 24px 20px; border-top: 1px solid #e0ddd5; background: #fff; display: flex; gap: 10px; }
.input-area textarea { flex: 1; border: 1px solid #ddd; border-radius: 10px; padding: 10px 14px; font-size: 0.9rem; resize: none; outline: none; font-family: inherit; background: #f4f2ed; }
.input-area textarea:focus { border-color: #c8a97e; background: #fff; }
.input-area button { background: #075f74; color: #fff; border: none; border-radius: 10px; padding: 10px 20px; cursor: pointer; font-weight: 600; }
.input-area button:hover { background: #0d2538; }
.input-area .bagh-ico-btn { background: none; border: 1px solid #ddd; border-radius: 10px; padding: 8px 10px; cursor: pointer; color: #888; font-size: 1.1rem; line-height: 1; display: flex; align-items: center; flex-shrink: 0; }
.input-area .bagh-ico-btn:hover { background: #f5f5f0; color: #555; }
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
      <button class="bagh-ico-btn" id="dash-file-btn" title="Attach file">FileFile</button>
      <textarea id="reply-input" placeholder="Type your reply..." rows="1"></textarea>
      <button class="bagh-ico-btn" id="dash-loc-btn" title="Share location">MapMap</button>
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
  let wsConnections = {}; // roomId -> WebSocket
  let dashUploading = false;

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

  var prevUnread = 0;

  async function loadConvs() {
    try {
      const r = await fetch(API + '/api/conversations', { headers: headers() });
      const d = await r.json();
      
      // Count unread conversations (ones not currently active)
      var totalUnread = 0;
      for (const c of (d.conversations || [])) {
        if (c.room_id !== activeRoom && (c.unread_agent || 0) > 0) {
          totalUnread++;
        }
      }
      
      // Show badge
      var badge = document.getElementById('unread-badge');
      if (totalUnread > 0) {
        if (!badge) {
          badge = document.createElement('div');
          badge.id = 'unread-badge';
          badge.className = 'notif-badge';
          document.body.appendChild(badge);
        }
        badge.textContent = totalUnread > 9 ? '9+' : totalUnread;
        
        // Play notification sound on new message (works on mobile browsers too)
        if (totalUnread > prevUnread) {
          try {
            var ctx = new (window.AudioContext || window.webkitAudioContext)();
            var osc = ctx.createOscillator();
            var gain = ctx.createGain();
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.frequency.value = 800;
            gain.gain.value = 0.15;
            osc.start(ctx.currentTime);
            osc.stop(ctx.currentTime + 0.15);
            // Second beep
            var osc2 = ctx.createOscillator();
            var gain2 = ctx.createGain();
            osc2.connect(gain2);
            gain2.connect(ctx.destination);
            osc2.frequency.value = 1000;
            gain2.gain.value = 0.1;
            osc2.start(ctx.currentTime + 0.2);
            osc2.stop(ctx.currentTime + 0.35);
            // Vibrate on mobile
            if (navigator.vibrate) navigator.vibrate(200);
          } catch(e) {}
        }
      } else {
        if (badge) badge.remove();
      }
      prevUnread = totalUnread;
      
      const list = document.getElementById('conv-list');
      list.innerHTML = '';
      document.getElementById('conv-count').textContent = (d.conversations || []).length + ' conversations';
      for (const c of (d.conversations || [])) {
        const el = document.createElement('div');
        el.className = 'conv-item' + (c.room_id === activeRoom ? ' active' : '');
        var unreadMark = (c.unread_agent || 0) > 0 ? ' <span style="background:#e8c98a;color:#0d2538;font-size:0.7rem;padding:1px 6px;border-radius:8px;margin-left:6px;">' + c.unread_agent + '</span>' : '';
        el.innerHTML = '<h4>' + (c.visitor_name || 'Anonymous') + unreadMark + '</h4><p>' + (c.last_message_preview || 'No messages') + '</p><div class="meta">' + c.status + '</div>';
        el.onclick = () => selectConv(c.room_id);
        list.appendChild(el);
      }
    } catch {}
  }

  async function selectConv(roomId) {
    activeRoom = roomId;
    localMessages = [];
    document.getElementById('close-btn').style.display = 'inline-block';
    document.getElementById('input-area').style.display = 'flex';
    document.querySelector('.no-conv') && (document.querySelector('.no-conv').style.display = 'none');
    loadConvs();
    connectRoomWS(roomId);
    await loadMsgs();
  }

  async function loadMsgs() {
    if (!activeRoom) return;
    try {
      const r = await fetch(API + '/api/messages/' + activeRoom);
      const d = await r.json();
      // Merge: keep local messages, add any from server that we dont have
      const serverIds = new Set(localMessages.map(m => m.id));
      for (const m of (d.messages || [])) {
        if (!serverIds.has(m.id)) {
          localMessages.push(m);
        }
      }
      localMessages.sort((a, b) => (a.id || 0) - (b.id || 0));
      renderLocalMsgs();
    } catch {}
  }

  document.getElementById('reply-btn').onclick = sendReply;
  document.getElementById('reply-input').onkeydown = e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendReply(); }
  };

  let localMessages = [];

  function addLocalMsg(role, name, content, fileUrl, fileType, fileName) {
    localMessages.push({
      id: Date.now() + Math.random(),
      sender_role: role,
      sender_name: name,
      content: content,
      file_url: fileUrl || null,
      file_type: fileType || null,
      file_name: fileName || null,
      created_at: new Date().toISOString(),
    });
    renderLocalMsgs();
  }

  function connectRoomWS(roomId) {
    // Close any existing connection for another room
    for (const [rid, ws] of Object.entries(wsConnections)) {
      if (rid !== roomId) { ws.close(); delete wsConnections[rid]; }
    }
    if (wsConnections[roomId]) return; // already connected
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(proto + '//' + location.host + '/api/ws/' + roomId + '?role=agent');
    wsConnections[roomId] = ws;
    ws.onmessage = (e) => {
      const data = JSON.parse(e.data);
      if (data.type === 'message' && data.sender_role === 'visitor') {
        // Incoming visitor message - add to local if not already there
        if (!localMessages.find(m => m.id === data.id)) {
          localMessages.push({
            id: data.id || Date.now(),
            sender_role: 'visitor',
            sender_name: data.sender_name || 'Visitor',
            content: data.content,
            created_at: data.created_at,
          });
          renderLocalMsgs();
        }
      }
    };
    ws.onclose = () => { delete wsConnections[roomId]; };
  }

  const DASHBOARD_STYLES = [
    '.dmsg-img { max-width: 100%; border-radius: 8px; margin-top: 4px; cursor: pointer; display: block; }',
    '.dmsg-file { display: block; font-size: 0.8rem; color: #c8a97e; text-decoration: underline; margin-top: 4px; }',
    '.dmsg-map-wrap { margin-top: 6px; border-radius: 8px; overflow: hidden; border: 1px solid #e0ddd5; max-width: 320px; }',
    '.dmsg-map-wrap iframe { width: 100%; height: 200px; border: 0; display: block; border-radius: 8px; }',
  '.notif-badge { position: fixed; top: 12px; right: 12px; background: #e74c3c; color: #fff; border-radius: 50%; width: 24px; height: 24px; display: flex; align-items: center; justify-content: center; font-size: 0.75rem; font-weight: 700; z-index: 100; box-shadow: 0 2px 8px rgba(231,76,60,0.3); }',
  ];
  const dashStyle = document.createElement('style');
  dashStyle.textContent = DASHBOARD_STYLES.join(' ');
  document.head.appendChild(dashStyle);

  function renderLocalMsgs() {
    const area = document.getElementById('msgs-area');
    area.innerHTML = '';
    for (const m of localMessages) {
      const el = document.createElement('div');
      el.className = 'dmsg dmsg--' + (m.sender_role === 'visitor' ? 'visitor' : 'agent');

      const textEl = document.createElement('div');
      textEl.textContent = m.content;
      el.appendChild(textEl);

      // Dashboard location map
      const dashLoc = extractLocation(m.content);
      if (dashLoc) {
        const url = dashLoc.lat && dashLoc.lng
          ? 'https://www.openstreetmap.org/export/embed.html?bbox=' + (dashLoc.lng - 0.02) + ',' + (dashLoc.lat - 0.02) + ',' + (dashLoc.lng + 0.02) + ',' + (dashLoc.lat + 0.02) + '&layer=mapnik&marker=' + dashLoc.lat + ',' + dashLoc.lng
          : null;
        if (url) {
          const wrap = document.createElement('div');
          wrap.className = 'dmsg-map-wrap';
          const iframe = document.createElement('iframe');
          iframe.src = url;
          iframe.loading = 'lazy';
          iframe.title = 'Map location';
          wrap.appendChild(iframe);
          el.appendChild(wrap);
        }
      }

      if (m.file_url) {
        if (m.file_type && m.file_type.startsWith('image/')) {
          const img = document.createElement('img');
          img.className = 'dmsg-img';
          img.src = m.file_url;
          img.alt = m.file_name || 'Image';
          img.loading = 'lazy';
          img.onclick = () => window.open(m.file_url, '_blank');
          el.appendChild(img);
        } else {
          const link = document.createElement('a');
          link.className = 'dmsg-file';
          link.href = m.file_url;
          link.target = '_blank';
          link.textContent = '\u{1F4CE} ' + (m.file_name || 'View file');
          el.appendChild(link);
        }
      }

      area.appendChild(el);
    }
    area.scrollTop = area.scrollHeight;
  }

  // Dashboard file upload
  const dashFileInput = document.createElement('input');
  dashFileInput.type = 'file';
  dashFileInput.accept = 'image/jpeg,image/png,image/gif,image/webp,application/pdf';
  dashFileInput.style.display = 'none';
  document.body.appendChild(dashFileInput);

  document.getElementById('dash-file-btn').onclick = () => dashFileInput.click();

  // Dashboard location sharing
  document.getElementById('dash-loc-btn').onclick = async () => {
    const place = prompt('Enter a place name or coordinates (e.g. "Paradise Harbour Marina" or "25.0780,-77.3389"):');
    if (!place || !activeRoom) return;
    const coordMatch = place.match(/(-?\d+\.?\d*),\s*(-?\d+\.?\d*)/);
    if (coordMatch) {
      const lat = parseFloat(coordMatch[1]);
      const lng = parseFloat(coordMatch[2]);
      document.getElementById('reply-input').value = lat + ',' + lng;
      document.getElementById('reply-btn').click();
    } else {
      addLocalMsg('agent', 'Adventure Guide Agent', 'Searching for ' + place + '...');
      try {
        const resp = await fetch('https://nominatim.openstreetmap.org/search?format=json&q=' + encodeURIComponent(place) + '&countrycodes=bs&limit=5', {
          headers: { 'User-Agent': 'BahamasAdventureGuides/1.0' }
        });
        const data = await resp.json();
        if (data && data.length > 0) {
          const lat = data[0].lat;
          const lng = data[0].lon;
          const displayName = data[0].display_name.split(',')[0];
          localMessages = localMessages.filter(m => m.content !== 'Searching for ' + place + '...');
          document.getElementById('reply-input').value = displayName + ': ' + lat + ',' + lng;
          document.getElementById('reply-btn').click();
        } else {
          localMessages = localMessages.filter(m => m.content !== 'Searching for ' + place + '...');
          addLocalMsg('system', '', 'Could not find that place. Try exact coordinates');
        }
      } catch {
        localMessages = localMessages.filter(m => m.content !== ' Searching for ' + place + '...');
        addLocalMsg('system', '', 'Location search failed');
      }
    }
  };

  dashFileInput.onchange = async () => {
    const file = dashFileInput.files?.[0];
    if (!file || !activeRoom || dashUploading) return;
    dashFileInput.value = '';
    dashUploading = true;

    addLocalMsg('agent', 'Adventure Guide Agent', ' Uploading...');

    const formData = new FormData();
    formData.append('file', file);
    formData.append('role', 'agent');
    formData.append('name', 'Adventure Guide Agent');

    try {
      const resp = await fetch(API + '/api/upload/' + activeRoom, { method: 'POST', body: formData });
      const data = await resp.json();
      if (data.ok && data.message) {
        // Remove the optimistic "uploading" message and add the real one
        localMessages = localMessages.filter(m => m.content !== ' Uploading...');
        addLocalMsg('agent', 'Adventure Guide Agent', data.message.content, data.message.file_url, data.message.file_type, data.message.file_name);
      }
    } catch {}
    dashUploading = false;
  };

  async function sendReply() {
    const text = document.getElementById('reply-input').value.trim();
    if (!text || !activeRoom) return;
    document.getElementById('reply-input').value = '';
    addLocalMsg('agent', 'Adventure Guide Agent', text);
    try {
      await fetch(API + '/api/send/' + activeRoom, {
        method: 'POST', headers: { ...headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'agent', name: 'Adventure Guide Agent', content: text }),
      });
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
