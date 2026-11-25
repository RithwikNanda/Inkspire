const $ = s => document.querySelector(s), app = $('#app');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const b64 = f => new Promise(r => { const x = new FileReader(); x.onload = () => r(x.result.split(',')[1]); x.readAsDataURL(f); });
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const TPL = [['none','No template','Plain notes'],['timeline','Timeline','Start each line with a year; click a year to see its events'],['graph','Knowledge graph','One link per line: A -relation-> B. Drawn as connected circles'],['taxonomy','Hierarchical tree','Indent lines to show levels, drawn as a tree diagram']];
let me = null, tagc = {}, books = [], notes = [], sel = {subject: null, topic: null}, q = '', wiz = null;

async function api(path, method = 'GET', body) {
  const r = await fetch('/api' + path, {method, headers: {'Content-Type': 'application/json'}, body: body ? JSON.stringify(body) : undefined});
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Something went wrong');
  return j;
}
const load = async () => { notes = (await api('/notes?q=' + encodeURIComponent(q))).notes; books = (await api('/subjects')).subjects; tagc = Object.fromEntries((await api('/tags')).tags.map(t => [t.tag, t.count])); };
async function boot() { try { me = await api('/me'); await load(); main(); } catch { authView(); } }

function authView(mode = 'login') {
  const reg = mode === 'register';
  app.innerHTML = `<div class="stage"><div class="blot b1"></div><div class="blot b2"></div><div class="blot b3"></div>
    <section class="hero" aria-label="Inkspire"><h1 class="word" aria-label="Inkspire"><span style="--i:0">I</span><span style="--i:1">n</span><span style="--i:2">k</span><span style="--i:3">s</span><span style="--i:4">p</span><span style="--i:5" class="ii">&#305;<i class="dot"></i></span><span style="--i:6">r</span><span style="--i:7">e</span></h1>
      <p class="tag-line">Spill your thoughts. Keep the good ones.</p></section>
    <div class="card auth"><h2 class="auth-h">${reg ? 'Start your first book' : 'Welcome back'}</h2><form id="f">
    ${reg ? '<input name="username" placeholder="Username" required><input name="email" type="email" placeholder="Email" required>' : '<input name="login" placeholder="Username or email" required>'}
    <input name="password" type="password" placeholder="Password${reg ? ' (8+ characters)' : ''}" required><button>${reg ? 'Create account' : 'Log in'}</button><p class="err" id="e"></p></form>
    <a href="#" id="sw">${reg ? 'Have an account? Log in' : 'New here? Register'}</a></div></div>`;
  $('#sw').onclick = e => { e.preventDefault(); authView(reg ? 'login' : 'register'); };
  $('#f').onsubmit = async e => { e.preventDefault();
    try { await api(reg ? '/register' : '/login', 'POST', Object.fromEntries(new FormData(e.target))); await boot(); }
    catch (x) { $('#e').textContent = x.message; } };
}

function main() {
  app.innerHTML = `<header><b class="logo"><svg class="nib" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2 5 12c-1.2 2 0 4.6 2.2 5.6L12 22l4.8-4.4C19 16.600 20.200 14 19 12z"/><path class="sl" d="M12 9v8"/><circle cx="12" cy="9" r="1.600"/></svg><span>Inkspire</span></b><input id="q" type="search" placeholder="Search titles, content, tags…" value="${esc(q)}">
    <button id="new">+ New note</button><button id="bm" class="ghost" title="Bookmarks">🔖</button><button id="rm" class="ghost" title="Reminders">⏰</button><button id="kgb" class="ghost" title="Knowledge graph of all your graph notes">🕸</button><button id="acct" class="ghost">${esc(me.username)}</button><button id="out" class="ghost">Log out</button></header>
    <div id="shelf" class="shelf"></div><section id="pane" class="pane"></section>`;
  $('#q').oninput = debounce(async e => { q = e.target.value; await load(); tree(); list(); }, 250);
  $('#new').onclick = () => { wiz = {step: 1, subject: sel.subject || '', topic: '', template: 'none'}; if (sel.subject) wiz.step = 2; wizard(); };
  $('#acct').onclick = account; $('#bm').onclick = bookmarks; $('#kgb').onclick = kgAll; $('#rm').onclick = reminders; checkDue();
  $('#out').onclick = async () => { await api('/logout', 'POST'); dropped = false; authView(); };
  $('#shelf').addEventListener('wheel', e => { if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { e.currentTarget.scrollLeft += e.deltaY; e.preventDefault(); } }, {passive: false});
  tree(); list();
}

const hue = s => Math.abs([...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7)) % 360;
let dropped = false;
function tree() {  // draws the bookshelf (one book per subject)
  const cnt = {}; notes.forEach(n => cnt[n.subject] = (cnt[n.subject] || 0) + 1);
  const shown = books.filter(b => !q || cnt[b.name]).sort((a, b) => (b.favourite || 0) - (a.favourite || 0));
  const fall = () => dropped ? '' : 'fall';
  $('#shelf').innerHTML = shown.map((b, i) => `<div class="book ${fall()} ${sel.subject === b.name ? 'on' : ''}" data-s="${esc(b.name)}" style="--h:${hue(b.name)};--i:${i}">
      <div class="pic" ${b.cover ? `style="background-image:url(${b.cover})"` : ''}>${b.cover ? '' : '📖'}</div><div class="ttl">${b.favourite ? "⭐ " : ""}${esc(b.name)}</div><span class="badge">${cnt[b.name] || 0}</span></div>`).join('') +
    `<div class="book add ${fall()}" style="--i:${shown.length}"><div class="pic">＋</div><div class="ttl">New book</div></div>`;
  dropped = true;
  document.querySelectorAll('.book').forEach(el => el.onclick = () => {
    if (el.classList.contains('add')) { wiz = {step: 1, subject: '', topic: '', template: 'none'}; return wizard(); }
    sel = {subject: el.dataset.s, topic: null}; tree(); list(); });
}

