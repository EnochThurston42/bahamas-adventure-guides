

// Error logging
window.baghLog = function(msg, data) {
  try {
    var errData = { msg: msg, time: new Date().toISOString() };
    if (data) errData.data = data;
    console.error('[BAGH]', msg, data || '');
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/api/error-log', true);
      x.setRequestHeader('Content-Type', 'application/json');
      x.send(JSON.stringify(errData));
    } catch(e) {}
  } catch(e) {}
};
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

  var statusDot;
  var statusText;

  function setOnline(online) {
    if (!statusDot || !statusText) return;
    statusDot.className = 'bagh-dot' + (online ? '' : ' bagh-dot--offline');
    statusText.textContent = online ? "Available now" : "We will reply soon";
  }

  const style = document.createElement('style');
  style.textContent = [
    '#bagh-chat * { box-sizing: border-box; }',
    '#bagh-chat { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }',
    '#bagh-chat-btn { position:fixed;bottom:24px;right:24px;z-index:9999;width:64px;height:64px;border-radius:50%;background:linear-gradient(135deg,#075f74,#0d2538);color:#fff;border:none;cursor:pointer;box-shadow:0 8px 32px rgba(7,95,116,0.3);display:flex;align-items:center;justify-content:center;transition:all 0.25s cubic-bezier(0.4,0,0.2,1); }',
    '#bagh-chat-btn:hover { transform:scale(1.1);box-shadow:0 12px 40px rgba(7,95,116,0.4); }',
    '#bagh-chat-btn svg { width:30px;height:30px;fill:currentColor; }',
    '#bagh-chat-panel { position:fixed;bottom:104px;right:24px;z-index:9998;width:380px;height:560px;max-height:calc(100vh - 140px);background:#fff;border-radius:20px;box-shadow:0 20px 60px rgba(0,0,0,0.15);display:none;flex-direction:column;overflow:hidden;animation:bagh-up 0.3s cubic-bezier(0.4,0,0.2,1); }',
    '#bagh-chat-panel.open { display:flex; }',
    '@keyframes bagh-up { from{opacity:0;transform:translateY(24px) scale(0.95);} to{opacity:1;transform:translateY(0) scale(1);} }',
    '.bagh-hdr { background:linear-gradient(135deg,#075f74,#0a8aa8);color:#fff;padding:20px 24px;position:relative; }',
    '.bagh-hdr h3 { margin:0;font-size:1.05rem;font-weight:600;letter-spacing:-0.01em; }',
    '.bagh-hdr p { margin:6px 0 0;font-size:0.82rem;opacity:0.85; }',
    '.bagh-status { display:flex;align-items:center;gap:8px;margin-top:8px;font-size:0.78rem; }',
    '.bagh-dot { width:9px;height:9px;border-radius:50%;background:#4caf50;display:inline-block;box-shadow:0 0 0 2px rgba(76,175,80,0.2); }',
    '.bagh-dot--offline { background:#bbb;box-shadow:none; }',
    '.bagh-close { position:absolute;top:16px;right:20px;background:none;border:none;color:#fff;font-size:1.4rem;cursor:pointer;opacity:0.7;transition:opacity 0.2s; }',
    '.bagh-close:hover { opacity:1; }',
    '.bagh-msgs { flex:1;min-height:0;height:0;overflow-y:scroll;padding:20px;display:flex;flex-direction:column;gap:12px;background:#f9f8f5;scrollbar-width:thin;scrollbar-color:#0a8aa8 #e8e4de; }',
    '.bagh-msgs::-webkit-scrollbar { width:10px; }',
    '.bagh-msgs::-webkit-scrollbar-track { background:#e8e4de;border-radius:6px; }',
    '.bagh-msgs::-webkit-scrollbar-thumb { background:#0a8aa8;border-radius:6px;border:2px solid #e8e4de; }',
    '.bagh-msgs::-webkit-scrollbar-thumb:hover { background:#0d2538; }',
    '.bagh-msg-group { display:flex;flex-direction:column;gap:3px;margin-bottom:8px; }',
    '.bagh-msg-group--visitor { align-items:flex-start; }',
    '.bagh-msg-group--agent { align-items:flex-end; }',
    '.bagh-group-time { font-size:0.65rem;color:#999;padding:0 4px 2px; }',
    '.bagh-msg { max-width:82%;padding:10px 16px;border-radius:14px;font-size:0.9rem;line-height:1.5;word-wrap:break-word;position:relative; }',
    '.bagh-msg--visitor { background:#fff;color:#1a1a1a;align-self:flex-start;border-bottom-left-radius:4px;box-shadow:0 1px 3px rgba(0,0,0,0.06); }',
    '.bagh-msg--agent { background:linear-gradient(135deg,#075f74,#0a8aa8);color:#fff;align-self:flex-end;border-bottom-right-radius:4px;box-shadow:0 2px 8px rgba(7,95,116,0.15); }',
    '.bagh-msg--system { background:transparent;color:#999;align-self:center;font-size:0.78rem;box-shadow:none; }',
    '.bagh-input { padding:14px 16px;border-top:1px solid #e8e4de;display:flex;gap:8px;align-items:flex-end;background:#fff; }',
    '.bagh-input textarea { flex:1;border:1.5px solid #e0ddd5;border-radius:12px;padding:12px 16px;font-size:0.9rem;resize:none;outline:none;font-family:inherit;background:#fbf8f2;transition:border-color 0.2s; }',
    '.bagh-input textarea:focus { border-color:#0a8aa8;background:#fff; }',
    '.bagh-input button { background:linear-gradient(135deg,#075f74,#0a8aa8);color:#fff;border:none;border-radius:12px;padding:12px 20px;cursor:pointer;font-weight:600;font-size:0.85rem;transition:all 0.2s;box-shadow:0 2px 8px rgba(7,95,116,0.2); }',
    '.bagh-input button:hover { transform:translateY(-1px);box-shadow:0 4px 12px rgba(7,95,116,0.3); }',
    '.bagh-ico-btn { background:none;border:1.5px solid #e0ddd5;border-radius:10px;padding:8px;cursor:pointer;color:#999;font-size:0.85rem;font-weight:600;display:flex;align-items:center;flex-shrink:0;transition:all 0.2s; }',
    '.bagh-ico-btn:hover { background:#f5f5f0;color:#555;border-color:#ccc; }',
    '.bagh-img { max-width:100%;border-radius:10px;margin-top:6px;display:block; }',
    '.bagh-file-link { display:block;font-size:0.82rem;color:#0a8aa8;text-decoration:underline;margin-top:6px; }',
    '.bagh-map-wrap { margin-top:6px;border-radius:10px;overflow:hidden;border:1px solid #e0ddd5; }',
    '.bagh-map-wrap iframe { width:100%;height:200px;border:0;display:block; }',
    '.bagh-form { padding:32px 24px;display:flex;flex-direction:column;gap:12px;flex:1;justify-content:center; }',
    '.bagh-form h3 { margin:0;font-size:1.1rem;color:#0d2538; }',
    '.bagh-form p { margin:0 0 12px;color:#666;font-size:0.88rem;line-height:1.5; }',
    '.bagh-form input { padding:12px 16px;border:1.5px solid #e0ddd5;border-radius:12px;font-size:0.92rem;outline:none;background:#fbf8f2;transition:border-color 0.2s; }',
    '.bagh-form input:focus { border-color:#0a8aa8;background:#fff; }',
    '.bagh-form button { background:linear-gradient(135deg,#075f74,#0a8aa8);color:#fff;border:none;border-radius:12px;padding:14px;cursor:pointer;font-weight:600;font-size:0.95rem;box-shadow:0 2px 8px rgba(7,95,116,0.2);transition:all 0.2s; }',
    '.bagh-form button:hover { transform:translateY(-1px);box-shadow:0 4px 12px rgba(7,95,116,0.3); }',
    '.bagh-loading { display:flex;align-items:center;justify-content:center;flex:1;color:#888;font-size:0.92rem; }',
    '@media (max-width:480px) { #bagh-chat-panel { width:100vw;height:100vh;bottom:0;right:0;border-radius:0;max-height:none; } #bagh-chat-btn { bottom:16px;right:16px;width:56px;height:56px; } .bagh-form { padding:40px 20px; } }'
  ].join(' ');
  document.head.appendChild(style);

  const chat = document.createElement('div');
  chat.id = 'bagh-chat';
  chat.innerHTML = [
    '<button id="bagh-chat-btn" aria-label="Chat"><svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/></svg></button>',
    '<div id="bagh-chat-panel">',
    '<div class="bagh-hdr"><h3>Bahamas Adventure Guides</h3><p>Ask us anything</p><div class="bagh-status" id="bagh-status"><span class="bagh-dot bagh-dot--offline" id="bagh-dot"></span><span id="bagh-status-text">Reply within minutes</span></div><button id="bagh-clear-btn" style="background:rgba(255,255,255,0.12);border:1px solid rgba(255,255,255,0.2);color:#fff;font-size:0.72rem;cursor:pointer;position:absolute;top:18px;right:52px;padding:4px 10px;border-radius:6px;">Clear</button><button class="bagh-close" id="bagh-close">&times;</button></div>',
    '<div id="bagh-form" class="bagh-form"><h3>Start planning your trip</h3><p>We need your details to help plan the perfect experience.</p><input type="text" id="bagh-first" placeholder="First name" maxlength="50"><input type="text" id="bagh-last" placeholder="Last name" maxlength="50"><input type="email" id="bagh-email" placeholder="Email" maxlength="200"><input type="tel" id="bagh-phone" placeholder="Phone" maxlength="20"><input type="number" id="bagh-age" placeholder="Age" min="1" max="150"><button id="bagh-start">Start Chat</button></div>',
    '<div id="bagh-loading" class="bagh-loading" style="display:none">Connecting...</div>',
    '<div id="bagh-chat-view" style="display:none;flex-direction:column;flex:1"><div class="bagh-msgs" id="bagh-msgs"></div><div class="bagh-input"><button class="bagh-ico-btn" id="bagh-file-btn" title="Attach file">File</button><textarea id="bagh-input" placeholder="Type..." rows="1"></textarea><button class="bagh-ico-btn" id="bagh-loc-btn" title="Share location">Map</button><button id="bagh-send">Send</button></div></div>',
    '</div>'
  ].join('');
  document.body.appendChild(chat);

  statusDot = document.getElementById('bagh-dot');
  statusText = document.getElementById('bagh-status-text');
  setOnline(false);
  const btn = document.getElementById('bagh-chat-btn');
  const panel = document.getElementById('bagh-chat-panel');
  const form = document.getElementById('bagh-form');
  const loading = document.getElementById('bagh-loading');
  const chatView = document.getElementById('bagh-chat-view');
  const msgs = document.getElementById('bagh-msgs');
  const input = document.getElementById('bagh-input');
  const sendBtn = document.getElementById('bagh-send');
  const startBtn = document.getElementById('bagh-start');
  const firstInput = document.getElementById('bagh-first');
  const lastInput = document.getElementById('bagh-last');
  const emailInput = document.getElementById('bagh-email');
  const phoneInput = document.getElementById('bagh-phone');
  const ageInput = document.getElementById('bagh-age');
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

  // Clear chat
  document.getElementById('bagh-clear-btn').onclick = function() {
    localStorage.removeItem(ROOM_META_KEY);
    state.roomId = null;
    state.messages = [];
    state.visitorName = '';
    state.visitorEmail = '';
    state.visitorPhone = '';
    state.visitorAge = '';
    state.connected = false;
    if (state.ws) { try { state.ws.close(); } catch(e) {} state.ws = null; }
    if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
    // Clear form fields
    if (firstInput) firstInput.value = '';
    if (lastInput) lastInput.value = '';
    if (emailInput) emailInput.value = '';
    if (phoneInput) phoneInput.value = '';
    if (ageInput) ageInput.value = '';
    form.style.display = 'flex';
    loading.style.display = 'none';
    chatView.style.display = 'none';
    // Focus first field
    if (firstInput) setTimeout(function() { firstInput.focus(); }, 100);
  };

  

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

  function formatTime(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) {
      var t = new Date();
      var parts = iso.split(':'); 
      if (parts.length >= 2) {
        t.setHours(parseInt(parts[0]) || 0);
        t.setMinutes(parseInt(parts[1]) || 0);
      }
      d = t;
    }
    var h = d.getHours(), m = d.getMinutes();
    var ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return h + ':' + (m < 10 ? '0' : '') + m + ' ' + ampm;
  }

  function renderMsgs() {
    msgs.innerHTML = '';
    for (const m of state.messages) {
      var isVis = m.sender_role === 'visitor';
      var name = m.sender_name || (isVis ? 'You' : 'Agent');

      // Sender name
      if (name && name !== 'system') {
        var nm = document.createElement('div');
        nm.textContent = name;
        nm.style.cssText = 'font-size:0.72rem;opacity:0.6;margin-bottom:3px;padding:0 4px;';
        nm.style.textAlign = isVis ? 'left' : 'right';
        msgs.appendChild(nm);
      }

      var el = document.createElement('div');
      el.className = 'bagh-msg bagh-msg--' + (isVis ? 'visitor' : 'agent');

      // Message content
      var clean = m.content;
      // Strip coordinate patterns from display if a map will be shown
      var hasCoord = /(-?\d+\.?\d*),\s*(-?\d+\.?\d*)/.test(clean);
      if (hasCoord) {
        clean = clean.replace(/(-?\d+\.?\d*),\s*(-?\d+\.?\d*)/, '');
        clean = clean.replace(/[:,]\s*$/, '').trim() || 'Shared a location';
      }
      
      var textEl = document.createElement('div');
      textEl.textContent = clean;
      el.appendChild(textEl);

      // Timestamp
      var tm = m.created_at || '';
      if (tm) {
        var timeEl = document.createElement('div');
        timeEl.textContent = formatTime(tm);
        timeEl.style.cssText = 'font-size:0.65rem;opacity:0.5;margin-top:4px;text-align:right;';
        el.appendChild(timeEl);
      }

      // Location map - proper interactive map using OpenStreetMap + Leaflet
      var loc = extractLocation(m.content);
      if (loc && loc.lat) {
        var mapWrap = document.createElement('div');
        mapWrap.style.cssText = 'margin-top:8px;border-radius:10px;overflow:hidden;border:1px solid #e0ddd5;';
        
        // Map pin icon and place name
        var mapBtn = document.createElement('div');
        mapBtn.style.cssText = 'background:#fff;padding:8px 10px;border-bottom:1px solid #e0ddd5;cursor:pointer;display:flex;align-items:center;gap:6px;transition:background 0.15s;';
        mapBtn.onclick = function() { window.open('https://maps.google.com/maps?daddr=' + loc.lat + ',' + loc.lng, '_blank'); };
        var pinSpan = document.createElement('span');
        pinSpan.textContent = 'Loc';
        pinSpan.style.cssText = 'font-size:0.7rem;font-weight:700;color:#075f74;background:#e8f4f8;padding:2px 6px;border-radius:4px;';
        var labelSpan = document.createElement('span');
        labelSpan.textContent = m.content.replace(/(-?\d+\.?\d*),\s*(-?\d+\.?\d*)/, '').trim() || 'View on Google Maps';
        labelSpan.style.cssText = 'font-size:0.82rem;color:#075f74;font-weight:600;flex:1;';
        mapBtn.appendChild(pinSpan);
        mapBtn.appendChild(labelSpan);
        mapWrap.appendChild(mapBtn);
        
        var iframe = document.createElement('iframe');
        iframe.src = 'https://www.openstreetmap.org/export/embed.html?bbox=' + (loc.lng - 0.01) + ',' + (loc.lat - 0.01) + ',' + (loc.lng + 0.01) + ',' + (loc.lat + 0.01) + '&layer=mapnik&marker=' + loc.lat + ',' + loc.lng;
        iframe.style.cssText = 'width:100%;height:200px;border:0;display:block;';
        iframe.loading = 'lazy';
        mapWrap.appendChild(iframe);
        
        el.appendChild(mapWrap);
      }

      // File preview
      if (m.file_url) {
        if (m.file_type && m.file_type.startsWith('image/')) {
          var img = document.createElement('img');
          img.className = 'bagh-img';
          img.src = m.file_url;
          img.alt = m.file_name || 'Image';
          img.loading = 'lazy';
          el.appendChild(img);
        } else {
          var link = document.createElement('a');
          link.className = 'bagh-file-link';
          link.href = m.file_url;
          link.target = '_blank';
          link.textContent = m.file_name || 'View file';
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
    if (!state.roomId) return;
    // Try GPS first
    if (navigator.geolocation) {
      addMsg('system', '', 'Getting your GPS location...');
      navigator.geolocation.getCurrentPosition(async function(pos) {
        var lat = pos.coords.latitude;
        var lng = pos.coords.longitude;
        try {
          var rev = await fetch('https://nominatim.openstreetmap.org/reverse?format=json&lat=' + lat + '&lon=' + lng + '&zoom=14', {
            headers: { 'User-Agent': 'BahamasAdventureGuides/1.0' }
          });
          var geo = await rev.json();
          var placeName = (geo && geo.display_name) ? geo.display_name.split(',')[0] : 'Shared Location';
          state.messages = state.messages.filter(function(m) { return m.content !== 'Getting your GPS location...'; });
          input.value = placeName + ': ' + lat + ',' + lng;
          sendMessage();
        } catch(e) {
          state.messages = state.messages.filter(function(m) { return m.content !== 'Getting your GPS location...'; });
          input.value = lat + ',' + lng;
          sendMessage();
        }
      }, function(err) {
        state.messages = state.messages.filter(function(m) { return m.content !== 'Getting your GPS location...'; });
        var place = prompt('Enter a place name or coordinates to share:');
        if (!place) return;
        var coordMatch = place.match(/(-?\d+\.?\d*),\s*(-?\d+\.?\d*)/);
        if (coordMatch) {
          input.value = coordMatch[1] + ',' + coordMatch[2];
          sendMessage();
        } else {
          addMsg('visitor', 'You', 'Searching for ' + place + '...');
          fetch('https://nominatim.openstreetmap.org/search?format=json&q=' + encodeURIComponent(place) + '&countrycodes=bs&limit=5&viewbox=-79.0,27.5,-71.0,20.5&bounded=1', {
            headers: { 'User-Agent': 'BahamasAdventureGuides/1.0' }
          }).then(function(r) { return r.json(); }).then(function(data) {
            state.messages = state.messages.filter(function(m) { return m.content !== 'Searching for ' + place + '...'; });
            if (data && data.length > 0) {
              var lat = parseFloat(data[0].lat);
              var lng = parseFloat(data[0].lon);
              var displayName = data[0].display_name.split(',')[0];
              input.value = displayName + ': ' + lat + ',' + lng;
              sendMessage();
            } else {
              addMsg('system', '', 'Could not find that place.');
            }
          });
        }
      }, { enableHighAccuracy: true, timeout: 10000 });
    } else {
      var place = prompt('Enter a place name or coordinates to share:');
      if (!place) return;
      var coordMatch = place.match(/(-?\d+\.?\d*),\s*(-?\d+\.?\d*)/);
      if (coordMatch) {
        input.value = coordMatch[1] + ',' + coordMatch[2];
        sendMessage();
      } else {
        addMsg('visitor', 'You', 'Searching for ' + place + '...');
        fetch('https://nominatim.openstreetmap.org/search?format=json&q=' + encodeURIComponent(place) + '&countrycodes=bs&limit=5&viewbox=-79.0,27.5,-71.0,20.5&bounded=1', {
          headers: { 'User-Agent': 'BahamasAdventureGuides/1.0' }
        }).then(function(r) { return r.json(); }).then(function(data) {
          state.messages = state.messages.filter(function(m) { return m.content !== 'Searching for ' + place + '...'; });
          if (data && data.length > 0) {
            var lat = parseFloat(data[0].lat);
            var lng = parseFloat(data[0].lon);
            var displayName = data[0].display_name.split(',')[0];
            input.value = displayName + ': ' + lat + ',' + lng;
            sendMessage();
          } else {
            addMsg('system', '', 'Could not find that place.');
          }
        });
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
