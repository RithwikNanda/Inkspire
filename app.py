"""Inkspire - Step 1. Python standard library only. Run: python app.py"""
import http.server, sqlite3, json, os, re, secrets, hashlib, base64, zipfile, io, hmac
from xml.etree import ElementTree as ET
from urllib.parse import urlparse, parse_qs

ROOT = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(ROOT, 'static')
DB = os.path.join(ROOT, 'notes.db')
TEMPLATES = ('none', 'timeline', 'taxonomy', 'graph')

def con():
    c = sqlite3.connect(DB); c.row_factory = sqlite3.Row
    c.execute('PRAGMA foreign_keys=ON'); return c

def init():
    c = con()
    c.executescript('''
    CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, username TEXT UNIQUE COLLATE NOCASE, email TEXT UNIQUE COLLATE NOCASE, salt BLOB, pw BLOB, created TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS notes(id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, subject TEXT, topic TEXT, template TEXT, title TEXT, content TEXT, tags TEXT, created TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS definitions(id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, note_id INTEGER REFERENCES notes(id) ON DELETE CASCADE, term TEXT COLLATE NOCASE, definition TEXT, status TEXT DEFAULT 'pending', UNIQUE(note_id, term));
    CREATE TABLE IF NOT EXISTS rejected(user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, term TEXT COLLATE NOCASE, UNIQUE(user_id, term));
    CREATE TABLE IF NOT EXISTS subjects(user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, name TEXT COLLATE NOCASE, cover TEXT, UNIQUE(user_id, name));
    CREATE TABLE IF NOT EXISTS reminders(id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, note_id INTEGER REFERENCES notes(id) ON DELETE CASCADE, due TEXT, text TEXT, done INTEGER DEFAULT 0);
    ''')
    for alter in ('ALTER TABLE notes ADD COLUMN bookmarked INTEGER DEFAULT 0', 'ALTER TABLE subjects ADD COLUMN favourite INTEGER DEFAULT 0', 'ALTER TABLE definitions ADD COLUMN manual INTEGER DEFAULT 0',
                  "ALTER TABLE notes ADD COLUMN kw_off TEXT DEFAULT '[]'", "ALTER TABLE notes ADD COLUMN kw_on TEXT DEFAULT '[]'"):
        try: c.execute(alter)
        except sqlite3.OperationalError: pass
    c.execute('INSERT OR IGNORE INTO subjects(user_id,name) SELECT DISTINCT user_id,subject FROM notes')
    for n in c.execute('SELECT id,user_id,content,template FROM notes').fetchall():
        save_defs(c, n['user_id'], n['id'], n['content'])
        c.execute('UPDATE notes SET tags=? WHERE id=?', (json.dumps(tags_for(n['template'], n['content'])), n['id']))
    c.commit()

def hash_pw(pw, salt): return hashlib.pbkdf2_hmac('sha256', pw.encode(), salt, 200_000)

def docx_text(raw):
    ns = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
    root = ET.fromstring(zipfile.ZipFile(io.BytesIO(raw)).read('word/document.xml'))
    out = []
    for p in root.iter(ns + 'p'):
        t = ''.join(x.text or '' for x in p.iter(ns + 't'))
        st = p.find(f'{ns}pPr/{ns}pStyle')
        def bold(r):
            b = r.find(f'{ns}rPr/{ns}b')
            return b is not None and b.get(ns + 'val', '1') not in ('0', 'false')
        runs = [r for r in p.iter(ns + 'r') if ''.join(x.text or '' for x in r.iter(ns + 't')).strip()]
        is_style = st is not None and st.get(ns + 'val', '').lower().startswith(('heading', 'title'))
        is_bold = bool(runs) and all(bold(r) for r in runs) and len(t) < 80 and not t.rstrip().endswith('.')
        if t and (is_style or is_bold):
            t = '# ' + t  # Word heading styles and fully-bold short lines become headings
        lvl = p.find(f'{ns}pPr/{ns}numPr/{ns}ilvl')  # Word bullet/list level -> indentation
        out.append('  ' * int(lvl.get(ns + 'val', '0')) + t if lvl is not None and t else t)
    return '\n'.join(out)