async function cartoon(file) {  // centre-crop to a square and shrink; the colours are left untouched
  const img = await new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = URL.createObjectURL(file); });
  const c = document.createElement('canvas'), S = 220; c.width = c.height = S; const x = c.getContext('2d');
  const k = Math.max(S / img.width, S / img.height);
  x.drawImage(img, (S - img.width * k) / 2, (S - img.height * k) / 2, img.width * k, img.height * k);
  return c.toDataURL('image/jpeg', 0.88);
}

function list() {
  if (!sel.subject) { $('#pane').innerHTML = '<p class="empty">👆 Pick a book from the shelf to open it, or add a new one.</p>'; return; }
  const inBook = notes.filter(n => n.subject === sel.subject), tops = [...new Set(inBook.map(n => n.topic))];
  if (sel.topic && !tops.includes(sel.topic)) sel.topic = null;
  const v = inBook.filter(n => !sel.topic || n.topic === sel.topic);
  $('#pane').innerHTML = `<h2>${esc(sel.subject)} <button class="ghost" id="fav">${(books.find(b => b.name === sel.subject) || {}).favourite ? '⭐ Favourite' : '☆ Favourite'}</button> <button class="ghost" id="renb">✏️ Rename</button> <button class="ghost" id="delb">🗑 Delete</button></h2><div class="opts"><button class="chip ${!sel.topic ? 'on' : ''}" data-t="">All topics</button>${tops.map(t => `<button class="chip ${sel.topic === t ? 'on' : ''}" data-t="${esc(t)}">${esc(t)}</button>`).join('')}</div>` +
    (v.length ? v.map(n => `<article class="card note" data-id="${n.id}"><h3>${n.bookmarked ? '🔖 ' : ''}${esc(n.title)}</h3>
    <small>${esc(n.topic)} · ${esc(n.template)} · ${esc(n.created.slice(0, 10))}</small><p>${esc(n.snippet)}…</p>
    <div>${tagHtml(n.kw)}</div></article>`).join('') : '<p class="empty">Nothing here yet. Click “+ New note”.</p>');
  document.querySelectorAll('.chip[data-t]').forEach(c => c.onclick = () => { sel.topic = c.dataset.t || null; list(); });
  document.querySelectorAll('.note').forEach(a => a.onclick = () => view(a.dataset.id));
  $('#pane .opts').insertAdjacentHTML('afterend', `<div class="cloud">${tagHtml([...new Set(inBook.flatMap(n => n.kw))].slice(0, 40))}</div>`);
  $('#fav').onclick = async () => { await api('/subjects/favourite', 'POST', {name: sel.subject}); await load(); tree(); list(); };
  $('#renb').onclick = async () => {
    const nn = prompt('New name for this book:', sel.subject); if (nn === null || !nn.trim() || nn.trim() === sel.subject) return;
    try { const r = await api('/subjects/rename', 'POST', {name: sel.subject, new: nn}); sel.subject = r.name; await load(); tree(); list(); } catch (e) { alert(e.message); }
  };
  $('#delb').onclick = async () => {
    if (!confirm(`Delete the book “${sel.subject}” and its ${inBook.length} note${inBook.length == 1 ? '' : 's'}? This cannot be undone.`)) return;
    try { await api('/subjects/delete', 'POST', {name: sel.subject}); sel = {subject: null, topic: null}; await load(); tree(); list(); } catch (e) { alert(e.message); }
  };
}

const tagEditHtml = n => n.kw.map(t => `<span class="tagwrap"><span class="tag" data-t="${esc(t)}">${esc(t)}<b>${tagc[t.toLowerCase()] || 1}</b></span><button class="tagx" data-w="${esc(t)}" title="Remove this tag">×</button></span>`).join('') +
  `<div class="tagadd"><input id="newtag" maxlength="30" placeholder="Add a tag"><button class="ghost" id="addtag">+ Add</button><small>${n.kw.length}/${n.max_tags} tags</small></div>`;
function wireTags(n, id) {
  const box = $('#tagedit'), draw = () => { box.innerHTML = tagEditHtml(n); wireTags(n, id); };
  const send = async (action, tag) => { try { n.kw = (await api('/notes/' + id + '/tags', 'POST', {action, tag})).kw; await load(); tree(); draw(); } catch (e) { alert(e.message); } };
  box.querySelectorAll('.tagx').forEach(b => b.onclick = () => send('remove', b.dataset.w));
  const add = () => { const v = $('#newtag').value.trim(); if (v) send('add', v); };
  $('#addtag').onclick = add; $('#newtag').onkeydown = e => { if (e.key === 'Enter') add(); };
}

const tagHtml = tags => tags.map(t => `<span class="tag" data-t="${esc(t)}">${esc(t)}<b>${tagc[t.toLowerCase()] || 1}</b></span>`).join('');
document.addEventListener('click', e => { const t = e.target.closest('.tag[data-t]'); if (t) { e.stopPropagation(); byTag(t.dataset.t); } }, true);

function panel(title, v) {
  $('#pane').innerHTML = `<h2>${esc(title)}</h2>` + (v.length ? v.map(n => `<article class="card note" data-id="${n.id}"><h3>${n.bookmarked ? '🔖 ' : ''}${esc(n.title)}</h3>
    <small>${esc(n.subject)} › ${esc(n.topic)}</small><div>${tagHtml(n.kw)}</div></article>`).join('') : '<p class="empty">Nothing here yet.</p>');
  document.querySelectorAll('.note').forEach(a => a.onclick = () => view(a.dataset.id));
}
const bookmarks = () => panel('🔖 Bookmarks', notes.filter(n => n.bookmarked));
async function byTag(t) {
  if (q) { q = ''; $('#q').value = ''; await load(); tree(); }
  const v = notes.filter(n => n.kw.includes(t.toLowerCase()));
  panel(`Tag “${t}” · ${v.length} note${v.length == 1 ? '' : 's'}`, v);
}

