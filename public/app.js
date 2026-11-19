// Social Hub front end: Planner (calendar), Composer (with per-network previews), Media library, Accounts.

const NETWORKS = {
  facebook: { label: 'Facebook', short: 'f', limit: 63206, needs: 'Text, photo or video' },
  instagram: { label: 'Instagram', short: 'IG', limit: 2200, needs: 'JPEG photo or video' },
  tiktok: { label: 'TikTok', short: 'TT', limit: 2200, needs: 'Video only' },
};
const NET_IDS = Object.keys(NETWORKS);
const STATUS_LABEL = {
  draft: 'Draft', pending_approval: 'Needs approval', scheduled: 'Scheduled', publishing: 'Publishing',
  published: 'Published', partial: 'Partly published', failed: 'Failed', pending: 'Pending',
};
const DAY = 86_400_000;

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const netIcon = (id) => `<span class="net ${id}" title="${NETWORKS[id].label}" aria-label="${NETWORKS[id].label}">${NETWORKS[id].short}</span>`;
const badge = (status) => `<span class="badge ${status}">${STATUS_LABEL[status] || status}</span>`;

const S = {
  status: null,
  posts: [],
  media: [],
  mode: 'week',
  cursor: startOfDay(new Date()),
  netFilter: new Set(NET_IDS),
  statusFilter: 'all',
  draft: null,
  captionTab: 'all',
  previewTab: null,
  drawerId: null,
  pickerOpen: false,
};

// ---------- dates ----------
function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function startOfWeek(d) { const x = startOfDay(d); const dow = (x.getDay() + 6) % 7; x.setDate(x.getDate() - dow); return x; }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const fmtTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const fmtDateTime = (ms) => new Date(ms).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const pad = (n) => String(n).padStart(2, '0');
const toDateInput = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const toTimeInput = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** When a post shows on the calendar: its scheduled time, or when it went out. */
function postTime(p) {
  if (p.scheduled_at) return p.scheduled_at;
  const pub = p.targets.map((t) => t.published_at).filter(Boolean);
  return pub.length ? Math.max(...pub) : null;
}

// ---------- API ----------
async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: opts.body && !(opts.body instanceof FormData) ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body && !(opts.body instanceof FormData) ? JSON.stringify(opts.body) : opts.body,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { errors: data.errors });
  return data;
}