def headings(text):
    """Tags from headings, no '#' needed: markdown #, numbered (1. / 1.2), Chapter/Section N, 'Title:',
    ALL CAPS, underlined (=== / ---) and short standalone title-like lines. Word headings/bold lines arrive as '#'."""
    lines = [l.strip() for l in text.splitlines()]
    tags = []
    for i, l in enumerate(lines):
        if not l: continue
        prev_blank = i == 0 or not lines[i - 1]
        nxt = next((x for x in lines[i + 1:] if x), '')
        under = lines[i + 1] if i + 1 < len(lines) else ''
        words, h = len(l.split()), None
        m = re.match(r'^#{1,6}\s+(.+)', l)
        if m: h = m.group(1)
        elif re.fullmatch(r'[=\-~]{3,}', under) and 2 < len(l) < 80: h = l
        elif re.fullmatch(r'\d{1,2}([.)]|(\.\d+)+[.)]?)\s+[A-Za-z].*', l) and words <= 8 and not l.endswith(('.', ',', ';')): h = l
        elif re.match(r'(chapter|section|unit|topic|part|lesson)\s+\w+', l, re.I) and len(l) < 70: h = l
        elif l.endswith(':') and 2 < len(l) < 60: h = l
        elif l.isupper() and 2 < len(l) < 60: h = l
        elif prev_blank and nxt and words <= 7 and 2 < len(l) < 60 and l[0].isupper() \
                and not l.endswith(('.', ',', ';', '?', '!')) and not re.match(r'[-*•]', l): h = l
        if h:
            h = re.sub(r'^\d{1,2}([.)]|(\.\d+)+[.)]?)\s+', '', h).strip(' :')
            if h and h.lower() not in [t.lower() for t in tags]: tags.append(h)
    return tags[:20]

def outline_labels(text):
    """Hierarchical template: the note is an indented outline (like Python). Every line is a node; the indent says its level."""
    out = []
    for l in text.splitlines():
        l = re.sub(r'^[-*\u2022#]+\s*', '', l.strip())
        if l and l.lower() not in [x.lower() for x in out]: out.append(l)
    return out[:60]

GRAPH_LINK = re.compile(r'^(.+?)\s+-+\s*(.*?)\s*-*>\s*(.+)$')  # 'A -label-> B'

def graph_nodes(text):
    """Knowledge-graph template: one link per line 'A -relation-> B' (a lone name is just a node). Tags = the node names."""
    out = []
    for l in text.splitlines():
        l = re.sub(r'^[-*\u2022]\s+', '', l.strip()); m = GRAPH_LINK.match(l)
        for x in ([m.group(1), m.group(3)] if m else [l]):
            x = x.strip()
            if x and x.lower() not in [o.lower() for o in out]: out.append(x)
    return out[:60]

TL_LINE = re.compile(r'^(?:[-*\u2022]\s*)?(?:(?:c|ca|circa)\.?\s*|~)?(\d{1,4})\s*(?:BCE?|AD|CE)?(?:\s*[-\u2013\u2014]\s*(\d{1,4})\s*(?:BCE?|AD|CE)?)?\s*(?::|\s[-\u2013\u2014]\s|\s*$)\s*(.*)$', re.I)  # same rule as the browser: "1969: Moon landing"

def timeline_labels(text):
    """Timeline template: tags come from the event titles (the text after the year), plus any headings."""
    out = list(headings(text))
    for l in text.splitlines():
        m = TL_LINE.match(l.strip()); t = m.group(3).strip(' .') if m else ''
        if t and t.lower() not in [x.lower() for x in out]: out.append(t[:80])
    return out[:60]

def tags_for(template, text):
    if template == 'timeline': return timeline_labels(text)
    if template == 'graph': return graph_nodes(text)
    return outline_labels(text) if template == 'taxonomy' else headings(text)