async function reminders() {
  const rs = (await api('/reminders')).reminders, now = new Date();
  $('#pane').innerHTML = '<h2>⏰ Reminders</h2>' + (rs.length ? rs.map(r => { const due = !r.done && new Date(r.due) <= now;
    return `<div class="card ${due ? 'due' : ''}"><b>${esc(r.text || 'Review this note')}</b> · <a href="#" data-n="${r.note_id}">${esc(r.title)}</a><br>
    <small>${esc(r.due.replace('T', ' '))}${r.done ? ' · done ✅' : due ? ' · DUE NOW' : ''}</small><p>${r.done ? '' : `<button data-d="${r.id}">Done</button> `}<button class="ghost" data-x="${r.id}">Delete</button></p></div>`; }).join('')
    : '<p class="empty">No reminders yet. Open a note and click “⏰ Remind me”.</p>');
  document.querySelectorAll('[data-n]').forEach(a => a.onclick = e => { e.preventDefault(); view(a.dataset.n); });
  document.querySelectorAll('[data-d]').forEach(b => b.onclick = async () => { await api('/reminders/' + b.dataset.d + '/done', 'POST'); reminders(); });
  document.querySelectorAll('[data-x]').forEach(b => b.onclick = async () => { await api('/reminders/' + b.dataset.x, 'DELETE'); reminders(); });
}

const toasted = new Set();
async function checkDue() {
  try { const rs = (await api('/reminders')).reminders, now = new Date();
    rs.filter(r => !r.done && new Date(r.due) <= now && !toasted.has(r.id)).forEach(r => { toasted.add(r.id);
      const t = document.createElement('div'); t.className = 'toast';
      t.innerHTML = `⏰ <b>${esc(r.text || 'Reminder')}</b> · ${esc(r.title)}<p><button>Open</button> <button class="ghost">Dismiss</button></p>`;
      const [o, x] = t.querySelectorAll('button'); o.onclick = () => { t.remove(); view(r.note_id); }; x.onclick = () => t.remove();
      document.body.append(t);
      if (window.Notification && Notification.permission == 'granted') new Notification('Inkspire', {body: (r.text || 'Reminder') + ' · ' + r.title}); });
  } catch {}
}
setInterval(() => me && checkDue(), 60000);

async function view(id) {
  const [n, rel] = await Promise.all([api('/notes/' + id), api('/notes/' + id + '/related')]), defs = n.defs;
  $('#pane').innerHTML = `<div class="card"><button class="ghost" id="back">← Back</button> <button class="ghost" id="bk">${n.bookmarked ? '🔖 Bookmarked' : '🔖 Bookmark'}</button>
    <button class="ghost" id="rem">⏰ Remind me</button> <button class="ghost" id="edit">✏️ Edit</button> <button class="ghost" id="del">Delete</button>
    <div id="remform" hidden><input type="datetime-local" id="rdue"><input id="rtxt" placeholder="Reminder message (optional)"><button id="rsave">Set reminder</button></div>
    <h2>${esc(n.title)}</h2><p class="crumb">${esc(n.subject)} › ${esc(n.topic)} · ${esc(n.template)}${n.template === 'taxonomy' ? ' · click a node to write its definition' : n.template === 'timeline' ? ' · click a year to see its events' : n.template === 'graph' ? ' · click a circle to see its links, drag to move it' : ''}${defs.length ? ' · hover the underlined words for definitions' : ''}</p>
    <div id="tagedit">${tagEditHtml(n)}</div><p class="crumb">Headings: ${n.tags.map(esc).join(" · ")}</p>${n.template === 'taxonomy' ? treeHtml(parseTree(n.content), defs, n.title) : n.template === 'timeline' ? timelineHtml(parseTimeline(n.content), n.content, defs) : n.template === 'graph' ? `<div id="kg"></div><details><summary>Show the raw note</summary><pre>${esc(n.content)}</pre></details>` : `<pre>${mark(n.content, defs)}</pre>`}
    <h3>Related notes (shared tags)</h3>${rel.related.length ? rel.related.map(r => `<a class="rel" href="#" data-id="${r.id}">${esc(r.title)} <small>${esc(r.subject)} › ${esc(r.topic)} · shares ${r.shared.map(s => esc(s.word) + ' ×' + s.n).join(', ')}</small></a>`).join('') : '<p class="empty">No other note shares a tag with this one yet.</p>'}</div>`;
  $('#back').onclick = () => { hideTip(); closeDefBox(); list(); };
  $('#bk').onclick = async () => { await api('/notes/' + id + '/bookmark', 'POST'); await load(); view(id); };
  $('#rem').onclick = () => { $('#remform').hidden = !$('#remform').hidden; if (window.Notification && Notification.permission == 'default') Notification.requestPermission(); };
  $('#rsave').onclick = async () => { const due = $('#rdue').value; if (!due) return;
    await api('/reminders', 'POST', {note_id: +id, due, text: $('#rtxt').value}); $('#remform').innerHTML = '✅ Reminder set'; };
  $('#edit').onclick = () => editNote(n);
  $('#del').onclick = async () => { if (!confirm('Delete this note?')) return; hideTip(); await api('/notes/' + id, 'DELETE'); await load(); tree(); list(); };
  document.querySelectorAll('.rel').forEach(a => a.onclick = e => { e.preventDefault(); hideTip(); view(a.dataset.id); });
  wireTags(n, id);
  wireTerms(document, defs);
  document.querySelectorAll('.node').forEach(nd => nd.onclick = () => editDef(nd, id, defs));
  if (n.template === 'timeline') wireTimeline(parseTimeline(n.content), defs);
  if (n.template === 'graph') kgMount($('#kg'), parseGraph(n.content), defs);
}

