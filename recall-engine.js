'use strict';
/* Recall engine: storage, .apkg import, template rendering, scheduler */
const R = {};
R.DAY = 86400000;
R.dayStart = (t = Date.now()) => {
  const d = new Date(t - 4 * 3600e3); d.setHours(0, 0, 0, 0); return d.getTime() + 4 * 3600e3;
};
R.dec = (u8) => new TextDecoder().decode(u8);

/* ---------------- IndexedDB ---------------- */
R.db = {
  _db: null,
  open() {
    if (this._db) return Promise.resolve(this._db);
    return new Promise((res, rej) => {
      const rq = indexedDB.open('recall', 2);
      rq.onupgradeneeded = () => {
        const d = rq.result, tx = rq.transaction;
        const mk = (n, o) => (d.objectStoreNames.contains(n) ? tx.objectStore(n) : d.createObjectStore(n, o));
        const idx = (st, n, k) => { if (!st.indexNames.contains(n)) st.createIndex(n, k); };
        mk('decks', { keyPath: 'id' });
        idx(mk('cards', { keyPath: 'id' }), 'deck', 'deck');
        idx(mk('sched', { keyPath: 'id' }), 'deck', 'deck');
        mk('models', { keyPath: 'key' }); mk('media'); mk('meta');
        idx(mk('revlog', { autoIncrement: true }), 'time', 'time');
        mk('imports', { keyPath: 'hash' });
      };
      rq.onsuccess = () => { this._db = rq.result; res(this._db); };
      rq.onerror = () => rej(rq.error);
    });
  },
  async _tx(stores, mode, fn) {
    const d = await this.open();
    return new Promise((res, rej) => {
      const tx = d.transaction(stores, mode);
      let out;
      tx.oncomplete = () => res(out);
      tx.onerror = tx.onabort = () => rej(tx.error || new Error('tx failed'));
      out = fn(tx);
    });
  },
  _req(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); },
  async get(store, key) { const d = await this.open(); return this._req(d.transaction(store).objectStore(store).get(key)); },
  async getAll(store) { const d = await this.open(); return this._req(d.transaction(store).objectStore(store).getAll()); },
  async put(store, val, key) { const d = await this.open(); return this._req(d.transaction(store, 'readwrite').objectStore(store).put(val, key)); },
  async add(store, val) { const d = await this.open(); return this._req(d.transaction(store, 'readwrite').objectStore(store).add(val)); },
  async del(store, key) { const d = await this.open(); return this._req(d.transaction(store, 'readwrite').objectStore(store).delete(key)); },
  putMany(store, items) { return this._tx([store], 'readwrite', tx => { const s = tx.objectStore(store); items.forEach(i => s.put(i)); }); },
  putManyKeyed(store, pairs) { return this._tx([store], 'readwrite', tx => { const s = tx.objectStore(store); pairs.forEach(([k, v]) => s.put(v, k)); }); },
  async revlogSince(t) {
    const d = await this.open();
    return this._req(d.transaction('revlog').objectStore('revlog').index('time').getAll(IDBKeyRange.lowerBound(t)));
  },
  addMany(store, items) { return this._tx([store], 'readwrite', tx => { const s = tx.objectStore(store); items.forEach(i => s.add(i)); }); },
  async getByIndex(store, index, key) { const d = await this.open(); return this._req(d.transaction(store).objectStore(store).index(index).getAll(IDBKeyRange.only(key))); },
  async metaAll() {
    const d = await this.open();
    return new Promise((res, rej) => {
      const out = []; const rq = d.transaction('meta').objectStore('meta').openCursor();
      rq.onsuccess = () => { const c = rq.result; if (c) { out.push([c.key, c.value]); c.continue(); } else res(out); };
      rq.onerror = () => rej(rq.error);
    });
  },
  async mediaKeys() { const d = await this.open(); return this._req(d.transaction('media').objectStore('media').getAllKeys()); },
};

