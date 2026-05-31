// spec-review browser UI. Talks only to the local JSON API, carrying the
// per-run token (read from the URL) on every request.

const TOKEN = new URLSearchParams(location.search).get('token') || '';

const state = {
  meta: null,
  specs: [],
  orphans: [],
  current: null, // { path, title, markdown, html, store, anchors }
  filter: 'all',
  pendingSelection: null, // { quote, blockStart }
};

const els = {
  banner: document.getElementById('banner'),
  target: document.getElementById('target'),
  specList: document.getElementById('spec-list'),
  orphanList: document.getElementById('orphan-list'),
  author: document.getElementById('author'),
  docTitle: document.getElementById('doc-title'),
  doc: document.getElementById('doc'),
  filter: document.getElementById('filter'),
  commentList: document.getElementById('comment-list'),
  composer: document.getElementById('composer'),
  composerQuote: document.getElementById('composer-quote'),
  composerBody: document.getElementById('composer-body'),
  composerSave: document.getElementById('composer-save'),
  composerCancel: document.getElementById('composer-cancel'),
};

// --- API ----------------------------------------------------------------
async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'X-Spec-Review-Token': TOKEN };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || res.statusText);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function authorName() {
  return (els.author.value || '').trim() || 'unknown';
}

// --- bootstrap ----------------------------------------------------------
async function init() {
  if (!TOKEN) {
    showBanner('Missing token in URL — reload from the link spec-review printed on startup.');
    return;
  }
  state.meta = await api('/api/meta');
  els.target.textContent = `${state.meta.target}  ·  ${state.meta.glob}`;
  els.author.value = state.meta.author || '';
  if (state.meta.readOnly) {
    showBanner('Read-only mode — comments cannot be added or changed.');
    els.author.disabled = true;
  }
  await loadSpecs();
  connectSse();

  els.filter.addEventListener('change', () => {
    state.filter = els.filter.value;
    renderComments();
  });
  els.composerCancel.addEventListener('click', closeComposer);
  els.composerSave.addEventListener('click', saveComment);
  els.doc.addEventListener('mouseup', onDocMouseUp);
}

async function loadSpecs() {
  const data = await api('/api/specs');
  state.specs = data.specs;
  state.orphans = data.orphanSidecars;
  renderSidebar();
  if (!state.current && state.specs.length) selectSpec(state.specs[0].path);
}

function renderSidebar() {
  els.specList.innerHTML = '';
  for (const s of state.specs) {
    const a = document.createElement('a');
    a.dataset.path = s.path;
    const open = Number(s.openCount || 0);
    const badge = open > 0 ? `<span class="spec-badge" title="${open} open comment${open === 1 ? '' : 's'}">${open}</span>` : '';
    a.innerHTML = `<span class="spec-title">${escapeHtml(s.title)}${badge}</span><span class="path">${escapeHtml(s.path)}</span>`;
    if (state.current && state.current.path === s.path) a.classList.add('active');
    a.addEventListener('click', () => selectSpec(s.path));
    els.specList.appendChild(a);
  }
  els.orphanList.innerHTML = '';
  if (state.orphans.length) {
    const h = document.createElement('div');
    h.className = 'muted';
    h.textContent = 'Orphaned sidecars (no matching spec):';
    els.orphanList.appendChild(h);
    for (const o of state.orphans) {
      const d = document.createElement('div');
      d.className = 'orphan';
      d.textContent = `${o.path} → ${o.expectedSpec}`;
      els.orphanList.appendChild(d);
    }
  }
}

async function selectSpec(path) {
  state.current = await api(`/api/spec?path=${encodeURIComponent(path)}`);
  els.docTitle.textContent = state.current.path;
  els.doc.innerHTML = state.current.html;
  renderSidebar();
  applyAnchors();
  renderComments();
}

// --- anchoring display --------------------------------------------------
function blockForLine(line) {
  const blocks = els.doc.querySelectorAll('[data-source-start]');
  for (const b of blocks) {
    const start = Number(b.getAttribute('data-source-start'));
    const end = Number(b.getAttribute('data-source-end'));
    if (line >= start && line < end) return b;
  }
  return null;
}

