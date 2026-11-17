'use strict';
/* Anki mode UI (runs inside Flanna) */
const $app = document.getElementById('app');
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
let S = { ...R.DEFAULTS };
let view = 'home';
let tab = 'practice';
try { tab = localStorage.getItem('recall.tab') || 'practice'; } catch (e) { /* ignore */ }
let session = null;
let home = null;
const NAMES = { 1: 'Again', 2: 'Hard', 3: 'Good', 4: 'Easy' };

const tellParent = (on) => { try { if (window.parent !== window) parent.postMessage({ recall: 'study', on }, location.origin); } catch (e) { /* ignore */ } };
function toast(msg, ms = 2800) {
  const t = document.getElementById('toast'); t.textContent = msg; t.classList.add('on');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('on'), ms);
}
function sheet(html) {
  const ov = document.createElement('div'); ov.className = 'overlay';
  ov.innerHTML = `<div class="sheet">${html}</div>`;
  ov.addEventListener('click', e => { if (e.target === ov) ov.remove(); });
  document.body.appendChild(ov); return ov;
}
const plain = (h) => R.stripHtml(h.replace(/\[sound:[^\]]+\]/g, '')).replace(/\s+/g, ' ').trim();
const answerPart = (a) => { const m = a.search(/<hr[^>]*id=["']?answer/i); return m >= 0 ? a.slice(a.indexOf('>', m) + 1) : a; };
const fmtDate = (t) => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

/* ================= HOME ================= */
async function renderHome(keepTab) {
  view = 'home'; session = null; tellParent(false);
  S = await R.getSettings();
  const now = Date.now(), today = R.dayStart(now);
  const [decks, sched, logs, extra, lastBackup] = await Promise.all([R.db.getAll('decks'), R.db.getAll('sched'), R.db.getAll('revlog'), R.getExtra(), R.db.get('meta', 'lastBackup')]);
  home = { decks, sched, logs, extra, lastBackup, now, today };
  const total = sched.length;
  $app.innerHTML = `<div class="wrap"><h1>Anki</h1><p class="sub">Import Anki decks and study them offline · ${total} cards</p>
    <div class="tabs" id="tabs">
      <button data-tab="practice">Practice</button><button data-tab="list">Word list</button><button data-tab="progress">Progress</button>
    </div><div id="tabbody"></div></div>`;
  document.getElementById('tabs').onclick = (e) => { const b = e.target.closest('button[data-tab]'); if (b) setTab(b.dataset.tab); };
  setTab(keepTab || tab);
}
function setTab(t) {
  tab = t; try { localStorage.setItem('recall.tab', t); } catch (e) { /* ignore */ }
  document.querySelectorAll('#tabs button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.tab === t)));
  const body = document.getElementById('tabbody');
  ({ practice: tabPractice, list: tabList, progress: tabProgress })[t](body);
}

function buildTree() {
  const root = { children: new Map() };
  for (const dk of home.decks) {
    let node = root, path = '';
    for (const part of dk.name.split('::')) {
      path = path ? path + '::' + part : part;
      if (!node.children.has(part)) node.children.set(part, { name: part, path, children: new Map(), ids: [] });
      node = node.children.get(part); node.ids.push(dk.id);
    }
  }
  return root;
}
const limitsFor = (path) => { const x = home.extra[path] || { n: 0, r: 0 }; return { newPerDay: S.newPerDay + x.n, revPerDay: S.revPerDay + x.r }; };

/* ---------- Practice ---------- */
function tabPractice(body) {
  const { decks, sched, logs, today, now } = home;
  const stats = R.dayStats(logs); const t = stats.get(today) || { n: 0, ms: 0 };
  const st = R.streaks(stats, S.goalCards, S.goalMin, today);
  const mins = Math.floor(t.ms / 60000);
  const byDeck = {}; for (const c of sched) (byDeck[c.deck] = byDeck[c.deck] || []).push(c);
  const introBy = {}, revBy = {};
  for (const l of logs) if (l.time >= today && l.prev === 2) revBy[l.deck] = (revBy[l.deck] || 0) + 1;
  for (const c of sched) if (c.intro >= today) introBy[c.deck] = (introBy[c.deck] || 0) + 1;
  const sum = (o, ids) => ids.reduce((s, id) => s + (o[id] || 0), 0);
  const all = R.countDeck(sched, now, sum(introBy, Object.keys(byDeck)), sum(revBy, Object.keys(byDeck)), limitsFor(''));
  const streakTxt = (k, ic) => k > 0 ? `<div class="strk on">${ic} ${k} day${k === 1 ? '' : 's'}</div>` : `<div class="strk">${ic} reach the goal today</div>`;
  const rows = [];
  const walk = (node, depth) => {
    const kids = [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    for (const n of kids) {
      const list = n.ids.flatMap(id => byDeck[id] || []);
      const cnt = R.countDeck(list, now, sum(introBy, n.ids), sum(revBy, n.ids), limitsFor(n.path));
      rows.push({ n, depth, cnt, has: n.children.size > 0 });
      if (n.children.size && !collapsed.has(n.path)) walk(n, depth + 1);
    }
  };
  const collapsed = new Set(JSON.parse(localStorage.getItem('recall.collapsed') || '[]'));
  walk(buildTree(), 0);
  const z = (v, c) => `<i class="${c}${v ? '' : ' z'}">${v}</i>`;
  const o = S;
  body.innerHTML = `
  <div class="panel"><h2>Today</h2>
    <div class="top"><div><b>${t.n}</b> / ${o.goalCards} cards</div>${streakTxt(st.cards, '🔥')}</div>
    <div class="bar"><i style="width:${Math.min(100, Math.round(t.n / o.goalCards * 100))}%"></i></div>
    <div class="top"><div><b>${mins}</b> / ${o.goalMin} min</div>${streakTxt(st.time, '⏱')}</div>
    <div class="bar t"><i style="width:${Math.min(100, Math.round(t.ms / 60000 / o.goalMin * 100))}%"></i></div>
    <p class="meta" style="margin:0 0 12px">Due for review: ${all.due} · New: ${all.new} · Learning: ${all.learn}</p>
    <button class="btn" id="startAll" ${decks.length ? '' : 'disabled'}>Start today’s session</button>
    <p class="meta" style="margin:10px 0 0">Studies every deck: cards that are due first, then new ones. Cards you miss come back sooner.</p>
  </div>
  <div class="panel"><h2>Decks</h2>
    ${decks.length ? `<div class="cnthead"><span>New</span><span>Learn</span><span>Due</span></div><div class="decks">${rows.map(r => `
      <div class="dk" style="padding-left:${r.depth * 16}px"><button class="chev ${r.has ? '' : 'empty'}" data-toggle="${esc(r.n.path)}">${collapsed.has(r.n.path) ? '▶' : '▼'}</button>
      <button class="name" data-study="${esc(r.n.path)}">${esc(r.n.name)}</button>
      <div class="cnt">${z(r.cnt.new, 'n')}${z(r.cnt.learn, 'l')}${z(r.cnt.due, 'd')}</div>
      <button class="more" data-menu="${esc(r.n.path)}" aria-label="Deck options">⋯</button></div>`).join('')}</div>`
      : `<div class="empty-state"><div style="font-size:44px">🗂️</div><p>No decks yet. Import an Anki <b>.apkg</b> file. It stays on this device and works offline.</p></div>`}
    <div class="row"><button class="btn ${decks.length ? 'ghost' : ''}" id="impBtn">＋ Import deck</button></div>
    <p class="meta" style="margin:10px 0 0">In Anki: File → Export → “Anki Deck Package (.apkg)”, with media included.</p>
  </div>
  <div class="panel"><h2>Practice options</h2>
    <div class="row" style="margin-top:0"><label>New cards / day <input type="number" id="o-new" min="0" value="${o.newPerDay}"></label>
      <label>Max reviews / day <input type="number" id="o-rev" min="0" value="${o.revPerDay}"></label></div>
    <div class="row"><label>Daily card goal <input type="number" id="o-gc" min="1" value="${o.goalCards}"></label>
      <label>Daily minutes <input type="number" id="o-gm" min="1" value="${o.goalMin}"></label></div>
    <div class="row"><label>Learning steps (min) <input type="text" id="o-steps" style="width:90px" value="${o.steps.join(' ')}"></label>
      <label>Relearning <input type="text" id="o-rel" style="width:70px" value="${o.relearn.join(' ')}"></label></div>
    <div class="row"><label><input type="checkbox" id="o-r3" ${o.rate3 ? 'checked' : ''}> Three rating buttons (Again / Good / Easy)</label></div>
    <div class="row"><label><input type="checkbox" id="o-intro" ${o.intro ? 'checked' : ''}> Show new cards first, then quiz me on them a few cards later</label></div>
    <div class="row"><label><input type="checkbox" id="o-auto" ${o.autoplay ? 'checked' : ''}> Play card audio automatically</label></div>
    <p class="meta" style="margin:10px 0 0">Run out of cards for today? When a session ends you can add more new cards or reviews, or study ahead.</p>
  </div>`;
  body.querySelector('#startAll').onclick = () => startStudy('');
  body.querySelectorAll('[data-study]').forEach(b => b.onclick = () => startStudy(b.dataset.study));
  body.querySelectorAll('[data-toggle]').forEach(b => b.onclick = () => {
    const p = b.dataset.toggle; collapsed.has(p) ? collapsed.delete(p) : collapsed.add(p);
    localStorage.setItem('recall.collapsed', JSON.stringify([...collapsed])); tabPractice(body);
  });
  body.querySelectorAll('[data-menu]').forEach(b => b.onclick = () => deckMenu(b.dataset.menu));
  body.querySelector('#impBtn').onclick = () => document.getElementById('file').click();
  const parse = (v, fb) => { const a = v.split(/[\s,]+/).map(Number).filter(x => x > 0); return a.length ? a : fb; };
  const save = async () => {
    S = { ...S, newPerDay: Math.max(0, +body.querySelector('#o-new').value || 0), revPerDay: Math.max(0, +body.querySelector('#o-rev').value || 0),
      goalCards: Math.max(1, +body.querySelector('#o-gc').value || 50), goalMin: Math.max(1, +body.querySelector('#o-gm').value || 20),
      steps: parse(body.querySelector('#o-steps').value, [1, 10]), relearn: parse(body.querySelector('#o-rel').value, [10]),
      rate3: body.querySelector('#o-r3').checked, intro: body.querySelector('#o-intro').checked, autoplay: body.querySelector('#o-auto').checked };
    await R.db.put('meta', S, 'settings');
  };
  body.querySelectorAll('.panel:last-child input').forEach(i => i.onchange = async () => {
    await save(); toast('Saved', 1200);
    if (/^o-(new|rev|gc|gm)$/.test(i.id)) {
      // refresh the numbers above, but never while the user is still working in another field
      setTimeout(() => { const a = document.activeElement; if (view === 'home' && tab === 'practice' && (!a || a === document.body || !/INPUT|SELECT|TEXTAREA/.test(a.tagName))) renderHome('practice'); }, 900);
    }
  });
}

function deckMenu(path) {
  const ids = home.decks.filter(x => x.name === path || x.name.startsWith(path + '::')).map(x => x.id);
  const nCards = home.sched.filter(c => ids.includes(c.deck)).length;
  const ov = sheet(`<h2>${esc(path)}</h2>
    <p class="meta" style="margin:0 0 6px">Raise today’s limit for this deck (resets tomorrow)</p>
    <div class="field"><span>Extra new cards</span><input type="number" id="x-n" min="0" value="10"></div>
    <div class="field"><span>Extra reviews</span><input type="number" id="x-r" min="0" value="50"></div>
    <div class="row"><button class="btn" id="x-apply">Add to today’s limit</button></div>
    <p class="meta" style="margin:16px 0 6px">Study ahead: review cards before they are due</p>
    <div class="seg" id="x-ahead"><button data-d="1">1 day</button><button data-d="3">3 days</button><button data-d="7">7 days</button></div>
    <div class="row" style="margin-top:20px"><button class="btn ghost" id="x-close">Close</button><button class="btn bad" id="x-del">Delete deck</button></div>`);
  ov.querySelector('#x-close').onclick = () => ov.remove();
  ov.querySelector('#x-apply').onclick = async () => {
    await R.addExtra(path, Math.max(0, +ov.querySelector('#x-n').value || 0), Math.max(0, +ov.querySelector('#x-r').value || 0));
    ov.remove(); toast('Today’s limit raised'); renderHome('practice');
  };
  ov.querySelectorAll('#x-ahead button').forEach(b => b.onclick = () => { ov.remove(); startStudy(path, { ahead: +b.dataset.d }); });
  ov.querySelector('#x-del').onclick = async () => {
    if (!confirm(`Delete "${path}" and its ${nCards} cards, including your progress? This can't be undone. (Save a backup first if unsure.)`)) return;
    ov.remove(); await R.deleteDecks(ids); toast('Deck deleted'); renderHome('practice');
  };
}

/* ---------- Word list ---------- */
const wl = { deck: '', stat: 'all', q: '', limit: 100, items: null, key: '' };
const statusOf = (c) => c.state === 0 ? 'new' : c.state === 2 ? (c.ivl >= 21 ? 'mastered' : 'review') : 'learning';
async function tabList(body) {
  const paths = []; const walk = (n) => { for (const k of [...n.children.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))) { paths.push(k.path); walk(k); } };
  walk(buildTree());
  if (!home.decks.length) { body.innerHTML = '<div class="panel"><p class="meta" style="margin:0">Import a deck first to see its cards here.</p></div>'; return; }
  if (!paths.includes(wl.deck)) wl.deck = paths[0];
  body.innerHTML = `<div class="panel"><h2>Cards</h2>
    <select id="wl-deck">${paths.map(p => `<option value="${esc(p)}" ${p === wl.deck ? 'selected' : ''}>${esc('  '.repeat(p.split('::').length - 1) + p.split('::').pop())}</option>`).join('')}</select>
    <div class="row" style="margin-top:10px"><input type="search" id="wl-q" placeholder="Search a card…" value="${esc(wl.q)}"></div>
    <div class="seg" style="margin-top:10px" id="wl-stat">${['all', 'new', 'learning', 'review', 'mastered'].map(s => `<button data-s="${s}" aria-pressed="${wl.stat === s}">${s[0].toUpperCase() + s.slice(1)}</button>`).join('')}</div>
    <p class="meta" id="wl-count" style="margin:10px 0 4px"></p><div id="wl-rows"></div>
    <div class="row"><button class="btn ghost" id="wl-more" style="display:none">Show more</button></div></div>`;
  const schedMap = new Map(home.sched.map(c => [c.id, c]));
  const load = async () => {
    const ids = home.decks.filter(x => x.name === wl.deck || x.name.startsWith(wl.deck + '::')).map(x => x.id);
    const items = [];
    for (const id of ids) for (const c of await R.db.getByIndex('cards', 'deck', id)) items.push({ id: c.id, q: plain(c.q), a: plain(answerPart(c.a)) });
    items.sort((a, b) => (schedMap.get(a.id)?.seq ?? 0) - (schedMap.get(b.id)?.seq ?? 0));
    wl.items = items; wl.key = wl.deck;
  };
  const draw = () => {
    const q = wl.q.trim().toLowerCase();
    const list = wl.items.filter(i => (wl.stat === 'all' || statusOf(schedMap.get(i.id)) === wl.stat) && (!q || i.q.toLowerCase().includes(q) || i.a.toLowerCase().includes(q)));
    body.querySelector('#wl-count').textContent = `${list.length} card${list.length === 1 ? '' : 's'}`;
    body.querySelector('#wl-rows').innerHTML = list.slice(0, wl.limit).map(i => `<div class="wl" data-id="${esc(i.id)}"><button class="h"><span class="dot s-${statusOf(schedMap.get(i.id))}"></span><span class="t">${esc(i.q.slice(0, 120) || '(empty)')}</span></button></div>`).join('');
    const more = body.querySelector('#wl-more'); more.style.display = list.length > wl.limit ? '' : 'none';
    more.onclick = () => { wl.limit += 100; draw(); };
    body.querySelectorAll('#wl-rows .wl').forEach(row => row.querySelector('.h').onclick = () => {
      const ex = row.querySelector('.ans'); if (ex) { ex.remove(); return; }
      const it = wl.items.find(x => x.id === row.dataset.id);
      const d = document.createElement('div'); d.className = 'ans';
      d.innerHTML = `${esc(it.a || '(no answer text)')}<div class="row"><button class="btn ghost sm" data-k>I know this</button><button class="btn ghost sm" data-r>Reset</button></div>`;
      row.appendChild(d);
      d.querySelector('[data-k]').onclick = async () => {
        const c = schedMap.get(it.id); const t0 = R.dayStart(); const n = { ...c, state: 2, ivl: 21, ease: Math.max(c.ease, 2.5), due: t0 + 21 * R.DAY, reps: c.reps + 1, intro: c.intro || Date.now() };
        schedMap.set(it.id, n); home.sched = home.sched.map(x => x.id === n.id ? n : x); await R.db.put('sched', n); draw(); toast('Marked as known');
      };
      d.querySelector('[data-r]').onclick = async () => {
        const c = schedMap.get(it.id); const n = { ...c, state: 0, due: 0, ivl: 0, ease: 2.5, reps: 0, lapses: 0, step: 0, intro: 0 };
        schedMap.set(it.id, n); home.sched = home.sched.map(x => x.id === n.id ? n : x); await R.db.put('sched', n); draw(); toast('Reset to new');
      };
    });
  };
  const refresh = async () => { if (wl.key !== wl.deck || !wl.items) await load(); draw(); };
  body.querySelector('#wl-deck').onchange = (e) => { wl.deck = e.target.value; wl.limit = 100; refresh(); };
  body.querySelector('#wl-q').oninput = (e) => { wl.q = e.target.value; wl.limit = 100; draw(); };
  body.querySelectorAll('#wl-stat button').forEach(b => b.onclick = () => { wl.stat = b.dataset.s; wl.limit = 100; body.querySelectorAll('#wl-stat button').forEach(x => x.setAttribute('aria-pressed', String(x === b))); draw(); });
  refresh();
}

/* ---------- Progress & backup ---------- */
function tabProgress(body) {
  const { sched, logs, today, lastBackup } = home;
  const stats = R.dayStats(logs);
  const days = []; let d = today; for (let i = 0; i < 14; i++) { days.unshift(d); d = R.dayStart(d - 1); }
  const max = Math.max(1, ...days.map(x => (stats.get(x) || { n: 0 }).n));
  const cnt = { new: 0, learning: 0, review: 0, mastered: 0 }; for (const c of sched) cnt[statusOf(c)]++;
  const tot = Math.max(1, sched.length); const pc = (v) => (v / tot * 100).toFixed(1) + '%';
  const totalMin = Math.round([...stats.values()].reduce((s, x) => s + x.ms, 0) / 60000);
  body.innerHTML = `
  <div class="panel"><h2>Last 14 days</h2>
    <div class="chart">${days.map(x => { const o = stats.get(x); const n = o ? o.n : 0; return `<div title="${n} cards"><span>${n || ''}</span><i class="${n ? '' : 'z'}" style="height:${Math.round(n / max * 70)}px"></i></div>`; }).join('')}</div>
    <p class="meta" style="margin:10px 0 0">${logs.length} reviews in total · about ${totalMin} min studied</p></div>
  <div class="panel"><h2>Your cards</h2>
    <div class="stack"><i style="width:${pc(cnt.mastered)};background:var(--ok)"></i><i style="width:${pc(cnt.review)};background:var(--hard)"></i><i style="width:${pc(cnt.learning)};background:var(--learn)"></i><i style="width:${pc(cnt.new)};background:var(--new)"></i></div>
    <div class="legend"><span><b>${cnt.mastered}</b> mastered</span><span><b>${cnt.review}</b> reviewing</span><span><b>${cnt.learning}</b> learning</span><span><b>${cnt.new}</b> new</span></div>
    <p class="meta" style="margin:10px 0 0">Mastered = the next review is 21+ days away.</p></div>
  <div class="panel"><h2>Backup</h2>
    <p class="meta" style="margin:0 0 6px">Your decks and progress live only on this device. A backup lets you restore them if the browser clears its data.</p>
    <p class="meta" style="margin:0 0 12px">${lastBackup ? 'Last backup: ' + fmtDate(lastBackup) : '<b style="color:var(--hard)">No backup yet.</b>'}</p>
    <div class="row" style="margin-top:0"><button class="btn" id="bk-prog">Save progress backup</button></div>
    <p class="meta" style="margin:6px 0 12px">Small file. To restore, import the same deck file again and load this backup (or load it first; it attaches when the deck is imported).</p>
    <div class="row" style="margin-top:0"><button class="btn ghost" id="bk-full">Save full backup (decks + media)</button></div>
    <p class="meta" style="margin:6px 0 12px">Everything in one file, restorable on its own. Can be large if your decks have lots of audio.</p>
    <div class="row" style="margin-top:0"><button class="btn ghost" id="bk-rest">Restore from file…</button><button class="btn ghost" id="bk-keep">Keep my data</button></div>
    <p class="meta" style="margin:12px 0 0">Anki mode version ${R.VERSION}</p></div>`;
  body.querySelector('#bk-prog').onclick = async () => {
    const data = await R.exportProgress();
    const n = Object.values(data.pkgs).reduce((s, p) => s + p.s.length, 0);
    saveFile(new Blob([JSON.stringify(data)], { type: 'application/json' }), `flanna-anki-progress-${new Date().toISOString().slice(0, 10)}.json`, `${n} cards with progress`);
  };
  body.querySelector('#bk-full').onclick = async () => {
    const ov = busy('Preparing backup…');
    try { const blob = await R.exportFull(m => ov.msg(m)); ov.close(); saveFile(blob, `flanna-anki-full-${new Date().toISOString().slice(0, 10)}.zip`, 'decks, media and progress'); }
    catch (e) { ov.close(); alert('Backup failed: ' + (e.message || e)); }
  };
  body.querySelector('#bk-rest').onclick = () => document.getElementById('rfile').click();
  body.querySelector('#bk-keep').onclick = async () => {
    const ok = navigator.storage && navigator.storage.persist ? await navigator.storage.persist() : false;
    toast(ok ? 'Your browser will keep this data' : 'Not granted. Adding Flanna to the Home Screen helps, and so do backups.', 3500);
  };
}

function busy(text) {
  const ov = document.createElement('div'); ov.className = 'overlay';
  ov.innerHTML = `<div class="sheet" style="text-align:center"><div class="spinner"></div><div class="bm" style="white-space:pre-line">${esc(text)}</div></div>`;
  document.body.appendChild(ov);
  return { msg: (t) => { const e = ov.querySelector('.bm'); if (e) e.textContent = t; }, close: () => ov.remove() };
}
function saveFile(blob, name, what) {
  const ov = sheet(`<h2>Backup ready</h2><p class="meta" style="margin:0 0 14px">${esc(what)} · ${(blob.size / 1048576).toFixed(blob.size > 1e6 ? 1 : 2)} MB. Save it somewhere safe, like Files or iCloud Drive.</p>
    <div class="row"><button class="btn ghost" id="sf-x">Cancel</button><button class="btn" id="sf-go">Save file</button></div>`);
  ov.querySelector('#sf-x').onclick = () => ov.remove();
  ov.querySelector('#sf-go').onclick = async () => {
    try {
      const f = new File([blob], name, { type: blob.type });
      if (navigator.canShare && navigator.canShare({ files: [f] })) { await navigator.share({ files: [f] }); }
      else { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000); }
    } catch (e) { if (e && e.name === 'AbortError') return; const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => a.remove(), 4000); }
    await R.db.put('meta', Date.now(), 'lastBackup'); ov.remove(); toast('Backup saved'); if (view === 'home') renderHome('progress');
  };
}

/* ================= import / restore ================= */
async function doImport(files) {
  files = [...files].filter(f => /\.(apkg|colpkg|zip)$/i.test(f.name));
  if (!files.length) { toast('Please choose an .apkg file'); return; }
  const ov = busy('Starting…');
  try {
    for (const f of files) {
      const r = await R.importApkg(f, (t) => ov.msg(files.length > 1 ? `${f.name}\n${t}` : t));
      toast(`Imported ${r.cards} cards${r.media ? ` and ${r.media} media files` : ''}`, 3500);
    }
  } catch (e) { console.error(e); alert('Import failed: ' + (e.message || e)); }
  finally { ov.close(); if (view === 'home') renderHome('practice'); }
}
async function doRestore(file) {
  const ov = busy('Restoring…');
  try {
    const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());
    if (head[0] === 0x50 && head[1] === 0x4b) { const r = await R.restoreFull(file, m => ov.msg(m)); toast(`Restored everything (${r.media} media files)`, 3500); }
    else {
      const r = await R.restoreProgress(JSON.parse(await file.text()));
      toast(r.waiting ? `Progress restored for ${r.applied} deck file(s). ${r.waiting} more will attach when you import their .apkg.` : `Progress restored for ${r.applied} deck file(s).`, 5000);
    }
  } catch (e) { console.error(e); alert('Restore failed: ' + (e.message || e)); }
  finally { ov.close(); if (view === 'home') renderHome('progress'); }
}
document.getElementById('file').addEventListener('change', e => { const f = e.target.files; if (f.length) doImport(f); e.target.value = ''; });
document.getElementById('rfile').addEventListener('change', e => { const f = e.target.files[0]; if (f) doRestore(f); e.target.value = ''; });
(() => {
  const drop = document.createElement('div'); drop.className = 'drop'; drop.textContent = 'Drop a deck (.apkg) to import'; document.body.appendChild(drop);
  let n = 0;
  addEventListener('dragenter', e => { e.preventDefault(); n++; drop.classList.add('on'); });
  addEventListener('dragleave', e => { e.preventDefault(); if (--n <= 0) { n = 0; drop.classList.remove('on'); } });
  addEventListener('dragover', e => e.preventDefault());
  addEventListener('drop', e => { e.preventDefault(); n = 0; drop.classList.remove('on'); if (e.dataTransfer.files.length && view === 'home') doImport(e.dataTransfer.files); });
})();

/* ================= STUDY ================= */
async function startStudy(path, opts = {}) {
  S = await R.getSettings();
  const decks = (await R.db.getAll('decks')).filter(d => !path || d.name === path || d.name.startsWith(path + '::'));
  const ids = new Set(decks.map(d => d.id));
  const sched = (await R.db.getAll('sched')).filter(c => ids.has(c.deck));
  const today = R.dayStart();
  const logs = (await R.db.revlogSince(today)).filter(l => ids.has(l.deck));
  const x = (await R.getExtra())[path] || { n: 0, r: 0 };
  session = {
    path, ids, cards: new Map(sched.map(c => [c.id, c])),
    introduced: sched.filter(c => c.intro >= today).length,
    reviewed: logs.filter(l => l.prev === 2).length,
    answered: logs.length, extraNew: x.n, extraRev: x.r, undo: null, cur: null, showing: 'q', t0: 0,
    shown: 0, hold: new Map(), aheadUntil: opts.ahead ? R.dayStart() + R.DAY - 1 + opts.ahead * R.DAY : 0, introCard: false,
  };
  view = 'study'; tellParent(true); nextCard();
}

function pickNext() {
  const now = Date.now(), end = R.dayStart(now) + R.DAY - 1;
  let learn = null, held = null, lAhead = null, rev = null, nw = null, ahead = null;
  let nL = 0, nR = 0, nN = 0, futureRev = 0;
  for (const c of session.cards.values()) {
    if (c.state === 0) { nN++; if (!nw || c.seq < nw.seq) nw = c; }
    else if (c.state === 2) {
      if (c.due <= end) { nR++; if (!rev || c.due < rev.due || (c.due === rev.due && c.seq < rev.seq)) rev = c; }
      else { futureRev++; if (session.aheadUntil && c.due <= session.aheadUntil && (!ahead || c.due < ahead.due)) ahead = c; }
    } else if (c.due <= end) {
      nL++;
      if (c.due <= now) {
        const h = session.hold.get(c.id);
        if (h !== undefined && h > session.shown) { if (!held || c.due < held.due) held = c; }
        else if (!learn || c.due < learn.due) learn = c;
      } else if (c.due <= now + 20 * 60000 && (!lAhead || c.due < lAhead.due)) lAhead = c;
    }
  }
  const newLeft = Math.max(0, S.newPerDay + session.extraNew - session.introduced);
  const revLeft = Math.max(0, S.revPerDay + session.extraRev - session.reviewed);
  const counts = { new: Math.min(nN, newLeft), learn: nL, due: Math.min(nR, revLeft), totalNew: nN, extraRev: Math.max(0, nR - revLeft), futureRev };
  const card = learn || (revLeft > 0 ? rev : null) || (newLeft > 0 ? nw : null) || ahead || held || lAhead;
  return { card, counts };
}

async function nextCard() {
  const { card, counts } = pickNext();
  if (!card) return renderDone(counts);
  session.cur = card; session.showing = 'q'; session.t0 = Date.now(); session.shown++;
  session.introCard = !!(S.intro && card.state === 0);
  renderStudyFrame(counts);
  await showSide(session.introCard ? 'a' : 'q');
}

function studyShell(counts) {
  const cur = session.cur; const k = cur ? (cur.state === 0 ? 'n' : cur.state === 2 ? 'd' : 'l') : '';
  return `<div class="study"><div class="sbar"><button class="iconbtn" id="s-back" aria-label="Back">←</button>
    <div class="title">${esc(session.path ? session.path.split('::').pop() : 'All decks')}</div>
    <button class="iconbtn" id="s-undo" aria-label="Undo" ${session.undo ? '' : 'disabled'}>↶</button></div>
    <div class="scnt"><span style="color:var(--new)" class="${k === 'n' ? 'cur' : ''}">${counts.new}</span>
    <span style="color:var(--learn)" class="${k === 'l' ? 'cur' : ''}">${counts.learn}</span>
    <span style="color:var(--due)" class="${k === 'd' ? 'cur' : ''}">${counts.due}</span></div>`;
}
function renderStudyFrame(counts) {
  $app.innerHTML = studyShell(counts) + `<div class="cardwrap"><iframe id="cf" sandbox="allow-same-origin" title="Card"></iframe></div><div class="actions" id="actions"></div></div>`;
  document.getElementById('s-back').onclick = () => renderHome('practice');
  document.getElementById('s-undo').onclick = undo;
}

function cardDoc(body, css) {
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  return `<!doctype html><html class="${dark ? 'night_mode' : ''}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <style>html,body{margin:0}.rc-wrap{min-height:calc(100vh - 36px);display:flex;flex-direction:column;justify-content:center}body{box-sizing:border-box;padding:18px 16px;
  font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-size:20px;text-align:center;color:${dark ? '#f1efe8' : '#1d1d1b'};background:transparent;overflow-wrap:anywhere}
  img{max-width:100%;height:auto}audio,video{max-width:100%}hr{width:100%;border:0;border-top:1px solid ${dark ? '#3a3935' : '#e2e0d8'}}
  .cloze{font-weight:700;color:#0b7fc0}.typeans{font:inherit;padding:6px 10px;border-radius:8px;border:1px solid #8886;background:transparent;color:inherit;max-width:100%}
  details.hint summary{color:#0b7fc0;cursor:pointer}</style><style>${css}</style></head>
  <body class="card ${dark ? 'nightMode night_mode' : ''}"><div class="rc-wrap"><div>${body}</div></div></body></html>`;
}

const modelCss = new Map();
async function showSide(side) {
  const c = session.cur; if (!c) return;
  session.showing = side;
  const content = await R.db.get('cards', c.id);
  if (!content) { session.cards.delete(c.id); return nextCard(); }
  let css = modelCss.get(content.mid);
  if (css === undefined) { const m = await R.db.get('models', content.mid); css = await R.resolveCss((m && m.css) || '', content.imp); modelCss.set(content.mid, css); }
  const html = await R.resolveHtml(side === 'q' ? content.q : content.a, content.imp);
  if (session.cur !== c) return;
  const f = document.getElementById('cf'); if (!f) return;
  f.onload = () => {
    const doc = f.contentDocument; if (!doc) return;
    doc.addEventListener('keydown', onKey);
    if (side === 'a') { const a = doc.getElementById('answer'); if (a) a.scrollIntoView(); }
    if (S.autoplay) {
      let au = null;
      if (side === 'q' || session.introCard) au = doc.querySelector('audio');
      else { const a = doc.getElementById('answer'); au = a ? [...doc.querySelectorAll('audio')].find(x => a.compareDocumentPosition(x) & Node.DOCUMENT_POSITION_FOLLOWING) : null; }
      if (au) au.play().catch(() => {});
    }
  };
  f.srcdoc = cardDoc(html, css);
  const act = document.getElementById('actions');
  if (session.introCard) {
    act.innerHTML = '<div class="rate c2"><button class="r3" id="i-got">Got it<small>quiz me soon</small></button><button class="r4" id="i-know">I already know it<small>skip</small></button></div>';
    document.getElementById('i-got').onclick = introGot; document.getElementById('i-know').onclick = introKnow;
  } else if (side === 'q') {
    act.innerHTML = '<button class="btn big" id="show">Show answer</button>';
    document.getElementById('show').onclick = () => showSide('a');
  } else {
    const now = Date.now(); const rs = S.rate3 ? [1, 3, 4] : [1, 2, 3, 4];
    act.innerHTML = `<div class="rate c${rs.length}">${rs.map(r => `<button class="r${r}" data-r="${r}">${NAMES[r]}<small>${R.previewLabel(c, r, now, S)}</small></button>`).join('')}</div>`;
    act.querySelectorAll('button').forEach(b => b.onclick = () => answer(+b.dataset.r));
  }
}

async function commit(prev, n, rating) {
  const now = Date.now();
  session.cards.set(n.id, n);
  if (prev.state === 0) session.introduced++;
  if (prev.state === 2) session.reviewed++;
  session.answered++;
  await R.db.put('sched', n);
  const key = await R.db.add('revlog', { card: n.id, deck: n.deck, time: now, rating, prev: prev.state, ivl: n.ivl, ms: now - session.t0 });
  session.undo = { prev, key };
  nextCard();
}
async function answer(rating) {
  const c = session.cur; if (!c || session.showing !== 'a' || session.introCard) return;
  await commit({ ...c }, R.schedule(c, rating, Date.now(), S), rating);
}
async function introGot() {
  const c = session.cur; const now = Date.now();
  const n = { ...c, state: 1, step: 0, due: now, intro: now, reps: c.reps + 1 };
  session.hold.set(c.id, session.shown + 4);
  await commit({ ...c }, n, 3);
}
async function introKnow() {
  const c = session.cur; const now = Date.now();
  await commit({ ...c }, { ...c, state: 2, ivl: 21, due: R.dayStart(now) + 21 * R.DAY, step: 0, intro: now, reps: c.reps + 1 }, 4);
}
async function undo() {
  const u = session.undo; if (!u) return;
  session.cards.set(u.prev.id, u.prev); session.hold.delete(u.prev.id);
  await R.db.put('sched', u.prev); await R.db.del('revlog', u.key);
  if (u.prev.state === 0) session.introduced--;
  if (u.prev.state === 2) session.reviewed--;
  session.answered--; session.undo = null;
  const { counts } = pickNext();
  session.cur = u.prev; session.showing = 'q'; session.t0 = Date.now();
  session.introCard = !!(S.intro && u.prev.state === 0);
  renderStudyFrame(counts); await showSide(session.introCard ? 'a' : 'q');
}

function renderDone(counts) {
  session.cur = null;
  const btn = (id, txt) => `<button class="btn ${id === 'home' ? 'ghost' : ''} big" id="${id}">${txt}</button>`;
  $app.innerHTML = studyShell(counts) + `<div class="done"><div class="big">🎉</div><h2>All done for now</h2>
    <p>${session.answered ? `You reviewed ${session.answered} card${session.answered === 1 ? '' : 's'} today.` : 'Nothing is due right now.'}</p>
    ${counts.totalNew > 0 ? btn('more10', 'Add 10 more new cards') + btn('more20', 'Add 20 more new cards') : ''}
    ${counts.extraRev > 0 ? btn('moreR', `Add 50 more reviews (${counts.extraRev} waiting)`) : ''}
    ${counts.futureRev > 0 && !session.aheadUntil ? btn('ahead', 'Study ahead (cards due in the next 3 days)') : ''}
    ${btn('home', 'Back to decks')}</div></div>`;
  document.getElementById('s-back').onclick = () => renderHome('practice');
  document.getElementById('home').onclick = () => renderHome('practice');
  document.getElementById('s-undo').onclick = undo;
  const addMore = async (n, r) => { await R.addExtra(session.path, n, r); session.extraNew += n; session.extraRev += r; nextCard(); };
  const g = (id) => document.getElementById(id);
  if (g('more10')) g('more10').onclick = () => addMore(10, 0);
  if (g('more20')) g('more20').onclick = () => addMore(20, 0);
  if (g('moreR')) g('moreR').onclick = () => addMore(0, 50);
  if (g('ahead')) g('ahead').onclick = () => { session.aheadUntil = R.dayStart() + R.DAY - 1 + 3 * R.DAY; nextCard(); };
}

function onKey(e) {
  if (view !== 'study' || !session || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target && e.target.tagName === 'INPUT' && e.key !== 'Enter') return;
  if (session.cur && session.introCard) {
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); introGot(); } else if (e.key === 'k' || e.key === 'K') introKnow();
  } else if (session.cur && session.showing === 'q' && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); showSide('a'); }
  else if (session.cur && session.showing === 'a') {
    const rs = S.rate3 ? [1, 3, 4] : [1, 2, 3, 4]; const i = +e.key;
    if (i >= 1 && i <= rs.length) answer(rs[i - 1]);
    else if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); answer(3); }
  }
  if ((e.key === 'z' || e.key === 'Z') && session.undo) undo();
}
document.addEventListener('keydown', onKey);

/* ================= boot ================= */
(async () => {
  try { await R.db.open(); await renderHome(); }
  catch (e) { $app.innerHTML = `<div class="wrap"><div class="panel"><h2>Storage unavailable</h2><p class="meta">${esc(e.message || e)}<br>Private browsing can block local storage.</p></div></div>`; }
})();