function wireTerms(root, defs) {  // hover/tap a dotted word -> its definition (call again after injecting new text)
  root.querySelectorAll('.term').forEach(t => { const show = () => { const d = defs.find(x => x.id == t.dataset.id); if (d && !defBox) tip(t, d); };
    t.onmouseenter = show; t.onclick = e => { if (!t.closest('.node')) { e.preventDefault(); show(); } }; t.onmouseleave = hideSoon; });
}
function editNote(n) {  // change the title / text of an existing note
  hideTip(); closeDefBox();
  $('#pane').innerHTML = `<div class="card"><h2>Edit note</h2><p class="crumb">${esc(n.subject)} › ${esc(n.topic)} · ${esc(n.template)}</p>
    <form id="ef"><input name="title" maxlength="200" value="${esc(n.title)}" placeholder="Title"><textarea name="content" rows="16">
${esc(n.content)}</textarea><button>Save changes</button> <button type="button" class="ghost" id="ecancel">Cancel</button><p class="err" id="e"></p></form></div>`;
  if (n.template === 'taxonomy') $('#ef textarea').onkeydown = e => { if (e.key == 'Tab') { e.preventDefault(); e.target.setRangeText('  ', e.target.selectionStart, e.target.selectionEnd, 'end'); } };
  $('#ecancel').onclick = () => view(n.id);
  $('#ef').onsubmit = async e => { e.preventDefault();
    try { await api('/notes/' + n.id, 'POST', {title: e.target.title.value, content: e.target.content.value}); await load(); tree(); view(n.id); }
    catch (x) { $('#e').textContent = x.message; } };
}

let defBox;
function closeDefBox() { if (defBox) defBox.remove(); defBox = null; }
function editDef(nd, noteId, defs) {  // click a tree node -> write its definition; it is saved to the definitions table and shows on hover in every note
  hideTip(); closeDefBox();
  const term = nd.textContent.trim(), cur = defs.find(d => d.term.toLowerCase() === term.toLowerCase());
  defBox = document.createElement('div'); defBox.id = 'defbox';
  defBox.innerHTML = `<b>${esc(term)}</b><textarea rows="4" maxlength="1000" placeholder="Write the definition of “${esc(term)}”…">${esc(cur ? cur.definition : '')}</textarea>
    ${cur && cur.src ? `<small>Currently from “${esc(cur.src)}” - saving creates one for this note.</small><br>` : ''}
    <button data-a="save">Save definition</button> <button data-a="cancel" class="ghost">Cancel</button>${cur ? ' <button data-a="del" class="ghost">Remove</button>' : ''}<p class="err"></p>`;
  document.body.append(defBox);
  const r = nd.getBoundingClientRect();
  defBox.style.left = Math.max(8, Math.min(r.left + scrollX, innerWidth - 320)) + 'px';
  defBox.style.top = (r.bottom + scrollY + 8) + 'px';
  const ta = defBox.querySelector('textarea'); ta.focus();
  const keep = () => { const w = document.querySelector('.tree-wrap'); return w ? w.scrollLeft : 0; };
  const done = async x => { const sl = keep(), sy = scrollY; closeDefBox(); await view(noteId); const w = document.querySelector('.tree-wrap'); if (w) w.scrollLeft = sl; scrollTo(0, sy); };
  defBox.onclick = e => e.stopPropagation();
  defBox.querySelectorAll('button').forEach(b => b.onclick = async () => {
    const a = b.dataset.a;
    if (a == 'cancel') return closeDefBox();
    try {
      if (a == 'save') { if (!ta.value.trim()) throw new Error('Write a definition first'); await api('/defs', 'POST', {note_id: +noteId, term, definition: ta.value}); }
      else await api('/defs/' + cur.id, 'POST', {action: 'no'});
      await done();
    } catch (x) { defBox.querySelector('.err').textContent = x.message; }
  });
  ta.onkeydown = e => { if (e.key == 'Escape') closeDefBox(); else if (e.key == 'Enter' && (e.ctrlKey || e.metaKey)) defBox.querySelector('[data-a=save]').click(); };
}
document.addEventListener('click', e => { if (defBox && !defBox.contains(e.target) && !e.target.closest('.node')) closeDefBox(); });