/* ---------------- tiny protobuf reader ---------------- */
R.pb = (buf) => {
  const f = {}; let i = 0; const n = buf.length;
  const varint = () => { let r = 0, s = 0, b; do { b = buf[i++]; r += (b & 0x7f) * Math.pow(2, s); s += 7; } while (b & 0x80); return r; };
  while (i < n) {
    const key = varint(), no = Math.floor(key / 8), wt = key & 7; let v;
    if (wt === 0) v = varint();
    else if (wt === 2) { const l = varint(); v = buf.subarray(i, i + l); i += l; }
    else if (wt === 5) { v = buf.subarray(i, i + 4); i += 4; }
    else if (wt === 1) { v = buf.subarray(i, i + 8); i += 8; }
    else break;
    (f[no] = f[no] || []).push(v);
  }
  return f;
};

/* ---------------- template rendering ---------------- */
const EMPTY_RE = /^(?:\s|​|<\/?(?:br|div)\s?\/?>)*$/i;
R.isEmpty = (s) => s === undefined || s === null || EMPTY_RE.test(s);
R.stripHtml = (s) => s.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim();

R.cloze = function clozeProc(s, n, ans) {
  let out = '', i = 0;
  while (i < s.length) {
    const m = /\{\{c(\d+)::/.exec(s.slice(i));
    if (!m) { out += s.slice(i); break; }
    const start = i + m.index; out += s.slice(i, start);
    let j = start + m[0].length, depth = 1;
    while (j < s.length) {
      if (s.startsWith('{{', j)) { depth++; j += 2; }
      else if (s.startsWith('}}', j)) { depth--; if (depth === 0) break; j += 2; }
      else j++;
    }
    if (depth !== 0) { out += s.slice(start); break; }
    const inner = s.slice(start + m[0].length, j); i = j + 2;
    const k = +m[1]; let text = inner, hint = '';
    const hi = inner.lastIndexOf('::');
    if (hi >= 0 && !inner.slice(hi).includes('{{')) { text = inner.slice(0, hi); hint = inner.slice(hi + 2); }
    text = clozeProc(text, n, ans);
    if (k === n) out += ans ? `<span class="cloze">${text}</span>` : `<span class="cloze">[${hint || '...'}]</span>`;
    else out += text;
  }
  return out;
};

R.renderTpl = function (tpl, F, ctx) {
  let s = tpl;
  const special = (k) => {
    switch (k) {
      case 'FrontSide': return ctx.front || '';
      case 'Tags': return ctx.tags || '';
      case 'Deck': return ctx.deck || '';
      case 'Subdeck': return (ctx.deck || '').split('::').pop();
      case 'Card': return ctx.card || '';
      case 'Type': return ctx.type || '';
      default: return undefined;
    }
  };
  const val = (k) => (k in F ? F[k] : special(k));
  const sec = /\{\{([#^])\s*([^{}]+?)\s*\}\}([\s\S]*?)\{\{\/\s*\2\s*\}\}/;
  let m, guard = 0;
  while ((m = sec.exec(s)) && guard++ < 500) {
    const empty = R.isEmpty(val(m[2]));
    const show = m[1] === '#' ? !empty : empty;
    s = s.slice(0, m.index) + (show ? m[3] : '') + s.slice(m.index + m[0].length);
  }
  s = s.replace(/\{\{!([\s\S]*?)\}\}/g, '');
  return s.replace(/\{\{([^{}]+?)\}\}/g, (all, inner) => {
    const parts = inner.trim().split(':'); const name = parts.pop(); const filters = parts.reverse();
    let v = val(name);
    if (v === undefined) return filters.includes('tts') ? '' : `{unknown field ${name}}`;
    for (const f of filters) {
      if (f === 'text') v = R.stripHtml(v);
      else if (f === 'cloze') v = ctx.cloze ? R.cloze(v, ctx.cloze, ctx.side === 'a') : v;
      else if (f === 'hint') v = R.isEmpty(v) ? '' : `<details class="hint"><summary>Show ${name}</summary>${v}</details>`;
      else if (f === 'type') v = ctx.side === 'q' ? '<input class="typeans" type="text" placeholder="Type answer">' : `<code class="typeans">${R.stripHtml(F[name] || '')}</code>`;
      else if (f === 'furigana') v = v.replace(/ ?([^ >]+?)\[(.+?)\]/g, '<ruby><rb>$1</rb><rt>$2</rt></ruby>');
      else if (f === 'kanji') v = v.replace(/ ?([^ >]+?)\[(.+?)\]/g, '$1');
      else if (f === 'kana') v = v.replace(/ ?([^ >]+?)\[(.+?)\]/g, '$2');
      else if (f === 'tts') v = '';
    }
    return v;
  });
};

R.renderCard = function (model, fields, ord, meta) {
  const F = {}; model.fields.forEach((n, i) => { F[n] = fields[i] || ''; });
  let tmpl, clozeN = null, cardName;
  if (model.cloze) { tmpl = model.tmpls[0]; clozeN = ord + 1; cardName = 'Cloze ' + clozeN; }
  else { tmpl = model.tmpls[ord] || model.tmpls[0]; cardName = tmpl.name; }
  const base = { tags: meta.tags, deck: meta.deck, card: cardName, type: model.name, cloze: clozeN };
  const q = R.renderTpl(tmpl.qfmt, F, { ...base, side: 'q' });
  const a = R.renderTpl(tmpl.afmt, F, { ...base, side: 'a', front: q });
  return { q, a };
};

/* ---------------- media ---------------- */
const MIME = { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', opus: 'audio/ogg', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif', ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2' };
const urlCache = new Map();
R.mediaUrl = async (imp, name) => {
  const key = imp + '/' + name;
  if (urlCache.has(key)) return urlCache.get(key);
  let blob = await R.db.get('media', key);
  if (!blob) { try { blob = await R.db.get('media', imp + '/' + decodeURIComponent(name)); } catch (e) { /* ignore */ } }
  const url = blob ? URL.createObjectURL(blob) : null;
  urlCache.set(key, url); return url;
};
R.resolveHtml = async function (html, imp) {
  const names = new Set();
  const skip = (n) => /^(https?:|data:|blob:|\/\/|#)/i.test(n);
  html.replace(/\[sound:([^\]]+)\]/g, (m, n) => { names.add(n); return m; });
  html.replace(/\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi, (m, a, b, c) => { const n = a || b || c; if (n && !skip(n)) names.add(n); return m; });
  const map = {};
  await Promise.all([...names].map(async n => { map[n] = await R.mediaUrl(imp, n); }));
  html = html.replace(/\[sound:([^\]]+)\]/g, (m, n) => map[n] ? `<audio controls preload="auto" src="${map[n]}"></audio>` : '');
  html = html.replace(/\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi, (m, a, b, c) => { const n = a || b || c; return map[n] ? `src="${map[n]}"` : m; });
  return html;
};
R.resolveCss = async function (css, imp) {
  const names = new Set();
  css.replace(/url\(\s*["']?([^"')]+)["']?\s*\)/g, (m, n) => { if (!/^(https?:|data:)/i.test(n)) names.add(n); return m; });
  const map = {};
  await Promise.all([...names].map(async n => { map[n] = await R.mediaUrl(imp, n); }));
  return css.replace(/url\(\s*["']?([^"')]+)["']?\s*\)/g, (m, n) => map[n] ? `url("${map[n]}")` : m);
};

/* ---------------- import ---------------- */
R.SQL = null;
R.VERSION = '4';
R.initSQL = async () => {
  if (R.SQL) return R.SQL;
  let bin = null, last = '';
  for (const p of ['sql-wasm.wasm', 'vendor/sql-wasm.wasm']) {
    try {
      const r = await fetch(new URL(p, document.baseURI), { cache: 'no-cache' });
      if (r.ok) { bin = await r.arrayBuffer(); break; }
      last = `${p}: HTTP ${r.status}`;
    } catch (err) { last = `${p}: ${err.message}`; }
  }
  if (!bin) throw new Error('Could not load sql-wasm.wasm (' + last + '). Check that the file is in the same folder as index.html.');
  R.SQL = await initSqlJs({ wasmBinary: bin });
  return R.SQL;
};
const sha1hex = async (u8) => [...new Uint8Array(await crypto.subtle.digest('SHA-1', u8))].map(b => b.toString(16).padStart(2, '0')).join('');
const isZstd = (u) => u.length > 4 && u[0] === 0x28 && u[1] === 0xB5 && u[2] === 0x2F && u[3] === 0xFD;

// Latest-format collections declare a custom "unicase" collation that browser SQLite lacks.
// Swap it for the built-in "nocase" (same byte length) so the schema loads; we only ever scan tables.
const patchCollation = (u) => {
  const pat = [...'collate unicase'].map(c => c.charCodeAt(0)); const rep = [...'collate nocase '].map(c => c.charCodeAt(0));
  const low = (b) => (b >= 65 && b <= 90 ? b + 32 : b);
  for (let i = 0; i + pat.length <= u.length; i++) {
    if (low(u[i]) !== 99) continue;
    let ok = true; for (let j = 1; j < pat.length; j++) if (low(u[i + j]) !== pat[j]) { ok = false; break; }
    if (ok) { for (let j = 8; j < rep.length; j++) u[i + j] = rep[j]; i += pat.length - 1; }
  }
  return u;
};
const tick = () => new Promise(r => setTimeout(r, 0));

R.importApkg = async function (file, progress = () => {}) {
  const missing = [['JSZip', 'jszip.min.js'], ['fzstd', 'fzstd.js'], ['initSqlJs', 'sql-wasm.js']].filter(([g]) => typeof window[g] === 'undefined').map(x => x[1]);
  if (missing.length) throw new Error('App files missing or not loaded: ' + missing.join(', '));
  progress('Reading file…');
  const buf = new Uint8Array(await file.arrayBuffer());
  const hash = await sha1hex(buf);
  if (await R.db.get('imports', hash)) throw new Error('This deck file is already imported. Delete it first to re-import.');
  const zip = await JSZip.loadAsync(buf);
  const latest = !!zip.file('collection.anki21b');
  const dbName = latest ? 'collection.anki21b' : zip.file('collection.anki21') ? 'collection.anki21' : 'collection.anki2';
  if (!zip.file(dbName)) throw new Error('Not a valid .apkg file (no collection found).');
  progress('Unpacking collection…');
  let dbBytes = await zip.file(dbName).async('uint8array');
  if (isZstd(dbBytes)) dbBytes = fzstd.decompress(dbBytes);

  // media index -> name
  const mediaMap = {};
  const mf = zip.file('media');
  if (mf) {
    let mb = await mf.async('uint8array');
    if (isZstd(mb)) mb = fzstd.decompress(mb);
    if (mb[0] === 0x7b) Object.assign(mediaMap, JSON.parse(R.dec(mb)));
    else (R.pb(mb)[1] || []).forEach((e, idx) => { const p = R.pb(e); if (p[1]) mediaMap[idx] = R.dec(p[1][0]); });
  }

  const SQL = await R.initSQL();
  patchCollation(dbBytes);
  const sdb = new SQL.Database(dbBytes);
  const q = (sql) => { const r = sdb.exec(sql); if (!r.length) return []; const { columns, values } = r[0]; return values.map(v => Object.fromEntries(columns.map((c, i) => [c, v[i]]))); };
  const hasTable = (t) => q(`select name from sqlite_master where type='table' and name='${t}'`).length > 0;

  const models = {}, decks = {};
  if (hasTable('notetypes')) {
    for (const nt of q('select id,name,config from notetypes')) {
      const cfg = nt.config ? R.pb(nt.config) : {};
      models[nt.id] = { name: nt.name, cloze: (cfg[1] ? cfg[1][0] : 0) === 1, css: cfg[3] ? R.dec(cfg[3][0]) : '', fields: [], tmpls: [] };
    }
    for (const f of q('select ntid,ord,name from fields')) if (models[f.ntid]) models[f.ntid].fields[f.ord] = f.name;
    for (const t of q('select ntid,ord,name,config from templates')) {
      const c = R.pb(t.config);
      if (models[t.ntid]) models[t.ntid].tmpls[t.ord] = { name: t.name, qfmt: c[1] ? R.dec(c[1][0]) : '', afmt: c[2] ? R.dec(c[2][0]) : '' };
    }
    for (const d of q('select id,name from decks')) decks[d.id] = d.name.replace(/\x1f/g, '::');
  } else {
    const col = q('select models,decks from col')[0];
    const ms = JSON.parse(col.models), ds = JSON.parse(col.decks);
    for (const id in ms) {
      const m = ms[id];
      models[id] = { name: m.name, cloze: m.type === 1, css: m.css || '', fields: m.flds.sort((a, b) => a.ord - b.ord).map(f => f.name), tmpls: m.tmpls.sort((a, b) => a.ord - b.ord).map(t => ({ name: t.name, qfmt: t.qfmt, afmt: t.afmt })) };
    }
    for (const id in ds) decks[id] = ds[id].name.replace(/\x1f/g, '::');
  }

  const notes = {};
  for (const n of q('select id,mid,flds,tags from notes')) notes[n.id] = n;
  const hasOdid = q('pragma table_info(cards)').some(c => c.name === 'odid');
  const cards = q(`select id,nid,did,ord${hasOdid ? ',odid' : ''} from cards order by nid,ord`);
  sdb.close();
  if (!cards.length) throw new Error('This file contains no cards.');

  const imp = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  progress(`Importing ${cards.length} cards…`);

  // models (css only; templates already rendered into cards)
  const usedDecks = {};
  await R.db.putMany('models', Object.keys(models).map(mid => ({ key: imp + ':' + mid, css: models[mid].css })));
  let batchC = [], batchS = [], seq = 0;
  for (const c of cards) {
    const note = notes[c.nid]; const model = note && models[note.mid];
    if (!model || !model.tmpls.length) continue;
    const did = (c.odid && c.odid !== 0) ? c.odid : c.did;
    const dname = decks[did] || 'Default';
    const deckId = imp + ':' + did;
    usedDecks[deckId] = { id: deckId, imp, name: dname, file: file.name };
    let r;
    try { r = R.renderCard(model, note.flds.split('\x1f'), c.ord, { tags: (note.tags || '').trim(), deck: dname }); }
    catch (e) { continue; }
    const id = imp + ':' + c.id;
    batchC.push({ id, deck: deckId, imp, mid: imp + ':' + note.mid, q: r.q, a: r.a });
    batchS.push({ id, deck: deckId, state: 0, due: 0, ivl: 0, ease: 2.5, reps: 0, lapses: 0, step: 0, intro: 0, seq: seq++ });
    if (batchC.length >= 500) { await R.db.putMany('cards', batchC); await R.db.putMany('sched', batchS); batchC = []; batchS = []; await tick(); }
  }
  if (batchC.length) { await R.db.putMany('cards', batchC); await R.db.putMany('sched', batchS); }
  await R.db.putMany('decks', Object.values(usedDecks));

  // media
  const idxs = Object.keys(mediaMap);
  let pairs = [], bytes = 0, done = 0;
  for (const idx of idxs) {
    const zf = zip.file(idx); if (!zf) continue;
    let u = await zf.async('uint8array');
    if (isZstd(u)) { try { u = fzstd.decompress(u); } catch (e) { /* keep raw */ } }
    const name = mediaMap[idx]; const ext = (name.split('.').pop() || '').toLowerCase();
    pairs.push([imp + '/' + name, new Blob([u], { type: MIME[ext] || 'application/octet-stream' })]);
    bytes += u.length; done++;
    if (bytes > 24e6 || pairs.length >= 300) { await R.db.putManyKeyed('media', pairs); pairs = []; bytes = 0; progress(`Importing media… ${done}/${idxs.length}`); await tick(); }
  }
  if (pairs.length) await R.db.putManyKeyed('media', pairs);
  await R.db.put('imports', { hash, imp, name: file.name, time: Date.now(), cards: seq });
  const pend = await R.db.get('meta', 'pending:' + hash);
  if (pend) { await R.applyProgress(imp, pend); await R.db.del('meta', 'pending:' + hash); }
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (err) { /* ignore */ }
  return { imp, cards: seq, decks: Object.keys(usedDecks).length, media: idxs.length };
};

R.deleteDecks = async function (deckIds) {
  const ids = new Set(deckIds);
  const d = await R.db.open();
  const decks = (await R.db.getAll('decks')).filter(x => ids.has(x.id));
  await new Promise((res, rej) => {
    const tx = d.transaction(['cards', 'sched', 'decks'], 'readwrite');
    tx.oncomplete = res; tx.onerror = tx.onabort = () => rej(tx.error);
    const cs = tx.objectStore('cards'); const ss = tx.objectStore('sched');
    const cur = cs.openCursor();
    cur.onsuccess = () => { const c = cur.result; if (c) { if (ids.has(c.value.deck)) { c.delete(); ss.delete(c.key); } c.continue(); } };
    decks.forEach(x => tx.objectStore('decks').delete(x.id));
  });
  // drop media/imports for packages with no decks left
  const remaining = new Set((await R.db.getAll('decks')).map(x => x.imp));
  for (const imp of new Set(decks.map(x => x.imp))) {
    if (remaining.has(imp)) continue;
    const keys = (await R.db.mediaKeys()).filter(k => k.startsWith(imp + '/'));
    await new Promise((res) => { const tx = d.transaction('media', 'readwrite'); keys.forEach(k => tx.objectStore('media').delete(k)); tx.oncomplete = res; });
    keys.forEach(k => { const u = urlCache.get(k); if (u) URL.revokeObjectURL(u); urlCache.delete(k); });
    const imps = await R.db.getAll('imports');
    for (const i of imps) if (i.imp === imp) await R.db.del('imports', i.hash);
  }
};

/* ---------------- scheduler ---------------- */
R.DEFAULTS = { newPerDay: 20, revPerDay: 500, steps: [1, 10], relearn: [10], autoplay: true, rate3: false, intro: false, goalCards: 50, goalMin: 20 };

R.reviewIvls = (c, now = Date.now()) => {
  // reviewing early: base the new interval on how long the card has really been waiting
  const early = Math.max(0, Math.round((c.due - R.dayStart(now)) / R.DAY));
  const base = Math.max(1, c.ivl - early);
  const hard = Math.max(base + 1, Math.round(base * 1.2));
  const good = Math.max(hard + 1, Math.round(base * c.ease));
  const easy = Math.max(good + 1, Math.round(base * c.ease * 1.3));
  return { 2: hard, 3: good, 4: easy };
};

R.schedule = function (c, rating, now, S) {
  const n = { ...c }; const today = R.dayStart(now);
  const grad = (days) => { n.state = 2; n.ivl = days; n.due = today + days * R.DAY; n.step = 0; };
  if (c.state === 2) {
    n.reps = c.reps + 1;
    if (rating === 1) {
      n.lapses = c.lapses + 1; n.ease = Math.max(1.3, c.ease - 0.2); n.ivl = 1;
      n.state = 3; n.step = 0; n.due = now + S.relearn[0] * 60000;
    } else {
      const iv = R.reviewIvls(c, now);
      n.ease = rating === 2 ? Math.max(1.3, c.ease - 0.15) : rating === 4 ? c.ease + 0.15 : c.ease;
      grad(iv[rating]);
    }
    return n;
  }
  // new / learning / relearning
  const relearn = c.state === 3; const steps = relearn ? S.relearn : S.steps;
  const step = c.state === 0 ? 0 : c.step;
  if (c.state === 0) n.intro = now;
  n.state = relearn ? 3 : 1; n.reps = c.reps + 1;
  if (rating === 1) { n.step = 0; n.due = now + steps[0] * 60000; }
  else if (rating === 2) { n.step = step; n.due = now + steps[Math.min(step, steps.length - 1)] * 60000; }
  else if (rating === 3) {
    if (step + 1 >= steps.length) grad(relearn ? Math.max(1, c.ivl) : 1);
    else { n.step = step + 1; n.due = now + steps[step + 1] * 60000; }
  } else grad(relearn ? Math.max(1, c.ivl) + 1 : 4);
  return n;
};

R.fmtIvl = (ms) => {
  const m = ms / 60000;
  if (m < 1) return '<1m';
  if (m < 60) return Math.round(m) + 'm';
  const h = m / 60; if (h < 24) return Math.round(h) + 'h';
  const d = h / 24; if (d < 30) return Math.round(d) + 'd';
  if (d < 365) return (d / 30).toFixed(1).replace(/\.0$/, '') + 'mo';
  return (d / 365).toFixed(1).replace(/\.0$/, '') + 'y';
};
R.previewLabel = (c, rating, now, S) => {
  const n = R.schedule(c, rating, now, S);
  return R.fmtIvl(n.state === 2 ? n.ivl * R.DAY : n.due - now);
};

R.countDeck = (list, now, introducedToday, reviewedToday, S) => {
  const end = R.dayStart(now) + R.DAY - 1;
  let nw = 0, lrn = 0, rev = 0;
  for (const c of list) {
    if (c.state === 0) nw++;
    else if (c.state === 2) { if (c.due <= end) rev++; }
    else if (c.due <= end) lrn++;
  }
  return { new: Math.max(0, Math.min(nw, S.newPerDay - introducedToday)), learn: lrn, due: Math.max(0, Math.min(rev, S.revPerDay - reviewedToday)), totalNew: nw };
};

R.getSettings = async () => ({ ...R.DEFAULTS, ...((await R.db.get('meta', 'settings')) || {}) });


/* ---------------- stats, extra limits ---------------- */
R.dayStats = (logs) => {
  const m = new Map();
  for (const l of logs) {
    const d = R.dayStart(l.time); const o = m.get(d) || { n: 0, ms: 0 };
    o.n++; o.ms += Math.min(l.ms || 0, 60000); m.set(d, o);
  }
  return m;
};
R.streaks = (m, goalN, goalMin, today) => {
  const run = (ok) => {
    let s = 0, d = today;
    if (!(m.has(d) && ok(m.get(d)))) d = R.dayStart(d - 1);
    while (m.has(d) && ok(m.get(d))) { s++; d = R.dayStart(d - 1); }
    return s;
  };
  return { cards: run(o => o.n >= goalN), time: run(o => o.ms >= goalMin * 60000) };
};
R.getExtra = async () => {
  const x = await R.db.get('meta', 'extra');
  return x && x.day === R.dayStart() ? x.map : {};
};
R.addExtra = async (path, n, r) => {
  const map = await R.getExtra(); const o = map[path] || { n: 0, r: 0 };
  map[path] = { n: o.n + n, r: o.r + r };
  await R.db.put('meta', { day: R.dayStart(), map }, 'extra');
  return map[path];
};

/* ---------------- backup / restore ---------------- */
const keyOf = (id) => { const i = id.indexOf(':'); return [id.slice(0, i), id.slice(i + 1)]; };

R.exportProgress = async () => {
  const [imports, sched, logs, settings] = await Promise.all([R.db.getAll('imports'), R.db.getAll('sched'), R.db.getAll('revlog'), R.db.get('meta', 'settings')]);
  const hashOf = {}; imports.forEach(i => { hashOf[i.imp] = i; });
  const pkgs = {};
  const pk = (imp) => { const i = hashOf[imp]; if (!i) return null; return (pkgs[i.hash] = pkgs[i.hash] || { name: i.name, s: [], l: [] }); };
  for (const c of sched) {
    if (c.state === 0 && !c.reps) continue;
    const [imp, cid] = keyOf(c.id); const p = pk(imp); if (!p) continue;
    p.s.push([cid, c.state, c.due, c.ivl, c.ease, c.reps, c.lapses, c.step, c.intro]);
  }
  for (const l of logs) {
    const [imp, cid] = keyOf(l.card); const p = pk(imp); if (!p) continue;
    p.l.push([cid, keyOf(l.deck)[1], l.time, l.rating, l.prev, l.ivl || 0, l.ms || 0]);
  }
  return { app: 'recall-progress', v: 1, time: Date.now(), settings: settings || null, pkgs };
};

R.applyProgress = async (imp, p) => {
  const all = await R.db.getAll('sched');
  const have = new Map(); const prefix = imp + ':';
  for (const c of all) if (c.id.startsWith(prefix)) have.set(c.id, c);
  const upd = [];
  for (const e of p.s) {
    const cur = have.get(prefix + e[0]); if (!cur) continue;
    upd.push({ ...cur, state: e[1], due: e[2], ivl: e[3], ease: e[4], reps: e[5], lapses: e[6], step: e[7], intro: e[8] });
  }
  for (let i = 0; i < upd.length; i += 500) await R.db.putMany('sched', upd.slice(i, i + 500));
  await R.addLogsDedup(p.l.map(e => ({ card: prefix + e[0], deck: prefix + e[1], time: e[2], rating: e[3], prev: e[4], ivl: e[5], ms: e[6] })));
  return upd.length;
};
R.addLogsDedup = async (logs) => {
  if (!logs.length) return;
  const seen = new Set((await R.db.getAll('revlog')).map(l => l.card + '|' + l.time));
  const fresh = logs.filter(l => !seen.has(l.card + '|' + l.time));
  for (let i = 0; i < fresh.length; i += 1000) await R.db.addMany('revlog', fresh.slice(i, i + 1000));
};
R.restoreProgress = async (data) => {
  if (!data || data.app !== 'recall-progress') throw new Error('This is not a Recall progress backup.');
  const imports = await R.db.getAll('imports'); const impOf = {}; imports.forEach(i => { impOf[i.hash] = i.imp; });
  let applied = 0, waiting = 0;
  for (const [hash, p] of Object.entries(data.pkgs || {})) {
    if (impOf[hash]) { await R.applyProgress(impOf[hash], p); applied++; }
    else { await R.db.put('meta', p, 'pending:' + hash); waiting++; }
  }
  if (data.settings) await R.db.put('meta', { ...(await R.getSettings()), ...data.settings }, 'settings');
  return { applied, waiting };
};

R.exportFull = async (progress = () => {}) => {
  const zip = new JSZip();
  zip.file('manifest.json', JSON.stringify({ app: 'recall-full', v: 1, time: Date.now() }));
  for (const st of ['decks', 'cards', 'sched', 'models', 'imports', 'revlog']) {
    progress('Collecting ' + st + '…'); zip.file(st + '.json', JSON.stringify(await R.db.getAll(st)));
  }
  zip.file('meta.json', JSON.stringify(await R.db.metaAll()));
  const keys = await R.db.mediaKeys(); let n = 0;
  for (const k of keys) {
    zip.file('media/' + encodeURIComponent(k), await R.db.get('media', k), { binary: true });
    if (++n % 50 === 0) { progress(`Collecting media… ${n}/${keys.length}`); await tick(); }
  }
  progress('Writing file…');
  return zip.generateAsync({ type: 'blob', compression: 'STORE', streamFiles: true }, m => progress(`Writing file… ${Math.round(m.percent)}%`));
};
R.restoreFull = async (file, progress = () => {}) => {
  const zip = await JSZip.loadAsync(file);
  const man = zip.file('manifest.json');
  if (!man || JSON.parse(await man.async('string')).app !== 'recall-full') throw new Error('This is not a Recall full backup.');
  for (const st of ['decks', 'cards', 'sched', 'models', 'imports']) {
    progress('Restoring ' + st + '…');
    const arr = JSON.parse(await zip.file(st + '.json').async('string'));
    for (let i = 0; i < arr.length; i += 500) await R.db.putMany(st, arr.slice(i, i + 500));
  }
  await R.addLogsDedup(JSON.parse(await zip.file('revlog.json').async('string')));
  for (const [k, v] of JSON.parse(await zip.file('meta.json').async('string'))) await R.db.put('meta', v, k);
  const files = Object.keys(zip.files).filter(n => n.startsWith('media/') && !zip.files[n].dir);
  let pairs = [], done = 0;
  for (const n of files) {
    const key = decodeURIComponent(n.slice(6)); const ext = (key.split('.').pop() || '').toLowerCase();
    const u = await zip.file(n).async('uint8array');
    pairs.push([key, new Blob([u], { type: MIME[ext] || 'application/octet-stream' })]); done++;
    if (pairs.length >= 200) { await R.db.putManyKeyed('media', pairs); pairs = []; progress(`Restoring media… ${done}/${files.length}`); await tick(); }
  }
  if (pairs.length) await R.db.putManyKeyed('media', pairs);
  urlCache.clear();
  return { media: files.length };
};
