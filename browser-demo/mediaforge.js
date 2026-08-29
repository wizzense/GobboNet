/* GobboNet awforge mod — media for YOUR GobboNet page, from Media Forge
 * (self-serve: the forge runs on the user's own box, never a vendor).
 *
 * Install (upstream Extensions panel, add by URL):
 *   https://aitherium.com/gobbonet/mediaforge.js
 *
 * WHAT IT DOES. A floating panel that drives the Media Forge production
 * pipeline (brief -> stages -> gates -> deliverables) from the page: make a
 * production, see its lifecycle, and read the result back in-page. The forge
 * is the user's OWN local instance at 127.0.0.1:8200 — this is the bridge
 * mod, exactly like the voice mod bridges the local MCP gateway.
 *
 * NETWORK. This mod dials the user's OWN local forge on loopback. The HOSTED
 * forge URL stays OFF unless the page explicitly sets
 * window.__AITHER_FORGE_HOSTED__ — the public demo gateway does not exist
 * until the owner approves the network exposure, and this mod will not invent
 * an endpoint. Same honesty rule as the voice mod: the bridge dials out, the
 * visitor authorises the local one by running their own forge.
 *
 * SHARED CREDENTIAL. It reads `aitheros-gateway-token` — the adapter's key —
 * so the same one-time approval covers any platform-bound call the forge
 * needs; the local forge itself requires none.
 */