const TREE_EXAMPLE = 'Animals\n  Mammals\n    Dog\n    Cat\n  Birds\n    Eagle\nPlants\n  Trees';
function parseTree(text) {  // indentation like Python: a line indented deeper than the line above becomes its child
  const root = {kids: []}, stack = [{ind: -1, node: root}];
  text.split('\n').forEach(raw => {
    const label = raw.trim().replace(/^[-*•#]+\s*/, ''); if (!label) return;
    const ind = raw.match(/^[ \t]*/)[0].replace(/\t/g, '    ').length, node = {label, kids: []};
    while (stack.length > 1 && stack[stack.length - 1].ind >= ind) stack.pop();
    stack[stack.length - 1].node.kids.push(node); stack.push({ind, node});
  });
  return root.kids;
}
const nodeHtml = (n, d, defs) => `<li><span class="node" style="--d:${d}">${mark(n.label, defs)}</span>${n.kids.length ? `<ul>${n.kids.map(k => nodeHtml(k, d + 1, defs)).join('')}</ul>` : ''}</li>`;
function treeHtml(nodes, defs, title) {  // one top item = the root; several top items hang under a root named after the note
  const top = nodes.length == 1 ? nodes[0] : {label: title, kids: nodes};
  return `<div class="tree-wrap"><div class="tree"><ul>${nodeHtml(top, 0, defs)}</ul></div></div>`;
}

const TL_EXAMPLE = '1969: Moon landing\n  Apollo 11 lands on the Moon.\n1989: Berlin Wall falls\n1939-1945: World War II\n2007: First iPhone released';
const TL_LINE = /^(?:[-*\u2022]\s*)?(?:(?:c|ca|circa)\.?\s*|~)?(\d{1,4})\s*(BCE?|AD|CE)?(?:\s*[-\u2013\u2014]\s*(\d{1,4})\s*(BCE?|AD|CE)?)?\s*(?::|\s[-\u2013\u2014]\s|\s*$)\s*(.*)$/i;
function parseTimeline(text) {  // a line that starts with a year (then ":" or " - ") begins an event; lines under it add detail to it
  const by = new Map(); let last = null;
  text.split('\n').forEach(raw => {
    const line = raw.trim(); if (!line) return;
    const m = line.match(TL_LINE);
    if (!m) { if (last) last.more.push(line.replace(/^[-*\u2022]\s*/, '')); return; }
    const bc = x => /^bce?$/i.test(x || ''), start = +m[1] * (bc(m[2]) || (m[3] && bc(m[4]) && !m[2]) ? -1 : 1);
    const label = line.slice(0, line.length - m[5].length).replace(/^[-*\u2022]\s*/, '').replace(/[\s:\-\u2013\u2014]+$/, '');
    if (!by.has(label)) by.set(label, {label, at: start, events: []});
    last = {text: m[5], more: []}; if (last.text) by.get(label).events.push(last); else { last.text = ''; by.get(label).events.push(last); }
  });
  return [...by.values()].sort((a, b) => a.at - b.at);
}
function timelineHtml(pts, text, defs) {
  if (!pts.length) return `<p class="empty">No years found. Start each line with a year, like:</p><pre>${esc(TL_EXAMPLE)}</pre><details><summary>Show the raw note</summary><pre>${mark(text, defs)}</pre></details>`;
  return `<div class="tl-wrap"><div class="tl">${pts.map((p, i) => `<button class="tl-pt" data-i="${i}"><span class="tl-dot"></span><span class="tl-yr">${esc(p.label)}</span></button>`).join('')}</div></div><div id="tl-info" class="card tl-info"><p class="empty">👆 Click a year to see what happened.</p></div>`;
}
function wireTimeline(pts, defs) {
  document.querySelectorAll('.tl-pt').forEach(b => b.onclick = () => {
    document.querySelectorAll('.tl-pt').forEach(x => x.classList.toggle('on', x === b));
    const p = pts[b.dataset.i];
    $('#tl-info').innerHTML = `<h3>${esc(p.label)} <small>· ${p.events.length} event${p.events.length == 1 ? '' : 's'}</small></h3><ul>${p.events.map(e => `<li><b>${mark(e.text || '(no title)', defs)}</b>${e.more.map(l => `<br>${mark(l, defs)}`).join('')}</li>`).join('')}</ul>`; wireTerms($('#tl-info'), defs);
  });
}

const KG_EXAMPLE = 'Customer -buys-> Product\nCustomer -lives_in-> City\nProduct -belongs_to-> Category\nProduct -has_brand-> Brand\nStore -located_in-> City';
function parseGraph(text) {  // "A -relation-> B" per line; same name (any case) = same node
  const nodes = new Map(), edges = [], seen = new Set();
  const node = name => { const k = name.toLowerCase(); if (!nodes.has(k)) nodes.set(k, {name, id: k, x: 0, y: 0}); return nodes.get(k); };
  text.split('\n').forEach(raw => {
    const l = raw.trim().replace(/^[-*•]\s+/, ''); if (!l) return;
    const m = l.match(/^(.+?)\s+-+\s*(.*?)\s*-*>\s*(.+)$/);
    if (!m) return void node(l);
    const a = node(m[1].trim()), b = node(m[3].trim()), key = a.id + '|' + m[2].trim().toLowerCase() + '|' + b.id;
    if (!seen.has(key)) { seen.add(key); edges.push({a, b, label: m[2].trim()}); }
  });
  return {nodes: [...nodes.values()], edges};
}
function kgSize(g) {  // wrap each name onto 1-2 lines and pick a circle radius that fits it
  g.nodes.forEach(v => { const words = v.name.split(' '); let lines = [v.name];
    if (v.name.length > 10 && words.length > 1) { let best = 1; words.forEach((_, i) => { if (i && Math.abs(words.slice(0, i).join(' ').length - words.slice(i).join(' ').length) < Math.abs(words.slice(0, best).join(' ').length - words.slice(best).join(' ').length)) best = i; }); lines = [words.slice(0, best).join(' '), words.slice(best).join(' ')]; }
    v.lines = lines; v.r = Math.min(70, Math.max(30, Math.max(...lines.map(l => l.length)) * 4.4 + 12)); });
}
function kgLayout(g) {  // force layout that knows circle sizes; the canvas grows with the graph instead of squashing it
  const N = g.nodes, n = N.length; if (!n) return {W: 1000, H: 560};
  const idx = new Map(N.map((v, i) => [v, i])), gap = 46;
  const E = g.edges.filter(e => e.a !== e.b).map(e => ({i: idx.get(e.a), j: idx.get(e.b), len: e.a.r + e.b.r + Math.max(100, e.label.length * 6.5 + 50)}));
  const R = Math.max(200, Math.sqrt(n) * (N.reduce((t, v) => t + v.r, 0) / n) * 2.8);
  N.forEach((v, i) => { const a = i / n * 6.283; v.x = Math.cos(a) * R; v.y = Math.sin(a) * R * 0.7; });
  const ITER = 450;
  for (let it = 0; it < ITER; it++) {
    const t = 1 - it / ITER, f = N.map(() => [0, 0]);
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      const dx = N[i].x - N[j].x, dy = N[i].y - N[j].y, d = Math.hypot(dx, dy) || 0.1, min = N[i].r + N[j].r + gap;
      let r = 30000 / (d * d); if (d < min) r += (min - d) * 0.7;
      f[i][0] += dx / d * r; f[i][1] += dy / d * r; f[j][0] -= dx / d * r; f[j][1] -= dy / d * r; }
    E.forEach(e => { const A = N[e.i], B = N[e.j], dx = B.x - A.x, dy = B.y - A.y, d = Math.hypot(dx, dy) || 0.1, k = (d - e.len) * 0.05;
      f[e.i][0] += dx / d * k; f[e.i][1] += dy / d * k; f[e.j][0] -= dx / d * k; f[e.j][1] -= dy / d * k; });
    N.forEach((v, i) => { f[i][0] -= v.x * 0.006; f[i][1] -= v.y * 0.008;
      const m = Math.hypot(f[i][0], f[i][1]) || 1, s = Math.min(m, 40 * t + 2) / m; v.x += f[i][0] * s; v.y += f[i][1] * s; });
  }
  // clean-up: no two circles touch, and no line passes through a circle it doesn't belong to
  for (let pass = 0; pass < 120; pass++) {
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      const dx = N[j].x - N[i].x, dy = N[j].y - N[i].y, d = Math.hypot(dx, dy) || 0.1, min = N[i].r + N[j].r + gap;
      if (d < min) { const m = (min - d) / 2 / d; N[i].x -= dx * m; N[i].y -= dy * m; N[j].x += dx * m; N[j].y += dy * m; } }
    E.forEach(e => { const A = N[e.i], B = N[e.j], vx = B.x - A.x, vy = B.y - A.y, L2 = vx * vx + vy * vy || 1;
      N.forEach((v, k) => { if (k === e.i || k === e.j) return;
        const t = Math.max(0, Math.min(1, ((v.x - A.x) * vx + (v.y - A.y) * vy) / L2)), px = A.x + vx * t, py = A.y + vy * t;
        let dx = v.x - px, dy = v.y - py, d = Math.hypot(dx, dy); const need = v.r + 22;
        if (d < need) { if (d < 0.5) { dx = -vy; dy = vx; d = Math.hypot(dx, dy) || 1; } const m = (need - d) / d; v.x += dx * m * 0.7; v.y += dy * m * 0.7; } }); });
  }
  for (let pass = 0; pass < 60; pass++) for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {  // final guarantee: circles never touch
    const dx = N[j].x - N[i].x, dy = N[j].y - N[i].y, d = Math.hypot(dx, dy) || 0.1, min = N[i].r + N[j].r + 12;
    if (d < min) { const m = (min - d) / 2 / d; N[i].x -= dx * m; N[i].y -= dy * m; N[j].x += dx * m; N[j].y += dy * m; } }
  const x0 = Math.min(...N.map(v => v.x - v.r)), x1 = Math.max(...N.map(v => v.x + v.r)), y0 = Math.min(...N.map(v => v.y - v.r)), y1 = Math.max(...N.map(v => v.y + v.r)), pad = 50;
  const W = Math.max(760, Math.ceil(x1 - x0 + pad * 2)), H = Math.max(440, Math.ceil(y1 - y0 + pad * 2)), ox = (W - (x1 - x0)) / 2 - x0, oy = (H - (y1 - y0)) / 2 - y0;
  N.forEach(v => { v.x += ox; v.y += oy; });
  return {W, H};
}
function kgMount(el, g, defs, noteHint) {
  if (!g.nodes.length) { el.innerHTML = '<p class="empty">No links yet. Write lines like:</p><pre>' + esc(KG_EXAMPLE) + '</pre>'; return; }
  kgSize(g); const {W, H} = kgLayout(g); let on = null;
  const grp = {}; g.edges.forEach(e => { const k = [e.a.id, e.b.id].sort().join('|'); (grp[k] = grp[k] || []).push(e); });  // several links between the same two circles fan out as curves
  Object.values(grp).forEach(L => L.forEach((e, i) => { e.bow = (i - (L.length - 1) / 2) * 52; e.flip = e.a.id < e.b.id ? 1 : -1; }));
  el.innerHTML = `<div class="kg-wrap"><svg class="kg" viewBox="0 0 ${W} ${H}" style="min-width:${Math.round(W * .72)}px"></svg></div><div class="card kg-info"><p class="empty">👆 Click a circle to see its links.</p></div>`;
  const svg = el.querySelector('svg'), info = el.querySelector('.kg-info');
  const draw = () => {
    const edge = e => { const A = e.a, B = e.b, dx = B.x - A.x, dy = B.y - A.y, d = Math.hypot(dx, dy) || 1, ux = dx / d, uy = dy / d, px = -uy * e.flip, py = ux * e.flip;
      const cx = (A.x + B.x) / 2 + px * e.bow * 2, cy = (A.y + B.y) / 2 + py * e.bow * 2;  // control point: bends parallel links apart
      const u1 = Math.hypot(cx - A.x, cy - A.y) || 1, u2 = Math.hypot(cx - B.x, cy - B.y) || 1;
      const x1 = A.x + (cx - A.x) / u1 * A.r, y1 = A.y + (cy - A.y) / u1 * A.r, x2 = B.x + (cx - B.x) / u2 * (B.r + 4), y2 = B.y + (cy - B.y) / u2 * (B.r + 4);
      let ang = Math.atan2(dy, dx) * 180 / Math.PI; if (ang > 90 || ang < -90) ang += 180;
      const mx = (x1 + x2) / 4 + cx / 2 - uy * 11, my = (y1 + y2) / 4 + cy / 2 + ux * 11, hot = !on || e.a === on || e.b === on;
      return `<g class="ke ${hot ? '' : 'dim'}"><path d="M${x1} ${y1} Q${cx} ${cy} ${x2} ${y2}" marker-end="url(#ar)"/>${e.label ? `<text x="${mx}" y="${my}" transform="rotate(${ang} ${mx} ${my})" text-anchor="middle">${esc(e.label)}</text>` : ''}</g>`; };
    const near = v => !on || v === on || g.edges.some(e => (e.a === on && e.b === v) || (e.b === on && e.a === v));
    svg.innerHTML = `<defs><marker id="ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" fill="#8f96ff"/></marker></defs>` + g.edges.map(edge).join('') +
      g.nodes.map(v => `<g class="kn ${near(v) ? '' : 'dim'} ${v === on ? 'on' : ''}" data-id="${esc(v.id)}"><circle cx="${v.x}" cy="${v.y}" r="${v.r}" style="fill:hsl(${hue(v.name)} 70% 48%)"/>` +
        v.lines.map((l, i) => `<text x="${v.x}" y="${v.y + (i - (v.lines.length - 1) / 2) * 15 + 5}" text-anchor="middle">${esc(l)}</text>`).join('') + '</g>').join('');
  };
  const pt = e => { const p = svg.createSVGPoint(); p.x = e.clientX; p.y = e.clientY; return p.matrixTransform(svg.getScreenCTM().inverse()); };
  let drag = null;
  svg.onpointerdown = e => { const k = e.target.closest('.kn'); if (!k) return; drag = {v: g.nodes.find(v => v.id === k.dataset.id), moved: false}; svg.setPointerCapture(e.pointerId); };
  svg.onpointermove = e => { if (!drag) return; const p = pt(e); if (Math.hypot(p.x - drag.v.x, p.y - drag.v.y) > 3) drag.moved = true; if (drag.moved) { drag.v.x = Math.max(20, Math.min(W - 20, p.x)); drag.v.y = Math.max(20, Math.min(H - 20, p.y)); draw(); } };
  svg.onpointerup = () => { if (drag && !drag.moved) select(drag.v); drag = null; };
  async function select(v) {
    on = on === v ? null : v; draw();
    if (!on) { info.innerHTML = '<p class="empty">👆 Click a circle to see its links.</p>'; return; }
    const out = g.edges.filter(e => e.a === v), inn = g.edges.filter(e => e.b === v), d = defs.find(x => x.term.toLowerCase() === v.id);
    info.innerHTML = `<h3>${esc(v.name)}</h3>${d ? `<p>${esc(d.definition)}</p>` : ''}<ul>` +
      out.map(e => `<li>${e.label ? `<i>${esc(e.label)}</i> → ` : '→ '}<b>${esc(e.b.name)}</b></li>`).join('') + inn.map(e => `<li><b>${esc(e.a.name)}</b> ${e.label ? `<i>${esc(e.label)}</i> → ` : '→ '}this</li>`).join('') +
      `</ul><div class="mention"></div>`;
    try { const r = (await api('/notes?q=' + encodeURIComponent(v.name))).notes;
      if (on === v) info.querySelector('.mention').innerHTML = r.length ? '<small>Notes that mention it:</small>' + r.map(n => `<a class="rel" href="#" data-id="${n.id}">${esc(n.title)} <small>${esc(n.subject)} › ${esc(n.topic)}</small></a>`).join('') : '';
      info.querySelectorAll('.mention .rel').forEach(a => a.onclick = e => { e.preventDefault(); view(a.dataset.id); }); } catch {}
  }
  draw();
}
async function kgAll() {  // every "Knowledge graph" note merged into one picture; the same name = the same circle
  if (q) { q = ''; $('#q').value = ''; await load(); tree(); }
  $('#pane').innerHTML = '<h2>🕸 Knowledge graph</h2><p class="crumb">All your knowledge-graph notes in one picture. Circles with the same name are joined.</p><div id="kg"></div>';
  const gs = notes.filter(n => n.template === 'graph'), full = await Promise.all(gs.map(n => api('/notes/' + n.id)));
  if (!full.length) { $('#kg').innerHTML = '<p class="empty">No knowledge-graph notes yet. Click “+ New note” and pick “Knowledge graph”.</p>'; return; }
  kgMount($('#kg'), parseGraph(full.map(n => n.content).join('\n')), full.flatMap(n => n.defs));
}