STOP = {'it', 'this', 'that', 'there', 'he', 'she', 'they', 'which', 'what', 'who', 'here', 'these', 'those', 'we', 'you', 'i', 'one'}
DEF = re.compile(r"^(?:(?:the|a|an)\s+)?([A-Za-z][\w\-']*(?:\s+[A-Za-z][\w\-']*){0,3}?)\s+(is defined as|is known as|is called|refers to|means|are|is)\s+(.+)$", re.I)

def extract_defs(text):
    """Rule-based (no AI): finds 'X is defined as / means / refers to / is a|an|the ...' sentences."""
    out = []
    for line in text.splitlines():
        line = re.sub(r'^\d+[.)]\s+', '', re.sub(r'^[\s#>*\-•]+', '', line))
        for s in re.split(r'(?<=[.!?])\s+', line):
            m = DEF.match(s.strip())
            if not m: continue
            term, verb, rest = m.group(1).strip(), m.group(2).lower(), m.group(3).strip().rstrip('.!?')
            if term.split()[0].lower() in STOP or len(term) > 40 or len(rest) < 8: continue
            weak = verb in ('is', 'are')
            if weak and not re.match(r'(a|an|the)\b', rest, re.I): continue
            out.append((term, rest[:300], 'pending' if weak else 'ok'))
    return out

def resync_defs(db, uid, nid, text):
    """After editing a note: drop auto-detected definitions whose sentence is gone, refresh changed ones, add new ones."""
    found = {}
    for t, d, st in extract_defs(text): found.setdefault(t.lower(), d)
    for x in db.execute('SELECT id,term FROM definitions WHERE note_id=? AND COALESCE(manual,0)=0', (nid,)).fetchall():
        if x['term'].lower() in found: db.execute('UPDATE definitions SET definition=? WHERE id=?', (found[x['term'].lower()], x['id']))
        else: db.execute('DELETE FROM definitions WHERE id=?', (x['id'],))
    save_defs(db, uid, nid, text)

def save_defs(db, uid, nid, text):
    for t, d, s in extract_defs(text):
        if db.execute('SELECT 1 FROM rejected WHERE user_id=? AND term=?', (uid, t)).fetchone(): continue
        db.execute('INSERT OR IGNORE INTO definitions(user_id,note_id,term,definition,status) VALUES(?,?,?,?,?)', (uid, nid, t, d, s))

# Words that are never useful as tags. STOPWORDS = grammar words; FILLER = words that only show up in
# generic headings ("Introduction", "Importance of ...", "Types of ..."). Add your own words to either set.
STOPWORDS = set("""a about above after again against all also am an and any are as at be because been before being below between both
but by can could did do does doing down during each few for from further had has have having he her here hers him his how i if in into is it
its just me more most my no nor not of off on once only or other our out over own same she should so some such than that the their theirs them
then there these they this those through to too under until up very was we were what when where which while who whom why will with would you
your vs via per etc eg ie""".split())
FILLER = set("""introduction intro overview summary conclusion notes note basics basic definition definitions importance important types type kinds
kind examples example advantages advantage disadvantages disadvantage benefits benefit uses use usage applications application features feature
concept concepts meaning key main general various common chapter section part unit topic lesson""".split())
GENERIC = STOPWORDS | FILLER
KEEP_S = {'bias', 'lens', 'news', 'series', 'species', 'gas', 'always', 'perhaps', 'canvas', 'atlas', 'bus'}

def stem(w):
    """Light plural folding so 'sensors' and 'sensor' count as one word ('technologies' -> 'technology')."""
    w = w.lower()
    if w in KEEP_S or len(w) <= 3: return w
    if w.endswith('ies') and len(w) > 4: return w[:-3] + 'y'
    if w.endswith(('sses', 'xes', 'ches', 'shes')): return w[:-2]
    return w[:-1] if w.endswith('s') and not w.endswith(('ss', 'ics', 'us', 'is')) else w

def heading_words(h):
    """Meaningful words of one heading, no repeats ('What is the importance of sensors' -> ['sensor'])."""
    out = []
    for w in re.findall(r"[A-Za-z][A-Za-z\-']*", h):
        if len(w) < 3 and not (len(w) == 2 and w.isupper()): continue   # keep acronyms like AI, ML
        k = stem(w.strip("-'"))
        if k and k not in GENERIC and k not in out: out.append(k)
    return out