(function () {
  'use strict';
  if (window.__AITHER_FORGE_MOD__) return;
  window.__AITHER_FORGE_MOD__ = { version: '1.0.0' };

  var FORGE_BASES = ['http://127.0.0.1:8200']; // 127.0.0.1, never localhost
  var HOSTED = window.__AITHER_FORGE_HOSTED__ || ''; // OFF by default: the docstring above promises the hosted forge stays off
  // unless the page opts in. A literal fallback to an internal hostname would
  // (a) ship an internal URL in the public fork and (b) contradict that
  // promise. The truthy guard at line 55 makes '' a clean 'local forge only'.
  var TOKEN_KEY = 'aitheros-gateway-token';

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
      return r.json().then(function (body) {
        if (!r.ok) throw new Error((body && body.error) || ('HTTP ' + r.status));
        return body;
      });
    });
  }

  function findForge() {
    var bases = FORGE_BASES.slice();
    if (HOSTED) bases.unshift(HOSTED);
    return Promise.all(bases.map(function (base) {
      return httpJson(base + '/api/produce/health', { method: 'GET' })
        .then(function () { return base; })
        .catch(function () { return null; });
    })).then(function (results) {
      return results.find(Boolean) || null;
    });
  }

  function authHeaders() {
    var token = readToken();
    var h = { 'Content-Type': 'application/json' };
    if (token) h.Authorization = 'Bearer ' + token;
    return h;
  }

  function makeProduction(base, project, title, brief) {
    return httpJson(base + '/api/produce/productions', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ project: project, title: title, brief: brief,
                             autonomous: false }),
    });
  }

  function listProductions(base, project) {
    return httpJson(base + '/api/produce/productions?project='
      + encodeURIComponent(project), { method: 'GET', headers: authHeaders() });
  }

  function setStatus(el, text) { el.textContent = text; }

  function renderProduction(container, p) {
    var card = document.createElement('div');
    card.style.cssText = 'border:1px solid #2a2a3a;border-radius:8px;padding:8px 10px;' +
      'margin-top:8px;background:#101018;';
    var t = document.createElement('div');
    t.style.cssText = 'font-weight:600;color:#d8d8e8;';
    t.textContent = p.title || '(untitled)';
    var meta = document.createElement('div');
    meta.style.cssText = 'color:#8a8aa0;font-size:11px;margin-top:2px;';
    meta.textContent = 'id ' + (p.id || '?') + ' — ' + (p.status || 'new')
      + ' — ' + (Array.isArray(p.stages) ? p.stages.length + ' stage(s)' : '');
    card.appendChild(t);
    card.appendChild(meta);
    if (p.brief) {
      var b = document.createElement('div');
      b.style.cssText = 'color:#a8a8c0;font-size:11px;margin-top:4px;';
      b.textContent = p.brief.slice(0, 160) + (p.brief.length > 160 ? '…' : '');
      card.appendChild(b);
    }
    container.appendChild(card);
  }

  function buildPanel() {
    var panel = document.createElement('div');
    panel.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:2147483000;' +
      'width:290px;background:#14141c;border:1px solid #2a2a3a;border-radius:12px;' +
      'padding:14px;font:13px/1.45 system-ui,sans-serif;color:#d8d8e8;' +
      'box-shadow:0 8px 30px rgba(0,0,0,.5);';
    var head = document.createElement('div');
    head.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;';
    var title = document.createElement('span');
    title.textContent = 'Forge (awforge)';
    title.style.cssText = 'font-weight:600;color:#fbbf24;';
    var close = document.createElement('button');
    close.textContent = '×';
    close.style.cssText = 'background:none;border:none;color:#8a8aa0;font-size:16px;cursor:pointer;';
    close.onclick = function () { panel.remove(); };
    head.appendChild(title);
    head.appendChild(close);
    panel.appendChild(head);

    var status = document.createElement('div');
    status.style.cssText = 'color:#8a8aa0;font-size:11px;margin-bottom:10px;';
    panel.appendChild(status);

    var form = document.createElement('div');
    function field(ph, rows) {
      var el = document.createElement(rows ? 'textarea' : 'input');
      el.placeholder = ph;
      el.style.cssText = 'width:100%;box-sizing:border-box;background:#101018;' +
        'border:1px solid #2a2a3a;border-radius:6px;color:#d8d8e8;padding:6px 8px;' +
        'margin-bottom:6px;font:12px system-ui,sans-serif;';
      if (rows) el.rows = rows;
      return el;
    }
    var fProject = field('project (e.g. gobbonet-demo)');
    var fTitle = field('title');
    var fBrief = field('brief — what should the forge make?', 3);
    var go = document.createElement('button');
    go.textContent = 'Make a production';
    go.style.cssText = 'width:100%;background:#fbbf24;color:#14141c;border:none;' +
      'border-radius:6px;padding:7px;font-weight:600;cursor:pointer;';
    form.appendChild(fProject);
    form.appendChild(fTitle);
    form.appendChild(fBrief);
    form.appendChild(go);
    panel.appendChild(form);

    var listBtn = document.createElement('button');
    listBtn.textContent = 'List productions';
    listBtn.style.cssText = 'width:100%;background:none;color:#8a8aa0;border:1px solid #2a2a3a;' +
      'border-radius:6px;padding:6px;margin-top:6px;cursor:pointer;';
    panel.appendChild(listBtn);

    var results = document.createElement('div');
    panel.appendChild(results);

    var base = null;
    findForge().then(function (b) {
      if (!b) {
        setStatus(status, 'Media Forge unavailable — start it on your box '
          + '(127.0.0.1:8200) or set __AITHER_FORGE_HOSTED__ on this page.');
        return;
      }
      base = b;
      setStatus(status, 'Forge: ' + b.replace(/^https?:\/\//, ''));
    });

    go.onclick = function () {
      var project = fProject.value.trim();
      var title = fTitle.value.trim();
      var brief = fBrief.value.trim();
      if (!(project && title && brief)) {
        setStatus(status, 'project, title and brief are all required');
        return;
      }
      if (!base) { setStatus(status, 'no forge reachable yet'); return; }
      setStatus(status, 'creating…');
      makeProduction(base, project, title, brief)
        .then(function (body) {
          setStatus(status, 'created');
          if (body && body.production) renderProduction(results, body.production);
        })
        .catch(function (err) {
          setStatus(status, 'failed: ' + err.message);
        });
    };

    listBtn.onclick = function () {
      var project = fProject.value.trim();
      if (!project) { setStatus(status, 'enter a project first'); return; }
      if (!base) { setStatus(status, 'no forge reachable yet'); return; }
      setStatus(status, 'listing…');
      listProductions(base, project)
        .then(function (body) {
          var items = (body && body.productions) || [];
          setStatus(status, items.length + ' production(s)');
          results.textContent = '';
          items.slice(0, 6).forEach(function (p) { renderProduction(results, p); });
        })
        .catch(function (err) {
          setStatus(status, 'failed: ' + err.message);
        });
    };

    document.body.appendChild(panel);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', buildPanel);
  } else {
    buildPanel();
  }
})();
