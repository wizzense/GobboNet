/* GobboNet awvision mod — see an image on the GobboNet page, from YOUR
 * AitherOS gateway (self-serve: the vision model runs on the user's own
 * box, never a vendor).
 *
 * Install (upstream Extensions panel, add by URL):
 *   https://aitherium.com/gobbonet/gobbonet-vision.js
 *
 * WHAT IT DOES. A floating panel: pick or paste an image, ask a question
 * (default "describe this image"), and read what the fleet's vision model
 * reports about the actual pixels — the awvision brick's promise ("you
 * check what a model actually reports about the pixels"). The image never
 * leaves the visitor's machine except to THEIR local gateway, in the call.
 *
 * NETWORK. This mod dials the user's OWN local gateway on loopback
 * (127.0.0.1:8182), exactly like the Bonsai adapter. One approval covers
 * both (shared `aitheros-gateway-token` localStorage key); revoke on
 * portal.aitherium.com.
 */
(function () {
  'use strict';
  if (window.__AITHER_VISION_MOD__) return;
  window.__AITHER_VISION_MOD__ = { version: '1.0.0' };

  var GATEWAY_BASES = ['http://127.0.0.1:8182'];
  var TOKEN_KEY = 'aitheros-gateway-token';
  var MCP_ACCEPT = 'application/json, text/event-stream';
  var session = null;

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
    return Promise.all(GATEWAY_BASES.map(function (base) {
      return httpJson(base + '/health', { method: 'GET' })
        .then(function () { return base; })
        .catch(function () { return null; });
    })).then(function (r) { return r.find(Boolean) || null; });
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
        clientInfo: { name: 'gobbonet-vision-mod', version: '1.0.0' },
      },
    };
    return fetch(base + '/mcp', { method: 'POST', headers: headers, body: JSON.stringify(init) })
      .then(function (r) {
        if (!r.ok) throw new Error('gateway refused (' + r.status + ')');
        var id = r.headers.get('Mcp-Session-Id') || r.headers.get('mcp-session-id');
        return r.json().then(function () {
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
          return Array.isArray(content)
            ? content.map(function (c) { return c.text || ''; }).join('\n')
            : JSON.stringify(msg.result || {});
        });
    });
  }

  function setStatus(el, text) { el.textContent = text; }

  function buildPanel() {
    var panel = document.createElement('div');
    panel.style.cssText = 'position:fixed;left:18px;bottom:18px;z-index:2147483000;' +
      'width:300px;background:#14141c;border:1px solid #2a2a3a;border-radius:12px;' +
      'padding:14px;font:13px/1.45 system-ui,sans-serif;color:#d8d8e8;' +
      'box-shadow:0 8px 30px rgba(0,0,0,.5);';
    var head = document.createElement('div');
    head.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;';
    var title = document.createElement('span');
    title.textContent = 'See (awvision)';
    title.style.cssText = 'font-weight:600;color:#7aa2ff;';
    var close = document.createElement('button');
    close.textContent = '×';
    close.style.cssText = 'background:none;border:none;color:#8a8aa0;font-size:16px;cursor:pointer;';
    close.onclick = function () { panel.remove(); };
    head.appendChild(title);
    head.appendChild(close);
    panel.appendChild(head);

    var file = document.createElement('input');
    file.type = 'file';
    file.accept = 'image/*';
    file.style.cssText = 'width:100%;margin-bottom:8px;color:#8a8aa0;font:inherit;';
    panel.appendChild(file);

    var preview = document.createElement('img');
    preview.style.cssText = 'display:none;max-width:100%;max-height:120px;border-radius:8px;margin-bottom:8px;';
    panel.appendChild(preview);

    var question = document.createElement('input');
    question.type = 'text';
    question.value = 'describe this image';
    question.style.cssText = 'width:100%;box-sizing:border-box;background:#0e0e16;border:1px solid #2a2a3a;' +
      'border-radius:8px;color:#e8e8f0;padding:8px;font:inherit;margin-bottom:8px;';
    panel.appendChild(question);

    var analyze = document.createElement('button');
    analyze.textContent = 'Analyze';
    analyze.style.cssText = 'width:100%;background:#1e3a5f;border:none;color:#7aa2ff;border-radius:8px;' +
      'padding:7px;font:inherit;font-weight:600;cursor:pointer;';
    panel.appendChild(analyze);

    var status = document.createElement('div');
    status.style.cssText = 'margin-top:8px;color:#8a8aa0;font-size:12px;min-height:15px;white-space:pre-wrap;';
    panel.appendChild(status);

    var current = null; // { b64, name }
    file.onchange = function () {
      var f = file.files && file.files[0];
      if (!f) return;
      var reader = new FileReader();
      reader.onload = function () {
        current = { b64: String(reader.result).split(',')[1] || String(reader.result), name: f.name };
        preview.src = reader.result;
        preview.style.display = 'block';
        setStatus(status, 'Ready.');
      };
      reader.readAsDataURL(f);
    };

    analyze.onclick = function () {
      if (!current) { setStatus(status, 'Pick an image first.'); return; }
      analyze.disabled = true;
      setStatus(status, 'Asking the vision model…');
      findGateway().then(function (base) {
        if (!base) throw new Error('no local gateway on 127.0.0.1:8182');
        if (!session) session = { base: base, id: null };
        if (!readToken()) throw new Error('sign in with the Bonsai adapter first (one approval covers both)');
        return callTool('analyze_image_b64', {
          image_b64: current.b64,
          prompt: question.value.trim() || 'describe this image',
          analysis_type: 'describe',
        });
      }).then(function (text) {
        setStatus(status, text);
      }).catch(function (e) {
        setStatus(status, 'Error: ' + (e && e.message || e));
      }).then(function () { analyze.disabled = false; });
    };

    document.body.appendChild(panel);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', buildPanel);
  } else {
    buildPanel();
  }
})();