def kws(tags):
    """Word-level tags for a note, each word once (used for the chips and for filtering)."""
    out = []
    for t in tags:
        for k in heading_words(t):
            if k not in out: out.append(k)
    return out

def kw_counts(tags):
    """How many headings use each word: 'Sensors and Perception' + 'Proximity Sensors' -> sensor: 2."""
    c = {}
    for t in tags:
        for k in heading_words(t): c[k] = c.get(k, 0) + 1
    return c

MAX_TAGS = 12   # most tags a note can show; users can remove automatic tags and add their own up to this limit

def _jl(s):
    try: return json.loads(s or '[]')
    except ValueError: return []

def note_kws(r):
    """A note's tags = automatic ones (from headings) minus the ones the user removed, plus the ones the user added."""
    off = set(_jl(r['kw_off']))
    out = [k for k in kws(json.loads(r['tags'])) if k not in off]
    return out + [k for k in _jl(r['kw_on']) if k not in out]

def note_kw_counts(r):
    off = set(_jl(r['kw_off']))
    c = {k: v for k, v in kw_counts(json.loads(r['tags'])).items() if k not in off}
    for k in _jl(r['kw_on']): c.setdefault(k, 1)
    return c

def word_counts(text):
    c = {}
    for w in re.findall(r"[A-Za-z][A-Za-z\-']+", text):
        k = stem(w); c[k] = c.get(k, 0) + 1
    return c

