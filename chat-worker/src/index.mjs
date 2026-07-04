// Main entry — routes all chat traffic to Durable Objects.
// Also serves the widget JS and agent dashboard HTML.

import { ChatRoom } from './chat-room.mjs';
import { ChatRegistry } from './chat-registry.mjs';

export { ChatRoom, ChatRegistry };

// ─── Auth helpers ─────────────────────────────────────────────

const SESSION_COOKIE = 'bagh_chat_session';
const SESSION_TTL = 86400 * 7; // 7 days

// In production, use env vars. For now, a simple token-based auth.
function validateAgentAuth(request, env) {
  // Check Authorization header
  const auth = request.headers.get('Authorization') || '';
  const match = auth.match(/^Bearer (.+)$/);
  if (match) {
    const token = match[1];
    if (token === env.AGENT_TOKEN) return { agent_token: token };
  }

  // Check session cookie
  const cookie = request.headers.get('Cookie') || '';
  const sessionMatch = cookie.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
  if (sessionMatch) {
    const sessionToken = sessionMatch[1];
    if (sessionToken === env.AGENT_TOKEN) return { agent_token: sessionToken };
  }

  return null;
}

function setSessionCookie(token) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL}`;
}

// ─── CORS headers ─────────────────────────────────────────────

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Chat-Role, X-Chat-Name',
};

function corsResponse(body, status = 200, extra = {}) {
  return new Response(body, {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json', ...extra },
  });
}

function htmlResponse(body, status = 200) {
  return new Response(body, {
    status,
    headers: { ...CORS, 'Content-Type': 'text/html; charset=utf-8' },
  });
}

function jsResponse(body, status = 200) {
  return new Response(body, {
    status,
    headers: { ...CORS, 'Content-Type': 'application/javascript; charset=utf-8' },
  });
}

// ─── Router ───────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    // ─── Static files ──────────────────────────────────────────

    // Widget JS for website visitors
    if (path === '/widget.js') {
      return jsResponse(WIDGET_JS);
    }

    // Agent dashboard
    if (path === '/dashboard' || path === '/dashboard/') {
      return htmlResponse(DASHBOARD_HTML);
    }

    // ─── API routes ────────────────────────────────────────────

    // POST /api/init — visitor starts a new chat
    if (request.method === 'POST' && path === '/api/init') {
      return handleInit(request, env);
    }

    // GET /api/ws/:roomId — WebSocket upgrade for a conversation
    if (request.method === 'GET' && path.match(/^\/api\/ws\/([a-zA-Z0-9-]+)$/)) {
      return handleWebSocket(request, env, path.match(/^\/api\/ws\/([a-zA-Z0-9-]+)$/)[1]);
    }

    // GET /api/messages/:roomId — HTTP fallback to fetch messages (polling)
    if (request.method === 'GET' && path.match(/^\/api\/messages\/([a-zA-Z0-9-]+)$/)) {
      return handleFetchMessages(request, env, path.match(/^\/api\/messages\/([a-zA-Z0-9-]+)$/)[1]);
    }

    // GET /api/conversations — agent dashboard lists conversations
    if (request.method === 'GET' && path === '/api/conversations') {
      return handleListConversations(request, env);
    }

    // POST /api/close — agent closes a conversation
    if (request.method === 'POST' && path === '/api/close') {
      return handleCloseConversation(request, env);
    }

    // POST /api/login — agent login
    if (request.method === 'POST' && path === '/api/login') {
      return handleLogin(request, env);
    }

    // GET /api/check-auth — check if agent is logged in
    if (request.method === 'GET' && path === '/api/check-auth') {
      return handleCheckAuth(request, env);
    }

    // ─── 404 ───────────────────────────────────────────────────
    return corsResponse(JSON.stringify({ error: 'Not found' }), 404);
  },
};

// ─── API handlers ─────────────────────────────────────────────

async function handleInit(request, env) {
  try {
    const body = await request.json();
    const visitorName = (body.name || 'Guest').trim().slice(0, 100);
    const visitorEmail = (body.email || '').trim().slice(0, 200);

    // Generate a short unique room ID
    const roomId = crypto.randomUUID().slice(0, 8);

    // Create the Durable Object for this room
    const doId = env.CHAT_ROOM.idFromName(roomId);
    const stub = env.CHAT_ROOM.get(doId);

    // Register in the registry
    const registryId = env.CHAT_REGISTRY.idFromName('global');
    const registryStub = env.CHAT_REGISTRY.get(registryId);
    await registryStub.fetch('http://dummy/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ room_id: roomId, visitor_name: visitorName, visitor_email: visitorEmail }),
    });

    return corsResponse(JSON.stringify({
      ok: true,
      room_id: roomId,
      ws_url: `/api/ws/${roomId}`,
      rest_url: `/api/messages/${roomId}`,
    }));
  } catch (err) {
    return corsResponse(JSON.stringify({ error: 'Failed to start chat' }), 500);
  }
}

async function handleWebSocket(request, env, roomId) {
  const doId = env.CHAT_ROOM.idFromName(roomId);
  const stub = env.CHAT_ROOM.get(doId);

  // Forward the WebSocket upgrade to the Durable Object
  return stub.fetch(request.url, {
    headers: request.headers,
  });
}

async function handleFetchMessages(request, env, roomId) {
  const doId = env.CHAT_ROOM.idFromName(roomId);
  const stub = env.CHAT_ROOM.get(doId);

  const response = await stub.fetch(request.url);
  const data = await response.json();
  return corsResponse(JSON.stringify(data));
}

async function handleListConversations(request, env) {
  const auth = validateAgentAuth(request, env);
  if (!auth) {
    return corsResponse(JSON.stringify({ error: 'Unauthorized' }), 401);
  }

  const registryId = env.CHAT_REGISTRY.idFromName('global');
  const stub = env.CHAT_REGISTRY.get(registryId);
  const response = await stub.fetch(request.url);
  const data = await response.json();
  return corsResponse(JSON.stringify(data));
}

async function handleCloseConversation(request, env) {
  const auth = validateAgentAuth(request, env);
  if (!auth) {
    return corsResponse(JSON.stringify({ error: 'Unauthorized' }), 401);
  }

  const body = await request.json();
  const registryId = env.CHAT_REGISTRY.idFromName('global');
  const stub = env.CHAT_REGISTRY.get(registryId);
  const response = await stub.fetch('http://dummy/close', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  return corsResponse(JSON.stringify(data));
}

async function handleLogin(request, env) {
  try {
    const body = await request.json();
    const username = body.username || '';
    const password = body.password || '';

    // Check against environment variables
    if (username === env.AGENT_USERNAME && password === env.AGENT_PASSWORD) {
      const headers = { ...CORS, 'Set-Cookie': setSessionCookie(env.AGENT_TOKEN) };
      return new Response(JSON.stringify({ ok: true, agent: { name: env.AGENT_NAME || 'Agent' } }), {
        status: 200,
        headers: { ...headers, 'Content-Type': 'application/json' },
      });
    }

    return corsResponse(JSON.stringify({ error: 'Invalid credentials' }), 401);
  } catch {
    return corsResponse(JSON.stringify({ error: 'Invalid request' }), 400);
  }
}

async function handleCheckAuth(request, env) {
  const auth = validateAgentAuth(request, env);
  if (auth) {
    return corsResponse(JSON.stringify({ ok: true, agent: { name: env.AGENT_NAME || 'Agent' } }));
  }
  return corsResponse(JSON.stringify({ ok: false }), 401);
}

// ─── Widget JS (inlined) ───────────────────────────────────────

const WIDGET_JS = `
(function() {
  'use strict';

  const CONFIG = {
    apiBase: '',
    chatTitle: 'Bahamas Adventure Guides',
    chatSubtitle: 'Ask us anything — we reply in minutes',
    primaryColor: '#c8a97e',
    welcomeMessage: 'Hi! How can we help you plan your Bahamas trip?',
  };

  let state = {
    roomId: null,
    sessionId: null,
    ws: null,
    messages: [],
    visitorName: '',
    visitorEmail: '',
    started: false,
    connected: false,
    pollTimer: null,
  };

  // ── Inject styles ──
  const style = document.createElement('style');
  style.textContent = \`
    #bagh-chat * { box-sizing: border-box; }
    #bagh-chat { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
    #bagh-chat-btn {
      position: fixed; bottom: 24px; right: 24px; z-index: 9999;
      width: 60px; height: 60px; border-radius: 50%;
      background: \${CONFIG.primaryColor}; color: #fff; border: none; cursor: pointer;
      box-shadow: 0 6px 24px rgba(0,0,0,0.2); transition: transform 0.2s, box-shadow 0.2s;
      display: flex; align-items: center; justify-content: center;
    }
    #bagh-chat-btn:hover { transform: scale(1.08); box-shadow: 0 8px 32px rgba(0,0,0,0.25); }
    #bagh-chat-btn svg { width: 28px; height: 28px; fill: currentColor; }
    #bagh-chat-btn.bagh-has-unread::after {
      content: ''; position: absolute; top: 4px; right: 4px;
      width: 12px; height: 12px; background: #e74c3c; border-radius: 50%;
      border: 2px solid #fff;
    }
    #bagh-chat-panel {
      position: fixed; bottom: 96px; right: 24px; z-index: 9998;
      width: 360px; height: 520px; max-height: calc(100vh - 140px);
      background: #fff; border-radius: 16px; box-shadow: 0 12px 48px rgba(0,0,0,0.18);
      display: none; flex-direction: column; overflow: hidden;
      animation: bagh-slide-up 0.25s ease;
    }
    #bagh-chat-panel.bagh-open { display: flex; }
    @keyframes bagh-slide-up {
      from { opacity: 0; transform: translateY(20px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .bagh-header {
      background: \${CONFIG.primaryColor}; color: #fff; padding: 16px 20px;
    }
    .bagh-header h3 { margin: 0; font-size: 1rem; font-weight: 600; }
    .bagh-header p { margin: 4px 0 0; font-size: 0.8rem; opacity: 0.85; }
    .bagh-header-close {
      position: absolute; top: 12px; right: 16px; background: none; border: none;
      color: #fff; font-size: 1.3rem; cursor: pointer; opacity: 0.7;
    }
    .bagh-header-close:hover { opacity: 1; }
    .bagh-messages {
      flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 8px;
    }
    .bagh-msg {
      max-width: 80%; padding: 10px 14px; border-radius: 12px; font-size: 0.9rem;
      line-height: 1.4; word-wrap: break-word;
    }
    .bagh-msg--visitor { background: #f0f0f0; color: #1a1a1a; align-self: flex-end; border-bottom-right-radius: 4px; }
    .bagh-msg--agent { background: \${CONFIG.primaryColor}; color: #fff; align-self: flex-start; border-bottom-left-radius: 4px; }
    .bagh-msg--system { background: transparent; color: #888; align-self: center; font-size: 0.8rem; font-style: italic; }
    .bagh-msg-time { font-size: 0.7rem; color: #999; margin-top: 4px; }
    .bagh-msg--visitor .bagh-msg-time { text-align: right; }
    .bagh-input-area {
      padding: 12px 16px; border-top: 1px solid #eee; display: flex; gap: 8px; align-items: flex-end;
    }
    .bagh-input-area textarea {
      flex: 1; border: 1px solid #ddd; border-radius: 10px; padding: 10px 14px; font-size: 0.9rem;
      resize: none; outline: none; font-family: inherit; max-height: 100px;
    }
    .bagh-input-area textarea:focus { border-color: \${CONFIG.primaryColor}; }
    .bagh-input-area button {
      background: \${CONFIG.primaryColor}; color: #fff; border: none; border-radius: 10px;
      padding: 10px 16px; cursor: pointer; font-weight: 600; font-size: 0.85rem;
    }
    .bagh-input-area button:disabled { opacity: 0.4; cursor: default; }
    .bagh-form {
      padding: 24px 20px; display: flex; flex-direction: column; gap: 12px; justify-content: center; flex: 1;
    }
    .bagh-form h3 { margin: 0 0 4px; font-size: 1.05rem; }
    .bagh-form p { margin: 0 0 8px; color: #666; font-size: 0.85rem; }
    .bagh-form input {
      padding: 10px 14px; border: 1px solid #ddd; border-radius: 10px; font-size: 0.9rem; outline: none;
    }
    .bagh-form input:focus { border-color: \${CONFIG.primaryColor}; }
    .bagh-form button {
      background: \${CONFIG.primaryColor}; color: #fff; border: none; border-radius: 10px;
      padding: 12px; cursor: pointer; font-weight: 600; font-size: 0.95rem;
    }
    .bagh-form button:hover { opacity: 0.9; }
    .bagh-connecting {
      display: flex; align-items: center; justify-content: center; flex: 1;
      color: #888; font-size: 0.9rem;
    }
    @media (max-width: 480px) {
      #bagh-chat-panel { width: 100vw; height: 100vh; bottom: 0; right: 0; border-radius: 0; max-height: none; }
      #bagh-chat-btn { bottom: 16px; right: 16px; width: 54px; height: 54px; }
    }
  \`;
  document.head.appendChild(style);

  // ── HTML structure ──
  const chat = document.createElement('div');
  chat.id = 'bagh-chat';
  chat.innerHTML = \`
    <button id="bagh-chat-btn" aria-label="Open chat">
      <svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/><path d="M7 9h10v2H7zm0-3h10v2H7zm0 6h7v2H7z"/></svg>
    </button>
    <div id="bagh-chat-panel">
      <div class="bagh-header" style="position:relative;">
        <h3>\${CONFIG.chatTitle}</h3>
        <p>\${CONFIG.chatSubtitle}</p>
        <button class="bagh-header-close" id="bagh-chat-close">&times;</button>
      </div>
      <div id="bagh-form-view" class="bagh-form">
        <h3>Start a conversation</h3>
        <p>Leave your name and email and we'll be right with you.</p>
        <input type="text" id="bagh-name" placeholder="Your name" maxlength="100" />
        <input type="email" id="bagh-email" placeholder="Your email (optional)" maxlength="200" />
        <button id="bagh-start-chat">Start Chat</button>
      </div>
      <div id="bagh-connecting-view" class="bagh-connecting" style="display:none;">Connecting...</div>
      <div id="bagh-chat-view" style="display:none;flex-direction:column;flex:1;">
        <div class="bagh-messages" id="bagh-messages"></div>
        <div class="bagh-input-area">
          <textarea id="bagh-msg-input" placeholder="Type your message..." rows="1"></textarea>
          <button id="bagh-send-btn">Send</button>
        </div>
      </div>
    </div>
  \`;
  document.body.appendChild(chat);

  // ── DOM refs ──
  const btn = document.getElementById('bagh-chat-btn');
  const panel = document.getElementById('bagh-chat-panel');
  const closeBtn = document.getElementById('bagh-chat-close');
  const formView = document.getElementById('bagh-form-view');
  const connectingView = document.getElementById('bagh-connecting-view');
  const chatView = document.getElementById('bagh-chat-view');
  const nameInput = document.getElementById('bagh-name');
  const emailInput = document.getElementById('bagh-email');
  const startBtn = document.getElementById('bagh-start-chat');
  const messagesContainer = document.getElementById('bagh-messages');
  const msgInput = document.getElementById('bagh-msg-input');
  const sendBtn = document.getElementById('bagh-send-btn');

  // ── Open / Close ──
  btn.addEventListener('click', () => {
    panel.classList.toggle('bagh-open');
    btn.classList.remove('bagh-has-unread');
    if (panel.classList.contains('bagh-open') && state.connected) {
      scrollToBottom();
    }
  });

  closeBtn.addEventListener('click', () => {
    panel.classList.remove('bagh-open');
  });

  // Auto-enter on Enter
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') startBtn.click();
  });
  emailInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') startBtn.click();
  });

  // ── Start chat ──
  startBtn.addEventListener('click', async () => {
    const name = nameInput.value.trim();
    if (!name) { nameInput.focus(); return; }
    state.visitorName = name;
    state.visitorEmail = emailInput.value.trim();
    formView.style.display = 'none';
    connectingView.style.display = 'flex';
    await initChat();
  });

  async function initChat() {
    try {
      const resp = await fetch(CONFIG.apiBase + '/api/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: state.visitorName, email: state.visitorEmail }),
      });
      const data = await resp.json();
      if (!data.ok) throw new Error('Init failed');
      state.roomId = data.room_id;
      state.started = true;
      connectWebSocket(data.ws_url);
    } catch (err) {
      connectingView.textContent = 'Failed to connect. Please try again.';
      connectingView.innerHTML += '<br><button onclick="location.reload()" style="margin-top:8px;padding:8px 16px;border:1px solid #ccc;border-radius:8px;background:#fff;cursor:pointer;">Retry</button>';
    }
  }

  // ── WebSocket ──
  function connectWebSocket(wsPath) {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = location.origin === 'https://bahamas-adventure-guides.pages.dev'
      ? \`wss://chat.bahamas-adventure-guides.pages.dev\${wsPath}\`
      : \`\${protocol}//\${location.host}\${wsPath}\`;

    const ws = new WebSocket(wsUrl);
    state.ws = ws;

    ws.onopen = () => {
      state.connected = true;
      connectingView.style.display = 'none';
      chatView.style.display = 'flex';
      // Send our name
      ws.send(JSON.stringify({ type: 'set_name', name: state.visitorName }));
      // Send welcome message from visitor
      ws.send(JSON.stringify({ type: 'message', content: 'Hi! I have a question about booking a trip.' }));
    };

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);

      if (data.type === 'connected') {
        state.sessionId = data.session_id;
      } else if (data.type === 'history') {
        state.messages = data.messages || [];
        renderMessages();
      } else if (data.type === 'message' || data.type === 'message_ack') {
        const msg = {
          id: data.id,
          role: data.sender_role === 'visitor' ? 'visitor' : 'agent',
          name: data.sender_name,
          text: data.content,
          time: data.created_at,
        };
        // Avoid duplicates
        if (!state.messages.find(m => m.id === data.id)) {
          state.messages.push(msg);
          renderMessages();
        }
      } else if (data.type === 'status') {
        addSystemMessage(data.message);
      }
    };

    ws.onclose = () => {
      state.connected = false;
      // Try polling fallback
      startPolling();
    };

    ws.onerror = () => {
      // Fallback
    };
  }

  // ── Polling fallback ──
  function startPolling() {
    if (state.pollTimer) return;
    state.pollTimer = setInterval(async () => {
      if (!state.roomId || state.connected) return;
      try {
        const lastId = state.messages.length > 0 ? state.messages[state.messages.length - 1].id : 0;
        const resp = await fetch(CONFIG.apiBase + '/api/messages/' + state.roomId + '?after=' + lastId);
        const data = await resp.json();
        if (data.messages && data.messages.length > 0) {
          for (const m of data.messages) {
            if (!state.messages.find(ex => ex.id === m.id)) {
              state.messages.push({
                id: m.id,
                role: m.sender_role === 'visitor' ? 'visitor' : 'agent',
                name: m.sender_name,
                text: m.content,
                time: m.created_at,
              });
            }
          }
          renderMessages();
        }
      } catch {}
    }, 3000);
  }

  // ── Send message ──
  function sendMessage() {
    const text = msgInput.value.trim();
    if (!text || !state.connected || !state.ws) return;
    state.ws.send(JSON.stringify({ type: 'message', content: text }));
    msgInput.value = '';
    msgInput.style.height = 'auto';
  }

  sendBtn.addEventListener('click', sendMessage);
  msgInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
  msgInput.addEventListener('input', () => {
    msgInput.style.height = 'auto';
    msgInput.style.height = Math.min(msgInput.scrollHeight, 100) + 'px';
  });

  // ── Render ──
  function renderMessages() {
    messagesContainer.innerHTML = '';
    for (const msg of state.messages) {
      const el = document.createElement('div');
      el.className = 'bagh-msg bagh-msg--' + (msg.role === 'visitor' ? 'visitor' : 'agent');
      el.textContent = msg.text;
      if (msg.name) {
        const nameEl = document.createElement('div');
        nameEl.style.cssText = 'font-size:0.7rem;opacity:0.7;margin-bottom:2px;';
        nameEl.textContent = msg.role === 'agent' ? msg.name : 'You';
        el.prepend(nameEl);
      }
      messagesContainer.appendChild(el);
    }
    scrollToBottom();
  }

  function addSystemMessage(text) {
    const el = document.createElement('div');
    el.className = 'bagh-msg bagh-msg--system';
    el.textContent = text;
    messagesContainer.appendChild(el);
    scrollToBottom();
  }

  function scrollToBottom() {
    setTimeout(() => {
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }, 50);
  }
})();
`;

// ─── Dashboard HTML (inlined) ─────────────────────────────────

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Chat Dashboard — Bahamas Adventure Guides</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f5f0; color: #1a1a1a; }
  .login-page { display: flex; align-items: center; justify-content: center; min-height: 100vh; background: #2d4a2d; }
  .login-box { background: #fff; padding: 40px; border-radius: 16px; box-shadow: 0 12px 48px rgba(0,0,0,0.15); width: 360px; max-width: 90vw; }
  .login-box h1 { font-size: 1.4rem; margin-bottom: 4px; }
  .login-box p { color: #666; font-size: 0.9rem; margin-bottom: 24px; }
  .login-box input { width: 100%; padding: 12px 14px; border: 1px solid #ddd; border-radius: 10px; font-size: 0.95rem; margin-bottom: 12px; outline: none; }
  .login-box input:focus { border-color: #c8a97e; }
  .login-box button { width: 100%; padding: 12px; background: #c8a97e; color: #fff; border: none; border-radius: 10px; font-size: 1rem; font-weight: 600; cursor: pointer; }
  .login-box button:hover { opacity: 0.9; }
  .login-error { color: #e74c3c; font-size: 0.85rem; margin-top: 8px; display: none; }
  .app { display: none; height: 100vh; }
  .app.authenticated { display: flex; }
  .sidebar { width: 340px; background: #fff; border-right: 1px solid #e0ddd5; display: flex; flex-direction: column; }
  .sidebar-header { padding: 16px 20px; border-bottom: 1px solid #e0ddd5; }
  .sidebar-header h2 { font-size: 1.1rem; }
  .sidebar-header p { font-size: 0.8rem; color: #888; }
  .conv-list { flex: 1; overflow-y: auto; }
  .conv-item { padding: 14px 20px; border-bottom: 1px solid #f0eee8; cursor: pointer; transition: background 0.15s; }
  .conv-item:hover { background: #f9f8f5; }
  .conv-item.active { background: #f0ede6; }
  .conv-item h4 { font-size: 0.9rem; margin-bottom: 4px; }
  .conv-item p { font-size: 0.82rem; color: #888; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .conv-item .conv-meta { font-size: 0.75rem; color: #aaa; margin-top: 4px; }
  .conv-item .unread-badge { display: inline-block; background: #c8a97e; color: #fff; font-size: 0.7rem; padding: 2px 7px; border-radius: 10px; margin-left: 6px; }
  .main-area { flex: 1; display: flex; flex-direction: column; background: #fff; }
  .chat-header { padding: 16px 24px; border-bottom: 1px solid #e0ddd5; display: flex; justify-content: space-between; align-items: center; }
  .chat-header h3 { font-size: 1rem; }
  .chat-header .visitor-info { font-size: 0.8rem; color: #888; }
  .chat-header button { background: none; border: 1px solid #ddd; border-radius: 8px; padding: 6px 14px; font-size: 0.8rem; cursor: pointer; }
  .chat-header button:hover { background: #f5f5f0; }
  .messages-area { flex: 1; overflow-y: auto; padding: 20px 24px; display: flex; flex-direction: column; gap: 10px; }
  .dash-msg { max-width: 70%; padding: 10px 14px; border-radius: 12px; font-size: 0.9rem; line-height: 1.4; }
  .dash-msg--visitor { background: #f0f0f0; align-self: flex-end; border-bottom-right-radius: 4px; }
  .dash-msg--agent { background: #c8a97e; color: #fff; align-self: flex-start; border-bottom-left-radius: 4px; }
  .dash-msg--system { align-self: center; font-size: 0.8rem; color: #888; font-style: italic; }
  .dash-msg-name { font-size: 0.7rem; opacity: 0.7; margin-bottom: 2px; }
  .dash-input-area { padding: 16px 24px; border-top: 1px solid #e0ddd5; display: flex; gap: 10px; }
  .dash-input-area textarea { flex: 1; border: 1px solid #ddd; border-radius: 10px; padding: 10px 14px; font-size: 0.9rem; resize: none; outline: none; font-family: inherit; }
  .dash-input-area textarea:focus { border-color: #c8a97e; }
  .dash-input-area button { background: #c8a97e; color: #fff; border: none; border-radius: 10px; padding: 10px 20px; cursor: pointer; font-weight: 600; }
  .dash-input-area button:disabled { opacity: 0.4; }
  .no-conv { flex: 1; display: flex; align-items: center; justify-content: center; color: #888; font-size: 0.95rem; }
  .loading { flex: 1; display: flex; align-items: center; justify-content: center; color: #888; }
  @media (max-width: 768px) {
    .sidebar { width: 100%; }
    .app { flex-direction: column; }
    .main-area { display: none; }
    .main-area.active { display: flex; height: calc(100vh - 60px); }
    .sidebar.collapsed { display: none; }
  }
</style>
</head>
<body>
<div class="login-page" id="login-page">
  <div class="login-box">
    <h1>Agent Dashboard</h1>
    <p>Sign in to reply to visitors</p>
    <input type="text" id="login-user" placeholder="Username" autocomplete="username" />
    <input type="password" id="login-pass" placeholder="Password" autocomplete="current-password" />
    <button id="login-btn">Sign In</button>
    <p class="login-error" id="login-error">Invalid credentials</p>
  </div>
</div>

<div class="app" id="app">
  <div class="sidebar" id="sidebar">
    <div class="sidebar-header">
      <h2>Conversations</h2>
      <p id="conv-count">Loading...</p>
    </div>
    <div class="conv-list" id="conv-list"></div>
  </div>
  <div class="main-area" id="main-area">
    <div class="chat-header">
      <div>
        <h3 id="chat-title">Select a conversation</h3>
        <div class="visitor-info" id="visitor-info"></div>
      </div>
      <button id="close-conv-btn" style="display:none;">Close</button>
    </div>
    <div class="messages-area" id="messages-area">
      <div class="no-conv" id="no-conv-msg">Select a conversation from the sidebar to start replying</div>
    </div>
    <div class="dash-input-area" id="dash-input" style="display:none;">
      <textarea id="dash-msg-input" placeholder="Type your reply..." rows="1"></textarea>
      <button id="dash-send-btn">Send</button>
    </div>
  </div>
</div>

<script>
(function() {
  const API = '';
  let authToken = null;
  let agentName = 'Agent';
  let conversations = [];
  let messages = [];
  let activeRoomId = null;
  let ws = null;

  // Check saved auth
  const saved = localStorage.getItem('bagh_auth');
  if (saved) {
    authToken = saved;
    checkAuth();
  }

  // ── Login ──
  document.getElementById('login-btn').addEventListener('click', login);
  document.getElementById('login-pass').addEventListener('keydown', e => { if (e.key === 'Enter') login(); });

  async function login() {
    const username = document.getElementById('login-user').value;
    const password = document.getElementById('login-pass').value;
    try {
      const resp = await fetch(API + '/api/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      if (!resp.ok) { document.getElementById('login-error').style.display = 'block'; return; }
      const data = await resp.json();
      authToken = btoa(username + ':' + password); // fallback token
      localStorage.setItem('bagh_auth', authToken);
      agentName = data.agent?.name || 'Agent';
      document.getElementById('login-page').style.display = 'none';
      document.getElementById('app').classList.add('authenticated');
      loadConversations();
    } catch { document.getElementById('login-error').style.display = 'block'; }
  }

  async function checkAuth() {
    try {
      const resp = await fetch(API + '/api/check-auth', { headers: { 'Authorization': 'Bearer ' + authToken } });
      if (resp.ok) {
        document.getElementById('login-page').style.display = 'none';
        document.getElementById('app').classList.add('authenticated');
        loadConversations();
      } else {
        localStorage.removeItem('bagh_auth');
      }
    } catch { localStorage.removeItem('bagh_auth'); }
  }

  function getAuthHeaders() {
    const h = {};
    if (authToken) h['Authorization'] = 'Bearer ' + authToken;
    return h;
  }

  // ── Conversations ──
  async function loadConversations() {
    try {
      const resp = await fetch(API + '/api/conversations', { headers: getAuthHeaders() });
      const data = await resp.json();
      conversations = data.conversations || [];
      renderConversations();
      document.getElementById('conv-count').textContent = conversations.length + ' conversation' + (conversations.length !== 1 ? 's' : '');
    } catch {}
    setTimeout(loadConversations, 5000); // Poll every 5s
  }

  function renderConversations() {
    const list = document.getElementById('conv-list');
    list.innerHTML = '';
    for (const conv of conversations) {
      const item = document.createElement('div');
      item.className = 'conv-item' + (conv.room_id === activeRoomId ? ' active' : '');
      item.innerHTML = \`
        <h4>\${conv.visitor_name || 'Anonymous'}\${conv.unread_agent > 0 ? '<span class="unread-badge">\${conv.unread_agent}</span>' : ''}</h4>
        <p>\${conv.last_message_preview || 'No messages yet'}</p>
        <div class="conv-meta">\${conv.status} · \${conv.last_message_at ? new Date(conv.last_message_at + 'Z').toLocaleString() : 'just now'}</div>
      \`;
      item.addEventListener('click', () => selectConversation(conv.room_id));
      list.appendChild(item);
    }
  }

  // ── Active conversation ──
  async function selectConversation(roomId) {
    activeRoomId = roomId;
    renderConversations();
    document.getElementById('no-conv-msg').style.display = 'none';
    document.getElementById('dash-input').style.display = 'flex';
    document.getElementById('close-conv-btn').style.display = 'inline-block';
    
    const conv = conversations.find(c => c.room_id === roomId);
    document.getElementById('chat-title').textContent = conv?.visitor_name || 'Anonymous';
    document.getElementById('visitor-info').textContent = conv?.visitor_email || 'No email';

    // Connect WebSocket
    connectAgentWebSocket(roomId);

    // Clear unread
    conv.unread_agent = 0;
  }

  function connectAgentWebSocket(roomId) {
    if (ws) { ws.close(); ws = null; }
    
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = API ? \`\${protocol}//\${location.host}\${API}/api/ws/\${roomId}\`
                     : \`\${protocol}//\${location.host}/api/ws/\${roomId}\`;

    ws = new WebSocket(wsUrl);
    
    ws.onopen = () => {
      // Identify as agent
      ws.send(JSON.stringify({ type: 'set_name', name: agentName }));
    };

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === 'history') {
        messages = data.messages || [];
        renderMessages();
      } else if (data.type === 'message') {
        if (!messages.find(m => m.id === data.id)) {
          messages.push({
            id: data.id, sender_role: data.sender_role,
            sender_name: data.sender_name, content: data.content,
            created_at: data.created_at,
          });
          renderMessages();
        }
      }
    };

    ws.onclose = () => { ws = null; };
  }

  function renderMessages() {
    const area = document.getElementById('messages-area');
    area.innerHTML = '';
    for (const m of messages) {
      const el = document.createElement('div');
      el.className = 'dash-msg dash-msg--' + (m.sender_role === 'agent' ? 'agent' : 'visitor');
      if (m.sender_name) {
        const name = document.createElement('div');
        name.className = 'dash-msg-name';
        name.textContent = m.sender_role === 'agent' ? m.sender_name : m.sender_name || 'Visitor';
        el.appendChild(name);
      }
      const text = document.createElement('div');
      text.textContent = m.content;
      el.appendChild(text);
      area.appendChild(el);
    }
    area.scrollTop = area.scrollHeight;
  }

  // ── Send reply ──
  const sendBtn = document.getElementById('dash-send-btn');
  const input = document.getElementById('dash-msg-input');

  function sendReply() {
    const text = input.value.trim();
    if (!text || !ws) return;
    ws.send(JSON.stringify({ type: 'message', content: text }));
    input.value = '';
  }

  sendBtn.addEventListener('click', sendReply);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendReply(); }
  });

  // ── Close conversation ──
  document.getElementById('close-conv-btn').addEventListener('click', async () => {
    if (!activeRoomId) return;
    try {
      await fetch(API + '/api/close', {
        method: 'POST', headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ room_id: activeRoomId }),
      });
      if (ws) { ws.close(); ws = null; }
      activeRoomId = null;
      messages = [];
      document.getElementById('no-conv-msg').style.display = 'flex';
      document.getElementById('dash-input').style.display = 'none';
      document.getElementById('close-conv-btn').style.display = 'none';
      document.getElementById('chat-title').textContent = 'Select a conversation';
      document.getElementById('visitor-info').textContent = '';
    } catch {}
  });

  // Auto-resize textarea
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  });
})();
</script>
</body>
</html>`;
