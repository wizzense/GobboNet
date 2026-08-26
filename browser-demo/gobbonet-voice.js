/* GobboNet awvoice mod — speech for the GobboNet page, from YOUR AitherOS
 * gateway (self-serve: the voice runs on the user's own box, never a vendor).
 *
 * Install (upstream Extensions panel, add by URL):
 *   https://aitherium.com/gobbonet/gobbonet-voice.js
 *
 * WHAT IT DOES. A floating panel that speaks text with the fleet's TTS
 * (synthesize_speech_b64 through the local MCP gateway at 127.0.0.1:8182)
 * and plays the audio in-page. The text comes from the panel's box, or the
 * page selection when the panel opens, so no upstream DOM knowledge is
 * assumed.
 *
 * NETWORK. This mod DOES dial out — to the user's OWN local gateway on
 * loopback, exactly like the Bonsai adapter. That is deliberate and honest:
 * the image-renderer mod's zero-network rule exists to protect GobboNet's
 * local-first promise; this mod is the bridge, not the renderer. The
 * visitor authorises it once (the SAME approval the adapter uses, the same
 * localStorage token key) and can revoke it on portal.aitherium.com.
 *
 * SHARED CREDENTIAL. It reads `aitheros-gateway-token` — the adapter's key.
 * One approval serves both; a visitor who already signed in for chat gets
 * voice with no second prompt.
 */