function applyAnchors() {
  // Clear ALL prior markers so a re-run (after resolve / delete / filter change)
  // never leaves stale highlights behind: unwrap old quote <mark>s and strip the
  // block markers + data-comment-id, not just the classes.
  els.doc.querySelectorAll('mark.quote-hit').forEach((m) => {
    const parent = m.parentNode;
    while (m.firstChild) parent.insertBefore(m.firstChild, m);
    parent.removeChild(m);
    parent.normalize(); // re-merge split text nodes so re-highlight can match
  });
  els.doc.querySelectorAll('.anchored-block').forEach((b) => {
    b.classList.remove('anchored-block', 'active');
    delete b.dataset.commentId;
  });
  if (!state.current) return;
  const { anchors } = state.current;
  // Highlight exactly the comments the sidebar shows — same filtered set, so the
  // body and the side panel never disagree (a hidden comment leaves no mark).
  for (const c of visibleComments()) {
    const a = anchors[c.id];
    if (!a || a.anchorState !== 'anchored' || a.line == null) continue;
    const block = blockForLine(a.line);
    if (block) {
      block.classList.add('anchored-block');
      block.dataset.commentId = c.id;
      highlightQuote(block, c.anchor && c.anchor.quote);
    }
  }
}

function highlightQuote(block, quote) {
  if (!quote) return;
  // best-effort inline highlight when the quote lives in a single text node
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const idx = node.nodeValue.indexOf(quote);
    if (idx === -1) continue;
    const range = document.createRange();
    range.setStart(node, idx);
    range.setEnd(node, idx + quote.length);
    const mark = document.createElement('mark');
    mark.className = 'quote-hit';
    try {
      range.surroundContents(mark);
    } catch {
      /* spans element boundaries — block highlight already covers it */
    }
    return;
  }
}

// --- comment selection / composer --------------------------------------
function onDocMouseUp() {
  if (state.meta.readOnly) return;
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return;
  const text = sel.toString().trim();
  if (!text) return;
  let node = sel.anchorNode;
  while (node && node !== els.doc && !(node.nodeType === 1 && node.hasAttribute('data-source-start'))) {
    node = node.parentNode;
  }
  const blockStart = node && node.getAttribute ? Number(node.getAttribute('data-source-start')) : undefined;
  state.pendingSelection = { quote: text, blockStart: Number.isInteger(blockStart) ? blockStart : undefined };
  els.composerQuote.textContent = text;
  els.composerBody.value = '';
  els.composer.hidden = false;
  els.composerBody.focus();
}

function closeComposer() {
  els.composer.hidden = true;
  state.pendingSelection = null;
}

async function saveComment() {
  const body = els.composerBody.value.trim();
  if (!body || !state.pendingSelection) return closeComposer();
  const op = {
    type: 'add-comment',
    quote: state.pendingSelection.quote,
    blockStart: state.pendingSelection.blockStart,
    body,
    author: authorName(),
  };
  try {
    await writeOp(op);
    closeComposer();
  } catch (err) {
    if (err.status === 400) showToast(`Could not anchor selection: ${err.message}. Try selecting plain prose.`);
    else showToast(err.message);
  }
}

// --- write with optimistic concurrency + retry --------------------------
async function writeOp(op) {
  const path = state.current.path;
  let rev = state.current.store.rev;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await api(`/api/review?path=${encodeURIComponent(path)}`, { method: 'POST', body: { rev, op } });
      state.current.store = res.store;
      state.current.anchors = res.anchors;
      applyAnchors();
      renderComments();
      return res;
    } catch (err) {
      if (err.status === 409 && attempt === 0) {
        rev = err.data.store ? err.data.store.rev : err.data.currentRev;
        state.current.store = err.data.store || state.current.store;
        continue; // re-fetched rev, retry once (FR-044)
      }
      throw err;
    }
  }
}

// --- comment list -------------------------------------------------------
function visibleComments() {
  if (!state.current) return [];
  const { store, anchors } = state.current;
  return store.comments.filter((c) => {
    const a = anchors[c.id];
    switch (state.filter) {
      case 'open': return c.status === 'open';
      case 'resolved': return c.status === 'resolved';
      case 'wontfix': return c.status === 'wontfix';
      case 'needs-anchor': return a && a.anchorState !== 'anchored';
      default: return true;
    }
  });
}

function renderComments() {
  if (!state.current) return;
  applyAnchors();
  const comments = visibleComments();
  const openCount = state.current.store.comments.filter((c) => c.status === 'open').length;
  els.commentList.innerHTML = '';
  const header = document.createElement('div');
  header.className = 'muted';
  header.style.padding = '0 4px 8px';
  header.textContent = `${comments.length} shown · ${openCount} open`;
  els.commentList.appendChild(header);
  for (const c of comments) els.commentList.appendChild(renderComment(c));
}