class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def out(self, code=200, obj=None, cookie=None):
        b = json.dumps(obj or {}).encode()
        self.send_response(code); self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(b)))
        if cookie: self.send_header('Set-Cookie', cookie)
        self.end_headers(); self.wfile.write(b)
    def user(self, db):
        m = re.search(r'sid=([\w-]+)', self.headers.get('Cookie', ''))
        self.tok = m.group(1) if m else None
        if not self.tok: return None
        return db.execute('SELECT u.* FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token=?', (self.tok,)).fetchone()
    def login(self, db, uid, name):
        t = secrets.token_urlsafe(32)
        db.execute('INSERT INTO sessions VALUES(?,?)', (t, uid)); db.commit()
        self.out(200, {'username': name}, f'sid={t}; HttpOnly; Path=/; SameSite=Strict; Max-Age=2592000')
    def do_GET(self): self.api('GET') if self.path.startswith('/api/') else self.static()
    def do_POST(self): self.api('POST')
    def do_DELETE(self): self.api('DELETE')
    def static(self):
        p = urlparse(self.path).path
        f = os.path.normpath(os.path.join(STATIC, 'index.html' if p == '/' else p.lstrip('/')))
        if not f.startswith(STATIC + os.sep) or not os.path.isfile(f): return self.out(404, {'error': 'Not found'})
        ct = {'.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript'}.get(os.path.splitext(f)[1], 'application/octet-stream')
        b = open(f, 'rb').read()
        self.send_response(200); self.send_header('Content-Type', ct + '; charset=utf-8')
        self.send_header('Content-Length', str(len(b))); self.end_headers(); self.wfile.write(b)

    def api(self, m):
        u = urlparse(self.path); p = u.path; q = parse_qs(u.query); d = {}
        if m == 'POST':
            n = int(self.headers.get('Content-Length') or 0)
            if n > 15_000_000: return self.out(413, {'error': 'File too large (max ~10 MB)'})
            try: d = json.loads(self.rfile.read(n) or b'{}')
            except ValueError: return self.out(400, {'error': 'Bad request'})
            if not isinstance(d, dict): return self.out(400, {'error': 'Bad request'})
        db = con()
        if p == '/api/register' and m == 'POST':
            un, em, pw = d.get('username', '').strip(), d.get('email', '').strip(), d.get('password', '')
            if len(un) < 3 or '@' not in em or len(pw) < 8:
                return self.out(400, {'error': 'Username 3+ chars, a valid email, password 8+ chars'})
            salt = secrets.token_bytes(16)
            try: cur = db.execute('INSERT INTO users(username,email,salt,pw) VALUES(?,?,?,?)', (un, em, salt, hash_pw(pw, salt)))
            except sqlite3.IntegrityError: return self.out(409, {'error': 'Username or email already taken'})
            db.commit(); return self.login(db, cur.lastrowid, un)
        if p == '/api/login' and m == 'POST':
            k = d.get('login', '').strip()
            r = db.execute('SELECT * FROM users WHERE username=? OR email=?', (k, k)).fetchone()
            if not r or not hmac.compare_digest(r['pw'], hash_pw(d.get('password', ''), r['salt'])):
                return self.out(401, {'error': 'Wrong username/email or password'})
            return self.login(db, r['id'], r['username'])
        me = self.user(db)
        if not me: return self.out(401, {'error': 'Please log in'})
        uid = me['id']
        if p == '/api/me': return self.out(200, {'username': me['username'], 'email': me['email'], 'created': me['created']})
        if p == '/api/logout':
            db.execute('DELETE FROM sessions WHERE token=?', (self.tok,)); db.commit()
            return self.out(200, {}, 'sid=; Path=/; Max-Age=0')
        if p == '/api/account/password' and m == 'POST':
            if not hmac.compare_digest(me['pw'], hash_pw(d.get('current', ''), me['salt'])) : return self.out(401, {'error': 'Current password is wrong'})
            if len(d.get('new', '')) < 8: return self.out(400, {'error': 'New password must be 8+ chars'})
            salt = secrets.token_bytes(16)
            db.execute('UPDATE users SET salt=?, pw=? WHERE id=?', (salt, hash_pw(d['new'], salt), uid)); db.commit()
            return self.out(200, {})
        if p == '/api/account/delete' and m == 'POST':
            if not hmac.compare_digest(me['pw'], hash_pw(d.get('password', ''), me['salt'])): return self.out(401, {'error': 'Wrong password'})
            db.execute('DELETE FROM users WHERE id=?', (uid,)); db.commit()
            return self.out(200, {}, 'sid=; Path=/; Max-Age=0')
        if p == '/api/notes' and m == 'GET':
            s = '%' + re.sub(r'([!%_])', r'!\1', q.get('q', [''])[0]) + '%'
            rows = db.execute("SELECT id,subject,topic,template,title,tags,kw_off,kw_on,COALESCE(bookmarked,0) bookmarked,created,substr(content,1,160) snippet FROM notes WHERE user_id=? AND (title LIKE ? ESCAPE '!' OR content LIKE ? ESCAPE '!' OR tags LIKE ? ESCAPE '!') ORDER BY id DESC", (uid, s, s, s)).fetchall()
            return self.out(200, {'notes': [{**{k: v for k, v in dict(r).items() if k not in ('kw_off', 'kw_on')}, 'tags': json.loads(r['tags']), 'kw': note_kws(r)} for r in rows]})
        if p == '/api/notes' and m == 'POST':
            sub, top, tpl = (d.get('subject') or '').strip(), (d.get('topic') or '').strip(), d.get('template', 'none')
            book = db.execute('SELECT name FROM subjects WHERE user_id=? AND name=?', (uid, sub)).fetchone()  # NOCASE match
            if book: sub = book['name']
            if not sub or not top or tpl not in TEMPLATES: return self.out(400, {'error': 'Subject, topic and template are required'})
            text, title, f = d.get('content') or '', (d.get('title') or '').strip(), d.get('file')
            if f:
                name = f.get('name', 'file')
                if name.lower().endswith('.doc'): return self.out(400, {'error': 'Old .doc is not supported - save it as .docx'})
                try:
                    raw = base64.b64decode(f['data'])
                    text = docx_text(raw) if name.lower().endswith('.docx') else raw.decode('utf-8', 'replace')
                except Exception: return self.out(400, {'error': 'Could not read that file'})
                title = title or os.path.splitext(name)[0]
            if not text.strip(): return self.out(400, {'error': 'The note is empty'})
            cur = db.execute('INSERT INTO notes(user_id,subject,topic,template,title,content,tags) VALUES(?,?,?,?,?,?,?)',
                             (uid, sub, top, tpl, title or 'Untitled', text, json.dumps(tags_for(tpl, text)))); db.execute('INSERT OR IGNORE INTO subjects(user_id,name) VALUES(?,?)', (uid, sub)); save_defs(db, uid, cur.lastrowid, text); db.commit()
            return self.out(200, {'id': cur.lastrowid})
        if p == '/api/subjects' and m == 'GET':
            rows = db.execute('SELECT name, cover, COALESCE(favourite,0) favourite FROM subjects WHERE user_id=? ORDER BY rowid', (uid,)).fetchall()
            return self.out(200, {'subjects': [dict(r) for r in rows]})
        if p == '/api/subjects' and m == 'POST':
            name, cv = d.get('name', '').strip(), d.get('cover')
            if not name or len(name) > 60: return self.out(400, {'error': 'Give the book a name'})
            if cv and not (len(cv) < 400000 and re.fullmatch(r'data:image/jpeg;base64,[A-Za-z0-9+/=]+', cv)): return self.out(400, {'error': 'Bad cover image'})
            db.execute('INSERT OR IGNORE INTO subjects(user_id,name) VALUES(?,?)', (uid, name))
            if cv: db.execute('UPDATE subjects SET cover=? WHERE user_id=? AND name=?', (cv, uid, name))
            db.commit(); return self.out(200, {})
        if p == '/api/subjects/rename' and m == 'POST':
            old, new = str(d.get('name') or ''), re.sub(r'\s+', ' ', str(d.get('new') or '')).strip()
            if not new or len(new) > 60: return self.out(400, {'error': 'Give the book a name'})
            if not db.execute('SELECT 1 FROM subjects WHERE user_id=? AND name=?', (uid, old)).fetchone(): return self.out(404, {'error': 'Not found'})
            clash = db.execute('SELECT name FROM subjects WHERE user_id=? AND name=?', (uid, new)).fetchone()   # NOCASE match
            if clash and clash['name'].lower() != old.lower(): return self.out(400, {'error': 'You already have a book with that name'})
            db.execute('UPDATE subjects SET name=? WHERE user_id=? AND name=?', (new, uid, old))
            db.execute('UPDATE notes SET subject=? WHERE user_id=? AND subject=? COLLATE NOCASE', (new, uid, old))
            db.commit(); return self.out(200, {'name': new})
        if p == '/api/subjects/delete' and m == 'POST':   # removes the book and every note in it (definitions and reminders go with the notes)
            name = str(d.get('name') or '')
            db.execute('DELETE FROM notes WHERE user_id=? AND subject=? COLLATE NOCASE', (uid, name))
            db.execute('DELETE FROM subjects WHERE user_id=? AND name=?', (uid, name)); db.commit(); return self.out(200, {})
        if p == '/api/subjects/favourite' and m == 'POST':
            db.execute('UPDATE subjects SET favourite = 1 - COALESCE(favourite,0) WHERE user_id=? AND name=?', (uid, d.get('name', ''))); db.commit(); return self.out(200, {})
        if p == '/api/tags' and m == 'GET':
            cnt = {}
            for r in db.execute('SELECT tags,kw_off,kw_on FROM notes WHERE user_id=?', (uid,)):
                for t, n in note_kw_counts(r).items(): cnt[t] = cnt.get(t, 0) + n
            return self.out(200, {'tags': [{'tag': k, 'count': v} for k, v in sorted(cnt.items(), key=lambda kv: -kv[1])]})
        if p == '/api/reminders' and m == 'GET':
            rows = db.execute('SELECT r.id,r.note_id,r.due,r.text,r.done,n.title FROM reminders r JOIN notes n ON n.id=r.note_id WHERE r.user_id=? ORDER BY r.done, r.due', (uid,)).fetchall()
            return self.out(200, {'reminders': [dict(r) for r in rows]})
        if p == '/api/reminders' and m == 'POST':
            due = d.get('due', '')
            if not re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d', due) or not db.execute('SELECT 1 FROM notes WHERE id=? AND user_id=?', (d.get('note_id'), uid)).fetchone():
                return self.out(400, {'error': 'Pick a date and time'})
            db.execute('INSERT INTO reminders(user_id,note_id,due,text) VALUES(?,?,?,?)', (uid, d['note_id'], due, d.get('text', '')[:200])); db.commit(); return self.out(200, {})
        rm = re.fullmatch(r'/api/reminders/(\d+)(/done)?', p)
        if rm:
            if m == 'POST' and rm.group(2): db.execute('UPDATE reminders SET done=1 WHERE id=? AND user_id=?', (rm.group(1), uid))
            elif m == 'DELETE' and not rm.group(2): db.execute('DELETE FROM reminders WHERE id=? AND user_id=?', (rm.group(1), uid))
            db.commit(); return self.out(200, {})
        tm = re.fullmatch(r'/api/notes/(\d+)/tags', p)
        if tm and m == 'POST':   # remove an automatic tag or add your own (a note can show at most MAX_TAGS)
            r = db.execute('SELECT tags,kw_off,kw_on FROM notes WHERE id=? AND user_id=?', (tm.group(1), uid)).fetchone()
            if not r: return self.out(404, {'error': 'Not found'})
            tag = re.sub(r'\s+', ' ', str(d.get('tag') or '')).strip().lower()
            if not re.fullmatch(r"[a-z][a-z0-9\-' ]{1,29}", tag): return self.out(400, {'error': 'A tag is 2 to 30 letters, e.g. sensor'})
            if ' ' not in tag: tag = stem(tag)
            off, on, cur = _jl(r['kw_off']), _jl(r['kw_on']), note_kws(r)
            if d.get('action') == 'remove':
                if tag in on: on.remove(tag)
                elif tag in cur: off.append(tag)
            elif d.get('action') == 'add':
                if tag not in cur:
                    if len(cur) >= MAX_TAGS: return self.out(400, {'error': f'A note can have at most {MAX_TAGS} tags. Remove one first.'})
                    if tag in off: off.remove(tag)
                    else: on.append(tag)
            else: return self.out(400, {'error': 'Unknown action'})
            db.execute('UPDATE notes SET kw_off=?, kw_on=? WHERE id=?', (json.dumps(off), json.dumps(on), tm.group(1))); db.commit()
            return self.out(200, {'kw': note_kws({'tags': r['tags'], 'kw_off': json.dumps(off), 'kw_on': json.dumps(on)})})
        sm = re.fullmatch(r'/api/notes/(\d+)/(related|bookmark)', p)
        if sm:
            nid = sm.group(1); cur_note = db.execute('SELECT tags, kw_off, kw_on, content, COALESCE(bookmarked,0) b FROM notes WHERE id=? AND user_id=?', (nid, uid)).fetchone()
            if not cur_note: return self.out(404, {'error': 'Not found'})
            if sm.group(2) == 'bookmark' and m == 'POST':
                v = 1 - cur_note['b']; db.execute('UPDATE notes SET bookmarked=? WHERE id=?', (v, nid)); db.commit(); return self.out(200, {'bookmarked': v})
            mine = note_kws(cur_note); mc = word_counts(cur_note['content']); rel = []
            for r in db.execute('SELECT id,title,subject,topic,tags,kw_off,kw_on,content FROM notes WHERE user_id=? AND id!=?', (uid, nid)):
                rc = word_counts(r['content']); shared = [{'word': k, 'n': mc.get(k, 0) + rc.get(k, 0)} for k in note_kws(r) if k in mine]
                if shared: rel.append({'id': r['id'], 'title': r['title'], 'subject': r['subject'], 'topic': r['topic'], 'shared': sorted(shared, key=lambda s: -s['n']), 'score': sum(s['n'] for s in shared)})
            rel.sort(key=lambda x: -x['score']); return self.out(200, {'related': rel[:10]})
        if p == '/api/defs' and m == 'POST':  # write (or overwrite) a definition by hand, e.g. from a tree node
            term, text = re.sub(r'\s+', ' ', str(d.get('term') or '')).strip(), str(d.get('definition') or '').strip()
            if not term or len(term) > 80 or not text: return self.out(400, {'error': 'Write a definition first'})
            if not db.execute('SELECT 1 FROM notes WHERE id=? AND user_id=?', (d.get('note_id'), uid)).fetchone(): return self.out(404, {'error': 'Not found'})
            db.execute('DELETE FROM rejected WHERE user_id=? AND term=?', (uid, term))
            db.execute("INSERT INTO definitions(user_id,note_id,term,definition,status,manual) VALUES(?,?,?,?,'ok',1) ON CONFLICT(note_id,term) DO UPDATE SET definition=excluded.definition, status='ok', manual=1", (uid, d['note_id'], term, text[:1000]))
            db.commit(); return self.out(200, {})
        dm = re.fullmatch(r'/api/defs/(\d+)', p)
        if dm and m == 'POST':
            r = db.execute('SELECT term FROM definitions WHERE id=? AND user_id=?', (dm.group(1), uid)).fetchone()
            if not r: return self.out(404, {'error': 'Not found'})
            if d.get('action') == 'yes': db.execute("UPDATE definitions SET status='ok' WHERE id=?", (dm.group(1),))
            else:  # "No": remove from the definitions table and never suggest this term again
                db.execute('DELETE FROM definitions WHERE user_id=? AND term=?', (uid, r['term']))
                db.execute('INSERT OR IGNORE INTO rejected VALUES(?,?)', (uid, r['term']))
            db.commit(); return self.out(200, {})
        mm = re.fullmatch(r'/api/notes/(\d+)', p)
        if mm and m == 'GET':
            r = db.execute('SELECT * FROM notes WHERE id=? AND user_id=?', (mm.group(1), uid)).fetchone()
            if not r: return self.out(404, {'error': 'Not found'})
            defs = [dict(x) for x in db.execute('SELECT id,term,definition,status FROM definitions WHERE note_id=? AND user_id=?', (r['id'], uid))]
            have = {x['term'].lower() for x in defs}  # also reuse definitions written in any other note (same book first, then other books)
            for x in db.execute("SELECT d.id,d.term,d.definition,d.status,n.title src FROM definitions d JOIN notes n ON n.id=d.note_id WHERE d.user_id=? AND d.note_id!=? ORDER BY COALESCE(d.manual,0) DESC, n.subject=? DESC, d.status='ok' DESC, d.id", (uid, r['id'], r['subject'])):
                t = x['term'].lower()
                if t not in have and re.search(r'(?<!\w)' + re.escape(t) + r'(?:e?s)?(?!\w)', r['content'], re.I): defs.append(dict(x)); have.add(t)
            return self.out(200, {**{k: v for k, v in dict(r).items() if k not in ('kw_off', 'kw_on')}, 'tags': json.loads(r['tags']), 'kw': note_kws(r), 'max_tags': MAX_TAGS, 'defs': defs})
        if mm and m == 'POST':   # edit title / text; tags and auto-detected definitions are recalculated
            r = db.execute('SELECT id,template,title,content FROM notes WHERE id=? AND user_id=?', (mm.group(1), uid)).fetchone()
            if not r: return self.out(404, {'error': 'Not found'})
            text = d['content'] if isinstance(d.get('content'), str) else r['content']
            title = str(d.get('title') or '').strip()[:200] or r['title']
            if not text.strip(): return self.out(400, {'error': 'The note is empty'})
            db.execute('UPDATE notes SET title=?, content=?, tags=? WHERE id=?', (title, text, json.dumps(tags_for(r['template'], text)), r['id']))
            resync_defs(db, uid, r['id'], text); db.commit(); return self.out(200, {})
        if mm and m == 'DELETE':
            db.execute('DELETE FROM notes WHERE id=? AND user_id=?', (mm.group(1), uid)); db.commit(); return self.out(200, {})
        self.out(404, {'error': 'Not found'})

if __name__ == '__main__':
    init(); port = int(os.environ.get('PORT', 8000))
    print(f'Inkspire running at http://localhost:{port}')
    http.server.ThreadingHTTPServer(('127.0.0.1', port), H).serve_forever()