function uploadFile(file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const form = new FormData();
    form.append('file', file);
    xhr.open('POST', '/api/media');
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      let data = {}; try { data = JSON.parse(xhr.responseText); } catch {}
      xhr.status < 300 ? resolve(data) : reject(new Error(data.error || `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error('Upload failed. Check your connection.'));
    xhr.send(form);
  });
}

async function refresh() {
  const [status, posts, media] = await Promise.all([api('/api/status'), api('/api/posts'), api('/api/media')]);
  Object.assign(S, { status, posts, media });
  render();
}

function notify(msg, kind = 'info') {
  const n = $('#notice');
  n.className = `notice${kind === 'error' ? ' error' : ''}`;
  n.innerHTML = `<span>${esc(msg)}</span><button class="btn" data-action="dismiss-notice">Dismiss</button>`;
  n.hidden = false;
  if (kind !== 'error') setTimeout(() => { n.hidden = true; }, 6000);
}

// ---------- routing ----------
function go(view) {
  if (location.hash !== '#' + view) history.pushState(null, '', '#' + view);
  render();
}

function currentView() {
  const h = location.hash.slice(1);
  return ['planner', 'composer', 'media', 'accounts'].find((v) => h.startsWith(v)) || 'planner';
}

function render() {
  const view = currentView();
  for (const v of ['planner', 'composer', 'media', 'accounts']) $(`#view-${v}`).hidden = v !== view;
  $$('.nav-item').forEach((a) => a.classList.toggle('active', a.dataset.view === view));
  renderModeBadge();
  if (view === 'planner') renderPlanner();
  if (view === 'composer') renderComposer();
  if (view === 'media') renderMediaGrid($('#media-grid'), false);
  if (view === 'accounts') renderAccounts();
  if (S.pickerOpen) renderMediaGrid($('#picker-grid'), true);
  renderDrawer();
}

function renderModeBadge() {
  if (!S.status) return;
  $('#mode-badge').innerHTML = S.status.dryRun
    ? `<span class="badge dry" title="Posts are simulated. Switch to live posting on the Accounts page.">Dry run: nothing is really posted</span>`
    : `<span class="badge live">Live posting</span>`;
}

// ---------- Planner ----------
function visiblePosts() {
  return S.posts.filter((p) => {
    if (!p.platforms.some((id) => S.netFilter.has(id))) return false;
    if (S.statusFilter === 'all') return true;
    if (S.statusFilter === 'problem') return p.status === 'failed' || p.status === 'partial';
    if (S.statusFilter === 'scheduled') return p.status === 'scheduled' || p.status === 'publishing';
    return p.status === S.statusFilter;
  });
}

function postCard(p) {
  const t = postTime(p);
  const thumb = p.media_type === 'image' ? `<img class="thumb" src="${esc(p.media_url)}" alt="" loading="lazy">`
    : p.media_type === 'video' ? `<video class="thumb" src="${esc(p.media_url)}#t=0.5" preload="metadata" muted></video>` : '';
  return `<button class="post-card st-${p.status}" data-open="${p.id}" title="${esc(STATUS_LABEL[p.status])}: ${esc(p.caption.slice(0, 120))}">
    <span class="row"><span class="time">${t ? fmtTime(t) : 'No time'}</span>${p.platforms.map(netIcon).join('')}</span>
    ${thumb}
    <span class="text">${esc(p.caption) || '<i>No text</i>'}</span>
  </button>`;
}

function renderPlanner() {
  $$('.segmented button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.mode === S.mode)));
  $('#status-filter').value = S.statusFilter;
  $('#network-filter').innerHTML = NET_IDS.map((id) =>
    `<button class="chip" data-netfilter="${id}" aria-pressed="${S.netFilter.has(id)}">${netIcon(id)}${NETWORKS[id].label}</button>`).join('');

  const posts = visiblePosts();
  const dated = posts.filter((p) => postTime(p)).sort((a, b) => postTime(a) - postTime(b));
  const today = startOfDay(new Date());
  const cal = $('#calendar');

  if (S.mode === 'list') {
    const from = startOfDay(addDays(S.cursor, -30)).getTime();
    const rows = dated.filter((p) => postTime(p) >= from);
    $('#range-label').textContent = 'All posts';
    if (!rows.length) { cal.className = 'calendar'; cal.innerHTML = `<div class="empty">No posts yet. Create one to get started.</div>`; }
    else {
      const groups = new Map();
      for (const p of rows) {
        const key = startOfDay(postTime(p)).getTime();
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(p);
      }
      cal.className = 'calendar list-view';
      cal.innerHTML = [...groups].map(([day, ps]) => `<div class="list-day"><h3>${new Date(day).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}</h3>
        ${ps.map((p) => `<div class="list-row" data-open="${p.id}" role="button" tabindex="0">
          <span class="time-col">${fmtTime(postTime(p))}</span>
          ${p.media_type === 'image' ? `<img src="${esc(p.media_url)}" alt="" loading="lazy">` : p.media_type === 'video' ? `<video src="${esc(p.media_url)}#t=0.5" preload="metadata" muted class="noimg"></video>` : '<span class="noimg"></span>'}
          <span class="text">${esc(p.caption) || '<i>No text</i>'}</span>
          <span class="nets">${p.platforms.map(netIcon).join('')}</span>
          ${badge(p.status)}
        </div>`).join('')}</div>`).join('');
    }
  } else {
    let start, days;
    if (S.mode === 'week') {
      start = startOfWeek(S.cursor); days = 7;
      const end = addDays(start, 6);
      $('#range-label').textContent = `${start.toLocaleDateString([], { month: 'short', day: 'numeric' })} – ${end.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}`;
    } else {
      const first = new Date(S.cursor.getFullYear(), S.cursor.getMonth(), 1);
      start = startOfWeek(first);
      const last = new Date(S.cursor.getFullYear(), S.cursor.getMonth() + 1, 0);
      days = Math.ceil((Math.round((startOfDay(last) - start) / DAY) + 1) / 7) * 7;
      $('#range-label').textContent = S.cursor.toLocaleDateString([], { month: 'long', year: 'numeric' });
    }
    const head = Array.from({ length: 7 }, (_, i) => {
      const d = addDays(start, i);
      const isToday = S.mode === 'week' && sameDay(d, today);
      return `<div class="${isToday ? 'is-today' : ''}">${d.toLocaleDateString([], { weekday: 'short' })}${S.mode === 'week' ? ' ' + d.getDate() : ''}</div>`;
    }).join('');
    const cells = Array.from({ length: days }, (_, i) => {
      const d = addDays(start, i);
      const items = dated.filter((p) => sameDay(new Date(postTime(p)), d));
      const cls = ['day', sameDay(d, today) && 'is-today', d < today && 'past', S.mode === 'month' && d.getMonth() !== S.cursor.getMonth() && 'other-month'].filter(Boolean).join(' ');
      return `<div class="${cls}">
        <div class="day-num"><span>${S.mode === 'month' ? d.getDate() : `<span class="week-day-label">${d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}</span>`}</span>
        ${d >= today ? `<button class="day-add" data-newon="${d.getTime()}" aria-label="New post on ${d.toDateString()}">+</button>` : ''}</div>
        ${items.map(postCard).join('')}
      </div>`;
    }).join('');
    cal.className = `calendar ${S.mode}`;
    cal.innerHTML = `<div class="cal-head">${head}</div><div class="cal-grid">${cells}</div>`;
  }

  const pending = posts.filter((p) => p.status === 'pending_approval');
  const drafts = posts.filter((p) => p.status === 'draft' && !p.scheduled_at);
  $('#approval-list').innerHTML = pending.length ? pending.map(postCard).join('') : `<div class="empty">Nothing waiting.</div>`;
  $('#draft-list').innerHTML = drafts.length ? drafts.map(postCard).join('') : `<div class="empty">No drafts.</div>`;
}

// ---------- Composer ----------
function nextHour() { const d = new Date(); d.setMinutes(0, 0, 0); d.setHours(d.getHours() + 1); return d; }

function newDraft(when) {
  const d = when ? new Date(when) : nextHour();
  if (when) d.setHours(9, 0, 0, 0);
  if (d < new Date()) { const n = nextHour(); d.setHours(n.getHours()); }
  const ready = S.status?.platforms.filter((p) => p.ready).map((p) => p.id);
  return { id: null, platforms: ready?.length ? ready : [...NET_IDS], caption: '', overrides: {}, media: null, date: toDateInput(d), time: toTimeInput(d) };
}

function draftFromPost(p) {
  const d = p.scheduled_at ? new Date(p.scheduled_at) : nextHour();
  return {
    id: p.id, platforms: [...p.platforms], caption: p.caption, overrides: { ...p.caption_overrides },
    media: p.media_file ? (S.media.find((m) => m.file === p.media_file) || { file: p.media_file, type: p.media_type, mime: p.media_mime, url: p.media_url, original_name: p.media_original_name }) : null,
    date: toDateInput(d), time: toTimeInput(d),
  };
}

function openComposer(draft) {
  S.draft = draft;
  S.captionTab = 'all';
  S.previewTab = draft.platforms[0] || null;
  closeDrawer();
  go('composer');
}

const captionFor = (d, id) => (d.overrides[id]?.trim() ? d.overrides[id] : d.caption);

/** Client-side copy of the server's rules, for instant feedback. The server checks again. */
function problemsFor(d) {
  const out = [];
  if (!d.platforms.length) out.push({ msg: 'Pick at least one network.' });
  const m = d.media;
  for (const id of d.platforms) {
    const n = NETWORKS[id], cap = captionFor(d, id);
    if (cap.length > n.limit) out.push({ msg: `${n.label}: text is ${cap.length - n.limit} characters too long.` });
    if (id === 'facebook' && !m && !cap.trim()) out.push({ msg: 'Facebook: add some text or media.' });
    if (id === 'instagram') {
      if (!m) out.push({ msg: 'Instagram: add a photo or video.' });
      else if (m.type === 'image' && m.mime !== 'image/jpeg') out.push({ msg: 'Instagram: photos must be JPEG.' });
      if ((cap.match(/#[\p{L}\p{N}_]+/gu) || []).length > 30) out.push({ msg: 'Instagram: no more than 30 hashtags.' });
    }
    if (id === 'tiktok' && m?.type !== 'video') out.push({ msg: 'TikTok: add a video.' });
    const st = S.status?.platforms.find((p) => p.id === id);
    if (st && !st.ready && !S.status.dryRun) out.push({ msg: `${n.label} isn't connected: ${st.message}`, warn: true });
  }
  return out;
}

function renderComposer() {
  if (!S.draft) S.draft = newDraft();
  const d = S.draft;
  $('#composer-title').textContent = d.id ? `Edit post #${d.id}` : 'Create post';

  $('#network-picker').innerHTML = NET_IDS.map((id) => {
    const st = S.status?.platforms.find((p) => p.id === id);
    const note = st && !st.ready ? (S.status.dryRun ? 'Not connected (dry run ok)' : 'Not connected') : NETWORKS[id].needs;
    return `<label class="net-toggle"><input type="checkbox" data-pick="${id}" ${d.platforms.includes(id) ? 'checked' : ''}>
      ${netIcon(id)}<span>${NETWORKS[id].label}<small>${esc(note)}</small></span></label>`;
  }).join('');

  if (S.captionTab !== 'all' && !d.platforms.includes(S.captionTab)) S.captionTab = 'all';
  $('#caption-tabs').innerHTML = [`<button role="tab" data-ctab="all" aria-selected="${S.captionTab === 'all'}">All networks</button>`,
    ...d.platforms.map((id) => `<button role="tab" data-ctab="${id}" aria-selected="${S.captionTab === id}">${netIcon(id)}${NETWORKS[id].label}${d.overrides[id]?.trim() ? '<span class="dot" title="Customized"></span>' : ''}</button>`)].join('');
  const ta = $('#caption');
  const value = S.captionTab === 'all' ? d.caption : captionFor(d, S.captionTab);
  if (document.activeElement !== ta || ta.dataset.tab !== S.captionTab) { ta.value = value; ta.dataset.tab = S.captionTab; }
  $('#caption-hint').innerHTML = S.captionTab === 'all'
    ? 'This text goes to every network. Pick a network tab to write a different version for it.'
    : d.overrides[S.captionTab]?.trim()
      ? `Custom text for ${NETWORKS[S.captionTab].label}. <button type="button" class="btn" data-action="reset-override">Use main text instead</button>`
      : `Editing here gives ${NETWORKS[S.captionTab].label} its own version of the text.`;

  renderCounts();
  renderMediaSlot();
  $('#sched-date').value = d.date;
  $('#sched-time').value = d.time;
  $('#tz-label').textContent = Intl.DateTimeFormat().resolvedOptions().timeZone;
  renderProblems();
  renderPreview();
}

function renderCounts() {
  const d = S.draft;
  $('#caption-count').innerHTML = d.platforms.map((id) => {
    const len = captionFor(d, id).length, lim = NETWORKS[id].limit;
    return `<span class="${len > lim ? 'over' : ''}">${NETWORKS[id].label} ${len.toLocaleString()}/${lim.toLocaleString()}</span>`;
  }).join('');
}

function renderProblems() {
  $('#problems').innerHTML = problemsFor(S.draft).map((p) => `<li class="${p.warn ? 'warn' : ''}">${esc(p.msg)}</li>`).join('');
}

function renderMediaSlot() {
  const m = S.draft.media;
  const slot = $('#media-slot');
  if (!m) {
    slot.innerHTML = `<div class="media-drop" data-action="pick-media" role="button" tabindex="0">
      Drag a photo or video here, or <b>click to choose</b> from your library or computer.</div>`;
    return;
  }
  slot.innerHTML = `<div class="media-chosen">
    ${m.type === 'video' ? `<video src="${esc(m.url)}" muted controls preload="metadata"></video>` : `<img src="${esc(m.url)}" alt="">`}
    <div><div>${esc(m.original_name || m.file)}</div><div class="hint">${esc(m.mime || '')}</div>
    <div style="display:flex;gap:6px;margin-top:6px"><button type="button" class="btn" data-action="pick-media">Change</button>
    <button type="button" class="btn danger" data-action="remove-media">Remove</button></div></div></div>`;
}

const linkify = (s, cls = 'hashtag') => esc(s).replace(/([#@][\p{L}\p{N}_.]+)/gu, `<span class="${cls}">$1</span>`);

function renderPreview() {
  const d = S.draft;
  if (!d.platforms.includes(S.previewTab)) S.previewTab = d.platforms[0] || null;
  $('#preview-tabs').innerHTML = d.platforms.map((id) =>
    `<button role="tab" data-ptab="${id}" aria-selected="${S.previewTab === id}">${netIcon(id)}${NETWORKS[id].label}</button>`).join('');
  const stage = $('#preview');
  if (!S.previewTab) { stage.innerHTML = `<div class="empty">Pick a network to see a preview.</div>`; return; }
  const id = S.previewTab, cap = captionFor(d, id), m = d.media;
  const when = d.date && d.time ? new Date(`${d.date}T${d.time}`) : new Date();
  const media = (fallback) => !m ? `<div class="pv-placeholder">${fallback}</div>`
    : m.type === 'video' ? `<video class="pv-media" src="${esc(m.url)}" muted loop autoplay playsinline></video>`
    : `<img class="pv-media" src="${esc(m.url)}" alt="">`;
  const problems = problemsFor({ ...d, platforms: [id] }).filter((p) => !p.warn);
  const warn = problems.length ? `<div class="pv-warning">${problems.map((p) => esc(p.msg)).join('<br>')}</div>` : '';

  if (id === 'facebook') {
    stage.innerHTML = `<div class="pv fb">${warn}<div class="pv-head"><div class="pv-avatar"></div><div><div class="pv-name">Your Page</div>
      <div class="pv-sub">${when.toLocaleDateString([], { month: 'long', day: 'numeric' })} at ${fmtTime(when)} · 🌐</div></div></div>
      ${cap ? `<div class="pv-text">${linkify(cap)}</div>` : ''}${m ? media('') : ''}
      <div class="pv-actions"><span>👍 Like</span><span>💬 Comment</span><span>↗ Share</span></div></div>`;
  } else if (id === 'instagram') {
    stage.innerHTML = `<div class="pv ig">${warn}<div class="pv-head"><div class="pv-avatar"></div><div class="pv-name">your_account</div></div>
      ${media('Instagram needs a photo or video')}
      <div class="pv-actions"><span>♡</span><span>💬</span><span>➤</span></div>
      <div class="pv-text"><b>your_account</b>${linkify(cap)}</div></div>`;
  } else {
    stage.innerHTML = `<div class="tt-wrap">${warn ? `<div class="pv tt-warn">${warn}</div>` : ''}
      <div class="pv tt">${media('TikTok needs a video')}
      <div class="pv-rail"><span>❤</span><span>💬</span><span>↗</span></div>
      <div class="pv-overlay"><b>@your_account</b><div class="pv-text">${linkify(cap)}</div></div></div></div>`;
  }
}

async function submitComposer(action) {
  const d = S.draft;
  const scheduled_at = d.date && d.time ? new Date(`${d.date}T${d.time}`).getTime() : null;
  const body = { caption: d.caption, caption_overrides: d.overrides, platforms: d.platforms, media_file: d.media?.file || null, scheduled_at, action };
  const buttons = $$('[data-submit]');
  buttons.forEach((b) => (b.disabled = true));
  try {
    const post = await api(d.id ? `/api/posts/${d.id}` : '/api/posts', { method: d.id ? 'PUT' : 'POST', body });
    const msg = { draft: 'Draft saved.', submit: 'Sent for approval.', schedule: `Scheduled for ${fmtDateTime(post.scheduled_at)}.`, now: 'Publishing now…' }[action];
    S.draft = null;
    if (post.scheduled_at) S.cursor = startOfDay(post.scheduled_at);
    go('planner');
    notify(msg);
    await refresh();
    if (action === 'now') openDrawer(post.id);
  } catch (err) {
    $('#problems').innerHTML = (err.errors?.length ? err.errors : [err.message]).map((m) => `<li>${esc(m)}</li>`).join('');
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
}

// ---------- Drawer (post details) ----------
function openDrawer(id) { S.drawerId = id; renderDrawer(); }
function closeDrawer() { S.drawerId = null; renderDrawer(); }

function renderDrawer() {
  const drawer = $('#drawer'), back = $('#drawer-backdrop');
  const p = S.posts.find((x) => x.id === S.drawerId);
  drawer.hidden = back.hidden = !p;
  if (!p) return;
  const t = postTime(p);
  const can = {
    edit: ['draft', 'pending_approval', 'scheduled', 'failed', 'partial'].includes(p.status),
    approve: p.status === 'pending_approval',
    unschedule: p.status === 'scheduled',
    now: ['draft', 'pending_approval', 'scheduled'].includes(p.status),
    retry: ['failed', 'partial'].includes(p.status),
    del: p.status !== 'publishing',
  };
  const overrides = Object.entries(p.caption_overrides || {}).filter(([, v]) => v?.trim());
  drawer.innerHTML = `
    <div class="toolbar"><h1>Post #${p.id}</h1><button class="btn" data-action="close-drawer">Close</button></div>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">${badge(p.status)}<span class="meta">${t ? (p.status === 'published' ? 'Posted ' : '') + fmtDateTime(t) : 'Not scheduled'}</span></div>
    ${p.media_type === 'video' ? `<video class="drawer-media" src="${esc(p.media_url)}" controls preload="metadata"></video>` : p.media_type === 'image' ? `<img class="drawer-media" src="${esc(p.media_url)}" alt="">` : ''}
    <div><h2>Text</h2><div class="caption">${esc(p.caption) || '<i>No text</i>'}</div></div>
    ${overrides.map(([id, v]) => `<div><h2>${NETWORKS[id].label} version</h2><div class="caption">${esc(v)}</div></div>`).join('')}
    <div><h2>Networks</h2><div class="targets">${p.targets.map((tg) => `<div class="target">${netIcon(tg.platform)}
      <div><div>${NETWORKS[tg.platform].label}</div>
        ${tg.remote_url ? `<a href="${esc(tg.remote_url)}" target="_blank" rel="noopener">View post ↗</a>` : tg.remote_id ? `<div class="meta">ID ${esc(tg.remote_id)}</div>` : ''}
        ${tg.error ? `<div class="err">${esc(tg.error)}</div>` : ''}</div>
      ${badge(tg.status)}</div>`).join('')}</div></div>
    <div class="drawer-actions">
      ${can.approve ? `<button class="btn primary" data-post-action="approve">Approve</button><button class="btn" data-post-action="reject">Send back to draft</button>` : ''}
      ${can.edit ? `<button class="btn" data-post-action="edit">Edit</button>` : ''}
      ${can.now ? `<button class="btn" data-post-action="publish-now">Post now</button>` : ''}
      ${can.unschedule ? `<button class="btn" data-post-action="reject">Unschedule</button>` : ''}
      ${can.retry ? `<button class="btn primary" data-post-action="retry">Retry failed networks</button>` : ''}
      <button class="btn" data-post-action="duplicate">Duplicate</button>
      ${can.del ? `<button class="btn danger" data-post-action="delete">Delete</button>` : ''}
    </div>
    ${p.status === 'published' || p.status === 'partial' ? '<p class="hint">Deleting here only removes it from Social Hub. It stays on the networks.</p>' : ''}`;
}

async function postAction(action) {
  const p = S.posts.find((x) => x.id === S.drawerId);
  if (!p) return;
  try {
    if (action === 'edit') return openComposer(draftFromPost(p));
    if (action === 'delete') {
      if (!confirm('Delete this post from Social Hub?')) return;
      await api(`/api/posts/${p.id}`, { method: 'DELETE' });
      closeDrawer(); notify('Post deleted.');
    } else if (action === 'duplicate') {
      const copy = await api(`/api/posts/${p.id}/duplicate`, { method: 'POST' });
      await refresh();
      return openComposer(draftFromPost(copy));
    } else {
      await api(`/api/posts/${p.id}/${action}`, { method: 'POST' });
      notify({ approve: 'Approved and scheduled.', reject: 'Moved back to drafts.', 'publish-now': 'Publishing now…', retry: 'Retrying…' }[action]);
    }
    await refresh();
  } catch (err) {
    notify(err.message, 'error');
  }
}

// ---------- Media ----------
function renderMediaGrid(el, pickable) {
  if (!S.media.length) { el.innerHTML = `<div class="empty">No media yet. Upload a photo or video.</div>`; return; }
  el.innerHTML = S.media.map((m) => `<div class="media-tile${pickable ? ' pickable' : ''}" ${pickable ? `data-choose="${esc(m.file)}" role="button" tabindex="0"` : ''}>
    ${m.type === 'video' ? `<video src="${esc(m.url)}#t=0.5" preload="metadata" muted></video>` : `<img src="${esc(m.url)}" alt="" loading="lazy">`}
    <div class="info"><span class="name" title="${esc(m.original_name)}">${esc(m.original_name || m.file)}</span>
    <span class="row"><span>${m.type} · ${(m.size / 1048576).toFixed(1)} MB</span>
    ${pickable ? '' : m.used_by ? `<span>${m.used_by} post${m.used_by > 1 ? 's' : ''}</span>` : `<button class="btn danger" data-delmedia="${esc(m.file)}">Delete</button>`}</span></div></div>`).join('');
}

async function handleUploads(files, { attach = false } = {}) {
  for (const file of files) {
    const label = file.name;
    try {
      notify(`Uploading ${label}…`);
      const m = await uploadFile(file, (f) => { $('#notice span').textContent = `Uploading ${label}… ${Math.round(f * 100)}%`; });
      S.media.unshift(m);
      if (attach && S.draft) { S.draft.media = m; closePicker(); }
      notify(`Uploaded ${label}.`);
    } catch (err) {
      notify(`${label}: ${err.message}`, 'error');
    }
  }
  render();
}

function openPicker() {
  S.pickerOpen = true;
  renderMediaGrid($('#picker-grid'), true);
  $('#picker').showModal();
  api('/api/media').then((m) => { S.media = m; if (S.pickerOpen) renderMediaGrid($('#picker-grid'), true); }).catch(() => {});
}
function closePicker() { S.pickerOpen = false; $('#picker').close(); }

// ---------- Accounts (settings) ----------
// Forms here save to the server; secrets are never sent back, only whether they are saved.
let accountsDirty = false;

function srcTag(f) {
  return f?.source === 'env' ? ' <span class="src-tag" title="Comes from the server\'s .env file. Saving a value here replaces it.">from .env</span>' : '';
}
function secretInput(name, label, f, hint = '') {
  return `<label class="field"><span class="label">${label}${srcTag(f)}</span>
    <input class="input" type="password" name="${name}" autocomplete="off" spellcheck="false"
      placeholder="${f?.set ? 'Saved. Leave blank to keep it' : 'Not set'}">${hint ? `<span class="hint">${hint}</span>` : ''}</label>`;
}
function textInput(name, label, f, hint = '') {
  return `<label class="field"><span class="label">${label}${srcTag(f)}</span>
    <input class="input" type="text" name="${name}" autocomplete="off" spellcheck="false" value="${esc(f?.value ?? '')}">${hint ? `<span class="hint">${hint}</span>` : ''}</label>`;
}
function copyField(label, value) {
  return `<div class="field"><span class="label">${label}</span>
    <div class="copy-row"><code class="copy-val">${esc(value)}</code><button type="button" class="btn" data-action="copy" data-copy="${esc(value)}">Copy</button></div></div>`;
}
const statusBadge = (ok) => `<span class="badge ${ok ? 'published' : 'failed'}">${ok ? 'Connected' : 'Not connected'}</span>`;

function renderAccounts() {
  const st = S.status;
  if (!st) return;
  // Don't wipe what you're typing when the page refreshes in the background.
  if (accountsDirty || $('#accounts')?.contains(document.activeElement) && document.activeElement.matches('input,select,textarea')) return;
  const cfg = st.settings;
  const plat = Object.fromEntries(st.platforms.map((p) => [p.id, p]));
  const fbOk = plat.facebook.ready, igOk = plat.instagram.ready;
  const pageName = cfg.facebookPageName.value || (cfg.facebookPageId.value ? `Page ${cfg.facebookPageId.value}` : '');
  const igName = cfg.instagramUsername.value ? `@${cfg.instagramUsername.value}` : (cfg.instagramUserId.value ? 'linked' : '');
  const pending = st.metaPendingPages || [];
  const tokenFromWeb = cfg.facebookPageToken.source === 'web';

  const mode = `<div class="account wide">
    <div class="account-head">Posting mode<span class="badge ${st.dryRun ? 'dry' : 'live'}">${st.dryRun ? 'Dry run' : 'Live'}</span></div>
    <div class="meta">${st.dryRun
      ? 'Dry run: posts are simulated and marked published without contacting any network. Switch to live once your accounts are connected and tested.'
      : 'Live: scheduled and "Post now" posts go out to the real networks.'}</div>
    <div class="row">${st.dryRun
      ? '<button class="btn primary" data-action="set-live">Switch to live posting</button>'
      : '<button class="btn" data-action="set-dry">Switch back to dry run</button>'}</div>
    <div class="meta">This website only opens on your home network. From the internet, <code>${esc(st.publicBaseUrl)}</code> only serves your uploaded media (Instagram downloads it from there) and the TikTok and Facebook login return pages.</div>
    ${st.publicUrlIsLocal ? '<div class="meta warn-text">No public address is set up, so Instagram posting and the TikTok and Facebook logins won\'t work yet. See the README section on the Cloudflare Tunnel.</div>' : ''}
  </div>`;

  let metaBody;
  if (pending.length) {
    metaBody = `<form class="stack" data-form="meta-choose">
      <div class="label">Choose the Page to post to</div>
      ${pending.map((p, i) => `<label class="choice"><input type="radio" name="pageId" value="${esc(p.id)}" ${i === 0 ? 'checked' : ''}>
        <span><b>${esc(p.name)}</b><br><span class="meta">${p.ig ? `Instagram: @${esc(p.ig.username)}` : 'No Instagram business or creator account linked'}</span></span></label>`).join('')}
      <div class="row"><button class="btn primary" type="submit">Use this Page</button></div>
    </form>`;
  } else if (fbOk) {
    metaBody = `<div class="connected">
      <div>${netIcon('facebook')} <b>${esc(pageName)}</b></div>
      <div>${netIcon('instagram')} ${igName ? `<b>${esc(igName)}</b>` : '<span class="meta">No Instagram account linked to this Page</span>'}</div>
    </div>
    <div class="row">${st.metaConfigured ? '<a class="btn" href="/auth/meta">Choose a different Page</a>' : ''}
      ${tokenFromWeb ? '<button class="btn danger" data-action="meta-disconnect">Disconnect</button>' : '<span class="hint">Connected through the server\'s .env file.</span>'}</div>`;
  } else {
    metaBody = `<div class="row"><a class="btn primary ${st.metaConfigured ? '' : 'disabled'}" ${st.metaConfigured ? 'href="/auth/meta"' : 'aria-disabled="true"'}>Log in with Facebook</a>
      ${st.metaConfigured ? '' : '<span class="hint">Save your Meta app details first.</span>'}</div>
      <details class="alt"><summary>Or paste a token from the Graph API Explorer</summary>
        <form class="stack" data-form="meta-token">
          <p class="hint">In the Graph API Explorer, pick your app, add the permissions below, click "Generate Access Token" and paste it here.
          It's swapped for a Page token that doesn't expire, and isn't stored itself.</p>
          <code class="perm-list">pages_show_list, pages_read_engagement, pages_manage_posts, instagram_basic, instagram_content_publish, business_management</code>
          <input class="input" type="password" name="userToken" autocomplete="off" placeholder="User access token">
          <div class="row"><button class="btn" type="submit" ${st.metaConfigured ? '' : 'disabled'}>Find my Pages</button></div>
        </form></details>`;
  }

  const metaCard = `<div class="account wide">
    <div class="account-head">${netIcon('facebook')}${netIcon('instagram')}Facebook &amp; Instagram
      <span class="badges">${statusBadge(fbOk)}</span></div>
    <div class="meta">Facebook: ${esc(plat.facebook.message)}<br>Instagram: ${esc(plat.instagram.message)}</div>
    <div class="two-col">
      <form class="stack" data-form="settings">
        <div class="step">1. Your Meta app</div>
        ${textInput('metaAppId', 'App ID', cfg.metaAppId)}
        ${secretInput('metaAppSecret', 'App secret', cfg.metaAppSecret, 'Meta for Developers → your app → App settings → Basic.')}
        ${textInput('metaConfigId', 'Login configuration ID (optional)', cfg.metaConfigId, 'Only for "Facebook Login for Business" apps. Leave blank otherwise.')}
        ${copyField('Add this to "Valid OAuth Redirect URIs" in Facebook Login settings', cfg.metaRedirectUri)}
        <div class="row"><button class="btn primary" type="submit">Save</button></div>
      </form>
      <div class="stack"><div class="step">2. Connect your Page</div>${metaBody}</div>
    </div>
  </div>`;

  const tt = plat.tiktok;
  const ttCard = `<div class="account wide">
    <div class="account-head">${netIcon('tiktok')}TikTok${statusBadge(tt.ready)}</div>
    <div class="meta">${esc(tt.message)}</div>
    <div class="two-col">
      <form class="stack" data-form="settings">
        <div class="step">1. Your TikTok app</div>
        ${textInput('tiktokClientKey', 'Client key', cfg.tiktokClientKey)}
        ${secretInput('tiktokClientSecret', 'Client secret', cfg.tiktokClientSecret, 'TikTok for Developers → your app → App details.')}
        <label class="field"><span class="label">Who can see posts${srcTag(cfg.tiktokPrivacyLevel)}</span>
          <select class="select" name="tiktokPrivacyLevel">${cfg.privacyLevels.map((v) => `<option value="${v}" ${v === cfg.tiktokPrivacyLevel.value ? 'selected' : ''}>${{
            SELF_ONLY: 'Only me (required until TikTok audits your app)', MUTUAL_FOLLOW_FRIENDS: 'Friends', FOLLOWER_OF_CREATOR: 'Followers', PUBLIC_TO_EVERYONE: 'Everyone' }[v]}</option>`).join('')}</select></label>
        ${copyField('Redirect URI to register in your TikTok app', cfg.tiktokRedirectUri)}
        <div class="row"><button class="btn primary" type="submit">Save</button></div>
      </form>
      <div class="stack"><div class="step">2. Connect your account</div>
        ${!st.tiktokConfigured ? '<p class="hint">Save your Client key and Client secret first.</p>'
          : tt.ready ? `<div class="connected"><div>${netIcon('tiktok')} <b>${esc(tt.message)}</b></div></div><div class="row"><button class="btn danger" data-action="tiktok-disconnect">Disconnect TikTok</button></div>`
          : '<div class="row"><a class="btn primary" href="/auth/tiktok">Connect TikTok</a></div>'}
      </div>
    </div>
  </div>`;

  $('#accounts').innerHTML = mode + metaCard + ttCard;
}

async function saveSettings(patch, okMsg = 'Saved.') {
  try {
    await api('/api/settings', { method: 'PUT', body: patch });
    accountsDirty = false;
    await refresh();
    notify(okMsg);
  } catch (err) { notify(err.message, 'error'); }
}

document.addEventListener('input', (e) => { if (e.target.closest('#accounts form')) accountsDirty = true; });
document.addEventListener('submit', async (e) => {
  const form = e.target.closest('#accounts form');
  if (!form) return;
  e.preventDefault();
  const data = Object.fromEntries(new FormData(form));
  const btn = form.querySelector('button[type=submit]');
  if (btn) btn.disabled = true;
  try {
    if (form.dataset.form === 'settings') return await saveSettings(data);
    if (form.dataset.form === 'meta-token') {
      const r = await api('/api/meta/token', { method: 'POST', body: { userToken: data.userToken } });
      accountsDirty = false; await refresh();
      return notify(`Found ${r.pages.length} Page${r.pages.length === 1 ? '' : 's'}. Choose one.`);
    }
    if (form.dataset.form === 'meta-choose') {
      const r = await api('/api/meta/choose', { method: 'POST', body: { pageId: data.pageId } });
      accountsDirty = false; await refresh();
      return notify(`Connected to ${r.page}${r.instagram ? ` and Instagram @${r.instagram}` : ''}.`);
    }
  } catch (err) { notify(err.message, 'error'); }
  finally { if (btn?.isConnected) btn.disabled = false; }
});

// ---------- events ----------
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action],[data-open],[data-newon],[data-mode],[data-netfilter],[data-ctab],[data-ptab],[data-submit],[data-post-action],[data-choose],[data-delmedia]');
  if (!el) return;
  const ds = el.dataset;
  if (ds.open) return openDrawer(Number(ds.open));
  if (ds.newon) return openComposer(newDraft(Number(ds.newon)));
  if (ds.mode) { S.mode = ds.mode; return renderPlanner(); }
  if (ds.netfilter) {
    S.netFilter.has(ds.netfilter) ? S.netFilter.delete(ds.netfilter) : S.netFilter.add(ds.netfilter);
    if (!S.netFilter.size) S.netFilter = new Set(NET_IDS);
    return renderPlanner();
  }
  if (ds.ctab) { S.captionTab = ds.ctab; return renderComposer(); }
  if (ds.ptab) { S.previewTab = ds.ptab; return renderPreview(); }
  if (ds.submit) return submitComposer(ds.submit);
  if (ds.postAction) return postAction(ds.postAction);
  if (ds.choose) { S.draft.media = S.media.find((m) => m.file === ds.choose); closePicker(); return renderComposer(); }
  if (ds.delmedia) {
    if (!confirm('Delete this file from the library?')) return;
    try { await api(`/api/media/${encodeURIComponent(ds.delmedia)}`, { method: 'DELETE' }); await refresh(); } catch (err) { notify(err.message, 'error'); }
    return;
  }
  switch (ds.action) {
    case 'new-post': return openComposer(newDraft());
    case 'today': S.cursor = startOfDay(new Date()); return renderPlanner();
    case 'prev': case 'next': {
      const dir = ds.action === 'next' ? 1 : -1;
      S.cursor = S.mode === 'month' ? new Date(S.cursor.getFullYear(), S.cursor.getMonth() + dir, 1) : addDays(S.cursor, 7 * dir);
      return renderPlanner();
    }
    case 'close-composer': S.draft = null; go('planner'); return;
    case 'close-drawer': return closeDrawer();
    case 'dismiss-notice': $('#notice').hidden = true; return;
    case 'pick-media': return openPicker();
    case 'close-picker': return closePicker();
    case 'remove-media': S.draft.media = null; return renderComposer();
    case 'reset-override': delete S.draft.overrides[S.captionTab]; return renderComposer();
    case 'tiktok-disconnect':
      if (!confirm('Disconnect TikTok? Scheduled TikTok posts will fail until you reconnect.')) return;
      await api('/api/tiktok/disconnect', { method: 'POST' }); return refresh();
    case 'meta-disconnect':
      if (!confirm('Disconnect Facebook and Instagram? Scheduled posts to them will fail until you reconnect.')) return;
      try { await api('/api/meta/disconnect', { method: 'POST' }); await refresh(); notify('Facebook and Instagram disconnected.'); } catch (err) { notify(err.message, 'error'); }
      return;
    case 'set-live':
      if (!confirm('Switch to live posting? Scheduled posts and "Post now" will publish to your real accounts.')) return;
      return saveSettings({ dryRun: false }, 'Live posting is on.');
    case 'set-dry':
      return saveSettings({ dryRun: true }, 'Dry run is on. Nothing will be posted.');
    case 'copy':
      try { await navigator.clipboard.writeText(ds.copy); notify('Copied.'); } catch { notify('Copy failed. Select the text and copy it yourself.', 'error'); }
      return;
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && S.drawerId) closeDrawer();
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-open][role=button],[data-action=pick-media],[data-choose]')) { e.preventDefault(); e.target.click(); }
});
$('#drawer-backdrop').addEventListener('click', closeDrawer);
$('#picker').addEventListener('close', () => { S.pickerOpen = false; });
$('#status-filter').addEventListener('change', (e) => { S.statusFilter = e.target.value; renderPlanner(); });

$('#composer-form').addEventListener('change', (e) => {
  const d = S.draft;
  if (e.target.dataset.pick) {
    const id = e.target.dataset.pick;
    d.platforms = e.target.checked ? NET_IDS.filter((x) => x === id || d.platforms.includes(x)) : d.platforms.filter((x) => x !== id);
    renderComposer();
  }
  if (e.target.id === 'sched-date') d.date = e.target.value;
  if (e.target.id === 'sched-time') d.time = e.target.value;
  if (e.target.id === 'sched-date' || e.target.id === 'sched-time') renderPreview();
});
$('#caption').addEventListener('input', (e) => {
  const d = S.draft;
  if (S.captionTab === 'all') d.caption = e.target.value;
  else d.overrides[S.captionTab] = e.target.value;
  renderCounts(); renderProblems(); renderPreview();
  const tab = $(`[data-ctab="${S.captionTab}"]`);
  if (tab && S.captionTab !== 'all' && !tab.querySelector('.dot')) renderComposer();
});

$('#media-upload').addEventListener('change', (e) => { handleUploads([...e.target.files]); e.target.value = ''; });
$('#picker-upload').addEventListener('change', (e) => { handleUploads([...e.target.files], { attach: true }); e.target.value = ''; });
document.addEventListener('dragover', (e) => { const z = e.target.closest?.('.media-drop'); if (z) { e.preventDefault(); z.classList.add('drag'); } });
document.addEventListener('dragleave', (e) => e.target.closest?.('.media-drop')?.classList.remove('drag'));
document.addEventListener('drop', (e) => {
  const z = e.target.closest?.('.media-drop');
  if (!z) return;
  e.preventDefault();
  handleUploads([...e.dataTransfer.files].slice(0, 1), { attach: true });
});

window.addEventListener('hashchange', render);
window.addEventListener('popstate', render);
document.addEventListener('click', (e) => { const a = e.target.closest('a.nav-item'); if (a) { e.preventDefault(); go(a.dataset.view); } });

// ---------- start ----------
const params = new URLSearchParams(location.search);
if (params.get('notice')) {
  notify(params.get('notice'), /fail|error|expired|denied/i.test(params.get('notice')) ? 'error' : 'info');
  history.replaceState(null, '', location.pathname + location.hash);
}
if (!location.hash) history.replaceState(null, '', '#planner');
refresh().catch((err) => notify(`Couldn't reach the server: ${err.message}`, 'error'));
// Keep statuses fresh: every 3 s while something is publishing or due within a minute, otherwise every 15 s.
(function poll() {
  const busy = S.posts.some((p) => p.status === 'publishing' || (p.status === 'scheduled' && p.scheduled_at - Date.now() < 60_000));
  setTimeout(async () => {
    if (currentView() !== 'composer') await refresh().catch(() => {});
    poll();
  }, busy ? 3000 : 15000);
})();
