
(function() {
  'use strict';
  try {

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

  var statusDot;
  var statusText;

  function setOnline(online) {
    if (!statusDot || !statusText) return;
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
    '.bagh-loading { display: flex; align-items: center; justify-content: center; flex: 1; color: #888; font-size: 0.9rem; } .bagh-loading::after { content: ""; width: 16px; height: 16px; margin-left: 8px; border: 2px solid #ddd; border-top-color: #075f74; border-radius: 50%; animation: bagh-spin 0.6s linear infinite; } @keyframes bagh-spin { to { transform: rotate(360deg); } }',
    '@media (max-width: 480px) { #bagh-chat-panel { width: 100vw; height: 100vh; bottom: 0; right: 0; border-radius: 0; max-height: none; } #bagh-chat-btn { bottom: 16px; right: 16px; width: 54px; height: 54px; } }'
  ].join(' ');
  document.head.appendChild(style);

  const chat = document.createElement('div');
  chat.id = 'bagh-chat';
  chat.innerHTML = [
    '<button id="bagh-chat-btn" aria-label="Chat"><svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/></svg></button>',
    '<div id="bagh-chat-panel">',
    '<div class="bagh-hdr"><h3>Bahamas Adventure Guides</h3><p>Ask us anything</p><div class="bagh-status" id="bagh-status"><span class="bagh-dot bagh-dot--offline" id="bagh-dot"></span><span id="bagh-status-text">Loading...</span></div><button class="bagh-close" id="bagh-close">&times;</button></div>',
    '<div id="bagh-form" class="bagh-form"><h3>Start chatting</h3><p>Leave your name and we\'ll be right with you.</p><input type="text" id="bagh-name" placeholder="Your name" maxlength="100" /><button id="bagh-start">Start Chat</button></div>',
    '<div id="bagh-loading" class="bagh-loading" style="display:none">Connecting...</div>',
    '<div id="bagh-chat-view" style="display:none;flex-direction:column;flex:1"><div class="bagh-msgs" id="bagh-msgs"></div><div class="bagh-input"><button class="bagh-ico-btn" id="bagh-file-btn" title="Attach file">File</button><textarea id="bagh-input" placeholder="Type..." rows="1"></textarea><button class="bagh-ico-btn" id="bagh-loc-btn" title="Share location">Map</button><button id="bagh-send">Send</button></div></div>',
    '</div>'
  ].join('');
  document.body.appendChild(chat);

  statusDot = document.getElementById('bagh-dot');
  statusText = document.getElementById('bagh-status-text');
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
    const coordMatch = text.match(/(-?d+.?d*),s*(-?d+.?d*)/);
    if (coordMatch) {
      const lat = parseFloat(coordMatch[1]);
      const lng = parseFloat(coordMatch[2]);
      if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
        return { lat, lng };
      }
    }
    // Pattern: /location place name - geocode via Nominatim
    const locCmd = text.match(/\/location\s+(.+)/i);
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
    const coordMatch = place.match(/(-?d+.?d*),s*(-?d+.?d*)/);
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
  } catch(e) {
    document.body.innerHTML += '<div style="position:fixed;top:0;left:0;right:0;background:red;color:#fff;padding:10px;z-index:99999;text-align:center;">Chat error: ' + e.message + '</div>';
  }
})();