function mark(text, defs) {
  const h = esc(text); if (!defs.length) return h;
  const by = Object.fromEntries(defs.map(d => [esc(d.term).toLowerCase(), d.id]));
  const find = w => { w = w.toLowerCase(); return by[w] ?? by[w.replace(/es$/, '')] ?? by[w.replace(/s$/, '')]; };  // plurals: sensors -> sensor
  const alt = defs.map(d => esc(d.term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).sort((a, b) => b.length - a.length).join('|');
  return h.replace(new RegExp('(?<!\\w)(' + alt + ')(?:e?s)?(?!\\w)', 'gi'), m => `<span class="term" data-id="${find(m)}">${m}</span>`);
}

let tipEl, tipTimer;
function hideTip() { clearTimeout(tipTimer); if (tipEl) tipEl.remove(); tipEl = null; }
function hideSoon() { tipTimer = setTimeout(hideTip, 250); }
function tip(el, d) {
  hideTip();
  tipEl = document.createElement('div'); tipEl.id = 'tip';
  tipEl.innerHTML = `<b>${esc(d.term)}</b><p>${esc(d.definition)}</p>${d.src ? `<small>from “${esc(d.src)}”</small><br>` : ''}` + (d.status == 'pending'
    ? '<small>Is this useful?</small> <button data-a="yes">Yes</button> <button data-a="no" class="ghost">No</button>'
    : '<button data-a="no" class="ghost">Remove</button>');
  document.body.append(tipEl);
  const r = el.getBoundingClientRect();
  tipEl.style.left = Math.max(8, Math.min(r.left + scrollX, innerWidth - 300)) + 'px';
  tipEl.style.top = (r.bottom + scrollY + 6) + 'px';
  tipEl.onmouseenter = () => clearTimeout(tipTimer); tipEl.onmouseleave = hideSoon;
  tipEl.querySelectorAll('button').forEach(b => b.onclick = async () => {
    await api('/defs/' + d.id, 'POST', {action: b.dataset.a});
    if (b.dataset.a == 'yes') { d.status = 'ok'; tip(el, d); }
    else { document.querySelectorAll(`.term[data-id="${d.id}"]`).forEach(t => t.replaceWith(t.textContent)); hideTip(); }
  });
}

function wizard() {
  const w = wiz; let h = `<div class="card"><p class="crumb">${esc(w.subject)}${w.topic ? ' › ' + esc(w.topic) : ''}</p>`;
  if (w.step < 3) {
    const key = w.step == 1 ? 'subject' : 'topic';
    const opts = [...new Set(w.step == 1 ? books.map(b => b.name) : notes.filter(n => n.subject === w.subject).map(n => n.topic))];
    h += `<h2>Select ${key}</h2><div class="opts">${opts.map(o => `<button class="chip" data-v="${esc(o)}">${esc(o)}</button>`).join('')}</div>
      <div class="row"><input id="nv" placeholder="${opts.length ? '…or type a new' : 'Type a new'} ${key} name"><button id="go">Next</button></div>${w.step == 1 ? '<label>Cover photo for a new book (optional, it becomes a cartoon!)<input type="file" id="cv" accept="image/*"></label>' : ''}`;
  } else if (w.step == 3) {
    h += `<h2>Select template</h2><div class="opts">${TPL.map(([k, t, d]) => `<button class="chip tpl" data-v="${k}"><b>${t}</b><small>${d}</small></button>`).join('')}</div>`;
  } else {
    h += `<h2>Add your note</h2><form id="nf"><input name="title" placeholder="Title (optional when uploading)">
      ${w.template === 'timeline' ? '<p class="crumb">📅 <b>Rules:</b> start each event on a new line with the <b>year</b>, then <b>:</b> (or " - "). Lines below it (no year) are extra detail for that event. Same year twice? Both show under that year. Ranges (1939-1945) and BC (500 BC) work.</p>' : ''}${w.template === 'graph' ? '<p class="crumb">🕸 <b>Rules:</b> one link per line: <b>A -relation-> B</b> (spaces around it). Same name in two lines = same circle, even across different notes. A line with just a name adds a lone circle. Leave the relation out if you like: A -> B.</p>' : ''}${w.template === 'taxonomy' ? '<p class="crumb">🌳 One item per line. Press <b>Tab</b> to indent a line under the one above it (2 spaces or 4 spaces both work).</p>' : ''}<textarea name="content" rows="10" placeholder="${w.template === 'taxonomy' ? esc(TREE_EXAMPLE) : w.template === 'timeline' ? esc(TL_EXAMPLE) : w.template === 'graph' ? esc(KG_EXAMPLE) : 'Type or paste notes. Lines starting with # become tags.'}"></textarea>
      <label>…or upload a file (.docx, .txt, .md or any text file)<input type="file" name="file"></label><button>Save note</button><p class="err" id="e"></p></form>`;
  }
  $('#pane').innerHTML = h + '<button class="ghost" id="cancel">Cancel</button></div>';
  $('#cancel').onclick = list;
  const next = (k, v) => { if (!v) return; w[k] = v; w.step++; wizard(); };
  const key = w.step == 1 ? 'subject' : 'topic';
  document.querySelectorAll('.chip').forEach(c => c.onclick = () => next(w.step == 3 ? 'template' : key, c.dataset.v));
  if ($('#go')) { $('#go').onclick = async () => { const v = $('#nv').value.trim(); if (!v) return;
      if (w.step == 1) { const f = $('#cv').files[0]; await api('/subjects', 'POST', {name: v, cover: f ? await cartoon(f) : null}); await load(); tree(); }
      next(key, v); }; $('#nv').onkeydown = e => { if (e.key == 'Enter') $('#go').click(); }; }
  if ($('#nf') && w.template === 'taxonomy') $('#nf textarea').onkeydown = e => { if (e.key == 'Tab') { e.preventDefault(); e.target.setRangeText('  ', e.target.selectionStart, e.target.selectionEnd, 'end'); } };
  if ($('#nf')) $('#nf').onsubmit = async e => { e.preventDefault();
    const f = e.target.file.files[0];
    try { await api('/notes', 'POST', {subject: w.subject, topic: w.topic, template: w.template, title: e.target.title.value, content: e.target.content.value, file: f ? {name: f.name, data: await b64(f)} : undefined});
      sel = {subject: w.subject, topic: w.topic}; await load(); tree(); list(); }
    catch (x) { $('#e').textContent = x.message; } };
}

function account() {
  $('#pane').innerHTML = `<div class="card"><h2>Account</h2><p>${esc(me.username)} · ${esc(me.email)} · joined ${esc(me.created.slice(0, 10))}</p>
    <h3>Change password</h3><form id="pf"><input name="current" type="password" placeholder="Current password" required><input name="new" type="password" placeholder="New password (8+)" required><button>Update</button><p class="err" id="e"></p></form>
    <h3>Delete account</h3><button class="ghost" id="del">Delete my account and all notes</button></div>`;
  $('#pf').onsubmit = async e => { e.preventDefault(); try { await api('/account/password', 'POST', Object.fromEntries(new FormData(e.target))); $('#e').textContent = 'Password updated'; e.target.reset(); } catch (x) { $('#e').textContent = x.message; } };
  $('#del').onclick = async () => { const pw = prompt('Enter your password to permanently delete your account:'); if (!pw) return;
    try { await api('/account/delete', 'POST', {password: pw}); authView(); } catch (x) { alert(x.message); } };
}
// ---- Inkspire visual effects (no app logic) ----
const calm = matchMedia('(prefers-reduced-motion: reduce)');
document.addEventListener('pointerdown', e => {
  if (calm.matches || !e.target.closest('button, .book, .tl-pt, .chip')) return;
  const s = document.createElement('span'); s.className = 'splat'; s.style.left = e.clientX + 'px'; s.style.top = e.clientY + 'px';
  for (let i = 0; i < 6; i++) { const d = document.createElement('i'); d.style.setProperty('--a', (i * 60 + Math.random() * 40) + 'deg'); d.style.setProperty('--d', (22 + Math.random() * 26) + 'px'); d.style.setProperty('--s', (.5 + Math.random() * .8).toFixed(2)); s.append(d); }
  document.body.append(s); setTimeout(() => s.remove(), 700);
});
document.addEventListener('pointermove', e => { const st = document.querySelector('.stage'); if (!st || calm.matches) return;
  st.style.setProperty('--mx', (e.clientX / innerWidth - .5).toFixed(3)); st.style.setProperty('--my', (e.clientY / innerHeight - .5).toFixed(3)); });

boot();