(function () {
  'use strict';
  if (window.__AITHER_VOICE_MOD__) return;
  window.__AITHER_VOICE_MOD__ = { version: '1.0.0' };

  var GATEWAY_BASES = ['http://127.0.0.1:8182']; // 127.0.0.1, never localhost
  var TOKEN_KEY = 'aitheros-gateway-token';
  var MCP_ACCEPT = 'application/json, text/event-stream';
  var session = null; // { base, id }

  function readToken() {
    try {
      var raw = window.localStorage.getItem(TOKEN_KEY);
      if (!raw) return null;
      var v = JSON.parse(raw);
      if (!v || !v.access_token) return null;
      if (v.expires_at && Date.now() > v.expires_at) return null;
      return v.access_token;
    } catch (e) { return null; }
  }

  function httpJson(url, opts) {
    return fetch(url, opts).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json().catch(function () { return {}; });
    });
  }

  function findGateway() {
    var probes = GATEWAY_BASES.map(function (base) {
      return httpJson(base + '/health', { method: 'GET' })
        .then(function () { return base; })
        .catch(function () { return null; });
    });
    return Promise.all(probes).then(function (results) {
      return results.find(Boolean) || null;
    });
  }

  function ensureSession(base) {
    if (session && session.base === base) return Promise.resolve(session);
    var token = readToken();
    if (!token) return Promise.reject(new Error('not signed in'));
    var headers = {
      'Content-Type': 'application/json',
      Accept: MCP_ACCEPT,
      Authorization: 'Bearer ' + token,
    };
    var init = {
      jsonrpc: '2.0', id: '1', method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'gobbonet-voice-mod', version: '1.0.0' },
      },
    };
    return fetch(base + '/mcp', { method: 'POST', headers: headers, body: JSON.stringify(init) })
      .then(function (r) {
        if (!r.ok) throw new Error('gateway refused (' + r.status + ')');
        var id = r.headers.get('Mcp-Session-Id') || r.headers.get('mcp-session-id');
        return r.json().then(function (body) {
          session = { base: base, id: id };
          return session;
        });
      });
  }

  function callTool(tool, args) {
    return ensureSession(session ? session.base : GATEWAY_BASES[0]).then(function (s) {
      var headers = {
        'Content-Type': 'application/json',
        Accept: MCP_ACCEPT,
        Authorization: 'Bearer ' + readToken(),
      };
      if (s.id) headers['Mcp-Session-Id'] = s.id;
      var body = { jsonrpc: '2.0', id: String(Date.now()), method: 'tools/call', params: { name: tool, arguments: args } };
      return fetch(s.base + '/mcp', { method: 'POST', headers: headers, body: JSON.stringify(body) })
        .then(function (r) { return r.json(); })
        .then(function (msg) {
          if (msg.error) throw new Error(msg.error.message || 'tool error');
          var content = msg.result && msg.result.content;
          var text = Array.isArray(content)
            ? content.map(function (c) { return c.text || ''; }).join('\n')
            : JSON.stringify(msg.result || {});
          return text;
        });
    });
  }

  function synthesize(text, voice) {
    return callTool('synthesize_speech_b64', { text: text, voice: voice }).then(function (raw) {
      return JSON.parse(raw);
    });
  }

  function setStatus(el, text) { el.textContent = text; }

  function buildPanel() {
    var panel = document.createElement('div');
    panel.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:2147483000;' +
      'width:290px;background:#14141c;border:1px solid #2a2a3a;border-radius:12px;' +
      'padding:14px;font:13px/1.45 system-ui,sans-serif;color:#d8d8e8;' +
      'box-shadow:0 8px 30px rgba(0,0,0,.5);';
    var head = document.createElement('div');
    head.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;';
    var title = document.createElement('span');
    title.textContent = 'Speak (awvoice)';
    title.style.cssText = 'font-weight:600;color:#5eead4;';
    var close = document.createElement('button');
    close.textContent = '×';
    close.style.cssText = 'background:none;border:none;color:#8a8aa0;font-size:16px;cursor:pointer;';
    close.onclick = function () { panel.remove(); };
    head.appendChild(title);
    head.appendChild(close);
    panel.appendChild(head);

    var box = document.createElement('textarea');
    box.placeholder = 'Text to speak… (selection is pre-filled)';
    box.rows = 3;
    box.style.cssText = 'width:100%;box-sizing:border-box;background:#0e0e16;border:1px solid #2a2a3a;' +
      'border-radius:8px;color:#e8e8f0;padding:8px;font:inherit;resize:vertical;';
    var sel = '';
    try { sel = window.getSelection().toString().slice(0, 4000); } catch (e) { /* no selection */ }
    if (sel) box.value = sel;
    panel.appendChild(box);

    var row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;margin-top:8px;align-items:center;';
    var voice = document.createElement('select');
    ['nova', 'alloy', 'echo', 'fable', 'onyx', 'shimmer'].forEach(function (v) {
      var o = document.createElement('option');
      o.value = v;
      o.textContent = v;
      voice.appendChild(o);
    });
    voice.style.cssText = 'flex:1;background:#0e0e16;border:1px solid #2a2a3a;color:#e8e8f0;' +
      'border-radius:8px;padding:6px;font:inherit;';
    var speak = document.createElement('button');
    speak.textContent = 'Speak';
    speak.style.cssText = 'background:#134e4a;border:none;color:#5eead4;border-radius:8px;' +
      'padding:6px 14px;font:inherit;font-weight:600;cursor:pointer;';
    row.appendChild(voice);
    row.appendChild(speak);
    panel.appendChild(row);

    var status = document.createElement('div');
    status.style.cssText = 'margin-top:8px;color:#8a8aa0;font-size:12px;min-height:15px;';
    panel.appendChild(status);

    speak.onclick = function () {
      var text = box.value.trim();
      if (!text) { setStatus(status, 'Nothing to speak.'); return; }
      speak.disabled = true;
      setStatus(status, 'Synthesising…');
      findGateway().then(function (base) {
        if (!base) throw new Error('no local gateway on 127.0.0.1:8182');
        if (!session) session = { base: base, id: null };
        if (!readToken()) throw new Error('sign in with the Bonsai adapter first (one approval covers both)');
        return synthesize(text, voice.value);
      }).then(function (res) {
        if (!res.success) throw new Error(res.error || 'synthesis failed');
        var uri = 'data:audio/' + (res.format || 'mp3') + ';base64,' + res.audio_base64;
        var audio = new Audio(uri);
        audio.play().catch(function () { throw new Error('playback blocked by the browser'); });
        setStatus(status, 'Playing…');
      }).catch(function (e) {
        setStatus(status, 'Error: ' + (e && e.message || e));
      }).then(function () { speak.disabled = false; });
    };

    document.body.appendChild(panel);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', buildPanel);
  } else {
    buildPanel();
  }
})();