function renderComment(c) {
  const a = state.current.anchors[c.id];
  const div = document.createElement('div');
  div.className = `comment ${c.status}`;
  div.dataset.commentId = c.id;

  const anchorBadge =
    a && a.anchorState !== 'anchored'
      ? `<span class="badge anchor-${a.anchorState}">${a.anchorState}</span>`
      : '';
  div.innerHTML = `
    <div class="meta">
      <span class="badge ${c.status}">${c.status}</span>
      ${anchorBadge}
      <span>${escapeHtml(c.author)}</span>
      <span>·</span>
      <span>${fmtTime(c.createdAt)}</span>
    </div>
    <div class="quote">${escapeHtml(c.anchor ? c.anchor.quote : '')}</div>
    <div class="comment-body">${escapeHtml(c.body)}</div>
  `;

  if (Array.isArray(c.thread) && c.thread.length) {
    const thread = document.createElement('div');
    thread.className = 'thread';
    for (const r of c.thread) {
      const rep = document.createElement('div');
      rep.className = 'reply';
      rep.innerHTML = `<span class="who">${escapeHtml(r.author)} · ${fmtTime(r.createdAt)}</span><br />${escapeHtml(r.body)}`;
      thread.appendChild(rep);
    }
    div.appendChild(thread);
  }

  if (c.resolution) {
    const r = document.createElement('div');
    r.className = 'resolution';
    r.innerHTML = `<strong>${c.status} by ${escapeHtml(c.resolution.by)}</strong> · ${fmtTime(c.resolution.at)}<br />${escapeHtml(c.resolution.note)}`;
    div.appendChild(r);
  }

  if (!state.meta.readOnly) div.appendChild(renderActions(c));

  div.addEventListener('click', () => focusAnchor(c.id));
  return div;
}

function renderActions(c) {
  const wrap = document.createElement('div');
  wrap.className = 'comment-actions';
  const reply = document.createElement('input');
  reply.placeholder = 'Reply…';
  reply.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter' && reply.value.trim()) {
      await writeOp({ type: 'add-reply', id: c.id, body: reply.value.trim(), author: authorName() });
    }
  });
  wrap.appendChild(reply);

  if (c.status !== 'resolved') wrap.appendChild(statusBtn(c, 'resolved', 'Resolve'));
  if (c.status !== 'wontfix') wrap.appendChild(statusBtn(c, 'wontfix', "Won't fix"));
  if (c.status !== 'open') wrap.appendChild(statusBtn(c, 'open', 'Reopen'));
  wrap.appendChild(deleteBtn(c));
  return wrap;
}

function statusBtn(c, status, label) {
  const b = document.createElement('button');
  b.className = 'btn';
  b.textContent = label;
  b.addEventListener('click', async (e) => {
    e.stopPropagation();
    const note = status === 'open' ? '' : prompt(`${label} note (what changed / why):`, '') || '';
    await writeOp({
      type: 'set-status',
      id: c.id,
      status,
      author: authorName(),
      resolution: status === 'open' ? null : { by: authorName(), note },
    });
  });
  return b;
}

function deleteBtn(c) {
  const b = document.createElement('button');
  b.className = 'btn danger';
  b.textContent = 'Delete';
  b.addEventListener('click', async (e) => {
    e.stopPropagation();
    const ok = confirm('Delete this comment? This removes the thread from the review sidecar.');
    if (!ok) return;
    await writeOp({ type: 'delete-comment', id: c.id });
  });
  return b;
}

function focusAnchor(id) {
  els.doc.querySelectorAll('.anchored-block.active').forEach((b) => b.classList.remove('active'));
  const block = els.doc.querySelector(`.anchored-block[data-comment-id="${id}"]`);
  if (block) {
    block.classList.add('active');
    block.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

// --- live reload --------------------------------------------------------
function connectSse() {
  const es = new EventSource(`/api/events?token=${encodeURIComponent(TOKEN)}`);
  es.onmessage = (e) => {
    let payload;
    try {
      payload = JSON.parse(e.data);
    } catch {
      return;
    }
    if (payload.type !== 'change') return;
    // Refresh the spec list (new/removed specs) and the open spec if affected.
    loadSpecs().catch(() => {});
    if (state.current && (!payload.path || payload.path.includes(baseName(state.current.path)) || payload.path === state.current.path)) {
      selectSpec(state.current.path).catch(() => {});
    }
  };
  es.onerror = () => {}; // browser auto-reconnects
}

// --- helpers ------------------------------------------------------------
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function fmtTime(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}
function baseName(p) {
  return p.split('/').pop();
}
function showBanner(text) {
  els.banner.textContent = text;
  els.banner.hidden = false;
}
function showToast(text) {
  // lightweight: reuse the banner briefly
  showBanner(text);
  setTimeout(() => {
    if (!state.meta || !state.meta.readOnly) els.banner.hidden = true;
  }, 4000);
}

init().catch((err) => showBanner(`Failed to start: ${err.message}`));
