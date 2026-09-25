import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomInt } from 'node:crypto';
import { nowIso, randomId, randomToken, tokenHash, safeEqualHex } from './security.mjs';

const dbTimeZones = new WeakMap();

export function resolveTimeZone(value) {
  const timeZone = String(value || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC').trim();
  try { new Intl.DateTimeFormat('en-US', { timeZone }).format(0); }
  catch { throw new Error(`Invalid TZ value: ${timeZone}. Use an IANA time zone such as Europe/Rome.`); }
  return timeZone;
}

function zonedDateFormatter(timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone, year:'numeric', month:'2-digit', day:'2-digit' });
  return epochSeconds => {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(Number(epochSeconds) * 1000)).map(part => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  };
}

function tableColumns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name));
}

function ensureColumn(db, table, column, definition) {
  if (!tableColumns(db, table).has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export function openAppDb(dataDir, { timeZone } = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'kovi.sqlite'));
  const resolvedTimeZone = resolveTimeZone(timeZone);
  const localDay = zonedDateFormatter(resolvedTimeZone);
  db.function('kovi_local_day', { deterministic:true }, localDay);
  dbTimeZones.set(db, resolvedTimeZone);
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA foreign_keys=ON;
    PRAGMA busy_timeout=5000;

    CREATE TABLE IF NOT EXISTS books (
      id TEXT PRIMARY KEY,
      source_md5 TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      authors TEXT,
      notes INTEGER NOT NULL DEFAULT 0,
      last_open INTEGER NOT NULL DEFAULT 0,
      highlights INTEGER NOT NULL DEFAULT 0,
      pages INTEGER NOT NULL DEFAULT 0,
      series TEXT,
      language TEXT,
      identifiers TEXT,
      isbn TEXT,
      total_read_time INTEGER NOT NULL DEFAULT 0,
      total_read_pages INTEGER NOT NULL DEFAULT 0,
      koreader_status TEXT CHECK(koreader_status IN ('reading','abandoned','complete')),
      koreader_status_modified TEXT,
      read_override INTEGER CHECK(read_override IN (0,1)),
      read_override_at INTEGER,
      cover_status TEXT NOT NULL DEFAULT 'pending' CHECK(cover_status IN ('pending','matched','none','error','manual')),
      cover_path TEXT,
      cover_source TEXT,
      cover_retry_mode TEXT,
      cover_checked_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS reading_sessions (
      id TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL UNIQUE,
      book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      device_id TEXT,
      page INTEGER NOT NULL DEFAULT 0,
      start_time INTEGER NOT NULL,
      duration INTEGER NOT NULL,
      total_pages INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_book_start ON reading_sessions(book_id, start_time DESC);
    CREATE INDEX IF NOT EXISTS idx_sessions_start ON reading_sessions(start_time);

    CREATE TABLE IF NOT EXISTS annotations (
      id TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL,
      book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      device_id TEXT NOT NULL,
      annotation_type TEXT NOT NULL CHECK(annotation_type IN ('highlight','note','bookmark')),
      text TEXT,
      note TEXT,
      chapter TEXT,
      page TEXT,
      pageno INTEGER,
      total_pages INTEGER,
      annotation_datetime TEXT,
      color TEXT,
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_annotations_source ON annotations(book_id, device_id, fingerprint);
    CREATE INDEX IF NOT EXISTS idx_annotations_book_date ON annotations(book_id, annotation_datetime DESC);

    CREATE TABLE IF NOT EXISTS imports (
      id TEXT PRIMARY KEY,
      source_hash TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL,
      filename TEXT,
      file_size INTEGER NOT NULL DEFAULT 0,
      books_seen INTEGER NOT NULL DEFAULT 0,
      new_books INTEGER NOT NULL DEFAULT 0,
      sessions_seen INTEGER NOT NULL DEFAULT 0,
      new_sessions INTEGER NOT NULL DEFAULT 0,
      warnings_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      name TEXT,
      model TEXT,
      plugin_version TEXT,
      token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      last_seen_at TEXT,
      last_sync_at TEXT,
      sync_cursor INTEGER NOT NULL DEFAULT 0,
      last_sync_mode TEXT,
      last_sync_books INTEGER NOT NULL DEFAULT 0,
      last_sync_stats INTEGER NOT NULL DEFAULT 0,
      last_sync_new_sessions INTEGER NOT NULL DEFAULT 0,
      last_sync_annotation_sets INTEGER NOT NULL DEFAULT 0,
      last_sync_annotations INTEGER NOT NULL DEFAULT 0,
      revoked_at TEXT
    );

    CREATE TABLE IF NOT EXISTS sync_runs (
      id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      mode TEXT NOT NULL,
      cursor_before INTEGER NOT NULL DEFAULT 0,
      cursor_after INTEGER NOT NULL DEFAULT 0,
      books_seen INTEGER NOT NULL DEFAULT 0,
      sessions_seen INTEGER NOT NULL DEFAULT 0,
      new_sessions INTEGER NOT NULL DEFAULT 0,
      annotation_sets INTEGER NOT NULL DEFAULT 0,
      annotations_stored INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sync_runs_device_time ON sync_runs(device_id,created_at DESC);

    CREATE TABLE IF NOT EXISTS cover_jobs (
      book_id TEXT PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
      state TEXT NOT NULL CHECK(state IN ('queued','running','done','error')),
      reason TEXT NOT NULL,
      force_online INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0,
      requested_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      last_error TEXT,
      result_status TEXT,
      result_source TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_cover_jobs_state_time ON cover_jobs(state,requested_at);

    CREATE TABLE IF NOT EXISTS book_covers (
      id TEXT PRIMARY KEY,
      book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      source TEXT,
      strategy TEXT,
      score REAL,
      matched_title TEXT,
      cover_status TEXT NOT NULL,
      selected INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_book_covers_book_time ON book_covers(book_id,created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_book_covers_selected ON book_covers(book_id) WHERE selected=1;

    CREATE TABLE IF NOT EXISTS cover_candidates (
      id TEXT PRIMARY KEY,
      book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      source TEXT NOT NULL,
      strategy TEXT,
      score REAL NOT NULL DEFAULT 0,
      title TEXT,
      authors TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_cover_candidates_book_time ON cover_candidates(book_id,created_at DESC);

    CREATE TABLE IF NOT EXISTS pairing_codes (
      code_hash TEXT PRIMARY KEY,
      request_id TEXT,
      label TEXT,
      expires_at INTEGER NOT NULL,
      used_at INTEGER,
      paired_device_id TEXT
    );
  `);

  // Additive in-place schema upgrades for existing databases.
  ensureColumn(db, 'pairing_codes', 'request_id', 'TEXT');
  ensureColumn(db, 'pairing_codes', 'paired_device_id', 'TEXT');
  ensureColumn(db, 'books', 'identifiers', 'TEXT');
  ensureColumn(db, 'books', 'isbn', 'TEXT');
  ensureColumn(db, 'books', 'cover_retry_mode', 'TEXT');
  ensureColumn(db, 'books', 'koreader_status', `TEXT CHECK(koreader_status IN ('reading','abandoned','complete'))`);
  ensureColumn(db, 'books', 'koreader_status_modified', 'TEXT');
  ensureColumn(db, 'books', 'read_override', 'INTEGER CHECK(read_override IN (0,1))');
  ensureColumn(db, 'books', 'read_override_at', 'INTEGER');
  ensureColumn(db, 'devices', 'last_sync_at', 'TEXT');
  ensureColumn(db, 'devices', 'sync_cursor', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'devices', 'last_sync_mode', 'TEXT');
  ensureColumn(db, 'devices', 'last_sync_books', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'devices', 'last_sync_stats', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'devices', 'last_sync_new_sessions', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'devices', 'last_sync_annotation_sets', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'devices', 'last_sync_annotations', 'INTEGER NOT NULL DEFAULT 0');
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_pairing_request_id ON pairing_codes(request_id) WHERE request_id IS NOT NULL;`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_books_isbn ON books(isbn) WHERE isbn IS NOT NULL;`);

  // The same KOReader page-stat row can arrive via manual upload and via a paired
  // device. Fingerprints differ by ingestion path, which would double-count identical
  // reading sessions. Normalize once by the event's stable fields, then let SQLite
  // enforce uniqueness forever.
  const hasSessionEventIndex = db.prepare(`SELECT 1 ok FROM sqlite_master WHERE type='index' AND name='idx_sessions_event'`).get();
  if (!hasSessionEventIndex) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(`DELETE FROM reading_sessions
        WHERE rowid NOT IN (
          SELECT MIN(rowid) FROM reading_sessions
          GROUP BY book_id,page,start_time,duration,total_pages
        )`);
      db.exec(`CREATE UNIQUE INDEX idx_sessions_event ON reading_sessions(book_id,page,start_time,duration,total_pages);`);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }

  // Backfill a single selected history entry when no cover history is recorded.
  const missingHistory=db.prepare(`SELECT id,cover_path,cover_source,cover_status,cover_checked_at,updated_at FROM books WHERE cover_path IS NOT NULL AND NOT EXISTS (SELECT 1 FROM book_covers c WHERE c.book_id=books.id)`).all();
  const addHistory=db.prepare(`INSERT INTO book_covers(id,book_id,path,source,strategy,score,matched_title,cover_status,selected,created_at) VALUES(?,?,?,?,NULL,NULL,NULL,?,1,?)`);
  for(const row of missingHistory) addHistory.run(randomId(16),row.id,row.cover_path,row.cover_source,row.cover_status,row.cover_checked_at||row.updated_at||nowIso());
  return db;
}

function completionView(book) {
  const total=Number(book.last_total_pages||book.pages||0),page=Number(book.last_page||0);
  const inferred=total>0 && Math.round(page/total*100)>=100;
  const isRead=book.read_override == null ? book.koreader_status==='complete'||inferred : Boolean(book.read_override);
  const readSource=book.read_override != null?'manual':book.koreader_status==='complete'?'koreader':inferred?'progress':null;
  return {...book,is_read:isRead?1:0,read_source:readSource};
}

export function listBooks(db) {
  return db.prepare(`
    SELECT b.*,
      COALESCE((SELECT MAX(start_time) FROM reading_sessions s WHERE s.book_id=b.id), b.last_open) AS recent_read,
      COALESCE((SELECT SUM(duration) FROM reading_sessions s WHERE s.book_id=b.id), 0) AS session_read_time,
      (SELECT page FROM reading_sessions s WHERE s.book_id=b.id ORDER BY start_time DESC LIMIT 1) AS last_page,
      (SELECT total_pages FROM reading_sessions s WHERE s.book_id=b.id ORDER BY start_time DESC LIMIT 1) AS last_total_pages,
      (SELECT COUNT(*) FROM (SELECT fingerprint FROM annotations a WHERE a.book_id=b.id AND a.annotation_type IN ('highlight','note') GROUP BY fingerprint)) AS synced_highlights
    FROM books b
    ORDER BY recent_read DESC, title COLLATE NOCASE ASC
  `).all().map(completionView);
}

export function getBook(db, id) {
  const book = db.prepare(`
    SELECT b.*,
      (SELECT page FROM reading_sessions s WHERE s.book_id=b.id ORDER BY start_time DESC LIMIT 1) AS last_page,
      (SELECT total_pages FROM reading_sessions s WHERE s.book_id=b.id ORDER BY start_time DESC LIMIT 1) AS last_total_pages,
      (SELECT MAX(start_time) FROM reading_sessions s WHERE s.book_id=b.id) AS recent_read
    FROM books b WHERE b.id=?
  `).get(id);
  if (!book) return null;
  const annotations = db.prepare(`
    SELECT fingerprint, annotation_type, text, note, chapter, page, pageno, total_pages, annotation_datetime, color,
      MAX(created_at) AS synced_at
    FROM annotations
    WHERE book_id=? AND annotation_type IN ('highlight','note')
    GROUP BY fingerprint
    ORDER BY COALESCE(annotation_datetime,'') DESC, synced_at DESC
    LIMIT 500
  `).all(id);
  return { ...completionView(book), annotations };
}

export function setBookReadOverride(db, id, read, nowEpoch=Math.floor(Date.now()/1000)) {
  const value=read == null?null:read?1:0;
  const completedAt=value===1?Math.max(0,Math.floor(Number(nowEpoch)||0)):null;
  const result=db.prepare(`UPDATE books SET read_override=?,read_override_at=?,updated_at=? WHERE id=?`).run(value,completedAt,nowIso(),id);
  return result.changes?getBook(db,id):null;
}

function dateKey(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth()+1).padStart(2,'0')}-${String(date.getUTCDate()).padStart(2,'0')}`;
}

function parseDateKey(value) {
  const m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value||''));
  if(!m) return null;
  const date=new Date(Date.UTC(Number(m[1]),Number(m[2])-1,Number(m[3]),12,0,0,0));
  if(date.getUTCFullYear()!==Number(m[1]) || date.getUTCMonth()!==Number(m[2])-1 || date.getUTCDate()!==Number(m[3])) return null;
  return date;
}

export function dashboardRange({from,to}={}, now=new Date(), timeZone=resolveTimeZone()) {
  const today=parseDateKey(zonedDateFormatter(resolveTimeZone(timeZone))(now.getTime()/1000));
  let end=parseDateKey(to) || today;
  let start=parseDateKey(from);
  if(!start){start=new Date(end);start.setUTCDate(start.getUTCDate()-364)}
  if(start>end) [start,end]=[end,start];
  return {from:dateKey(start),to:dateKey(end)};
}

function queryEpochBounds(start, end) {
  // IANA UTC offsets are within one day; pad the indexed scan, then filter by local day.
  const startEpoch=Date.UTC(start.getUTCFullYear(),start.getUTCMonth(),start.getUTCDate()-1)/1000;
  const endExclusive=Date.UTC(end.getUTCFullYear(),end.getUTCMonth(),end.getUTCDate()+2)/1000;
  return {startEpoch,endExclusive};
}

export function getDashboard(db, range={}) {
  const selected=dashboardRange(range,new Date(),dbTimeZones.get(db));
  const start=parseDateKey(selected.from);
  const end=parseDateKey(selected.to);
  const {startEpoch,endExclusive}=queryEpochBounds(start,end);
  const totals = db.prepare(`SELECT COUNT(*) books, COALESCE(SUM(total_read_time),0) total_read_time, COALESCE(SUM(total_read_pages),0) total_read_pages, COALESCE(SUM(highlights),0) highlights FROM books`).get();
  const sessions = db.prepare(`SELECT COUNT(*) sessions, COALESCE(SUM(duration),0) session_seconds FROM reading_sessions`).get();
  const days = db.prepare(`
    SELECT kovi_local_day(start_time) day, SUM(duration) seconds
    FROM reading_sessions
    WHERE start_time >= ? AND start_time < ?
    GROUP BY day HAVING day >= ? AND day <= ? ORDER BY day
  `).all(startEpoch,endExclusive,selected.from,selected.to);
  const rangeSeconds=days.reduce((sum,row)=>sum+Number(row.seconds||0),0);
  const allTimeReadingSeconds=Number(totals.total_read_time||0)>0 ? Number(totals.total_read_time) : Number(sessions.session_seconds||0);
  const completionRows=db.prepare(`SELECT read_override,koreader_status,pages,
    (SELECT page FROM reading_sessions s WHERE s.book_id=books.id ORDER BY start_time DESC LIMIT 1) last_page,
    (SELECT total_pages FROM reading_sessions s WHERE s.book_id=books.id ORDER BY start_time DESC LIMIT 1) last_total_pages
    FROM books`).all();
  const readBooks=completionRows.reduce((count,book)=>count+completionView(book).is_read,0);
  const rangedReadBooks=db.prepare(`
    WITH book_dates AS (
      SELECT b.id,
        MIN(kovi_local_day(s.start_time)) AS started_on,
        CASE
          WHEN b.read_override=1 AND b.read_override_at IS NOT NULL THEN kovi_local_day(b.read_override_at)
          WHEN b.read_override=1 THEN MAX(kovi_local_day(s.start_time))
          WHEN b.read_override IS NOT NULL THEN NULL
          WHEN b.koreader_status='complete' AND b.koreader_status_modified IS NOT NULL THEN b.koreader_status_modified
          WHEN COALESCE((
            SELECT ROUND(100.0*c.page/COALESCE(NULLIF(c.total_pages,0),NULLIF(b.pages,0)))
            FROM reading_sessions c WHERE c.book_id=b.id ORDER BY c.start_time DESC LIMIT 1
          ),0)>=100 THEN (
            SELECT MIN(kovi_local_day(c.start_time)) FROM reading_sessions c
            WHERE c.book_id=b.id
              AND COALESCE(NULLIF(c.total_pages,0),NULLIF(b.pages,0)) IS NOT NULL
              AND ROUND(100.0*c.page/COALESCE(NULLIF(c.total_pages,0),NULLIF(b.pages,0)))>=100
          )
        END AS completed_on
      FROM books b LEFT JOIN reading_sessions s ON s.book_id=b.id
      GROUP BY b.id
    )
    SELECT COUNT(*) count FROM book_dates
    WHERE started_on BETWEEN ? AND ? AND completed_on BETWEEN ? AND ? AND completed_on>=started_on
  `).get(selected.from,selected.to,selected.from,selected.to).count;
  return {
    ...totals,
    read_books:readBooks,
    ...sessions,
    all_time_reading_seconds:allTimeReadingSeconds,
    reading_time_source:Number(totals.total_read_time||0)>0?'book_totals':'sessions',
    range:{...selected,seconds:rangeSeconds,reading_days:days.filter(row=>Number(row.seconds||0)>0).length,read_books:Number(rangedReadBooks||0)},
    days,
  };
}

export function getCalendar(db, range={}) {
  const selected=dashboardRange(range,new Date(),dbTimeZones.get(db));
  const start=parseDateKey(selected.from),end=parseDateKey(selected.to);
  const {startEpoch,endExclusive}=queryEpochBounds(start,end);
  const rows=db.prepare(`
    SELECT kovi_local_day(s.start_time) day,
      b.id book_id,b.title,b.authors,b.cover_path,b.updated_at,
      COALESCE(SUM(s.duration),0) seconds,COUNT(*) sessions
    FROM reading_sessions s
    JOIN books b ON b.id=s.book_id
    WHERE s.start_time >= ? AND s.start_time < ?
    GROUP BY day,b.id HAVING day >= ? AND day <= ?
    ORDER BY day ASC,seconds DESC,b.title COLLATE NOCASE ASC
  `).all(startEpoch,endExclusive,selected.from,selected.to);
  const dayMap=new Map();
  for(const row of rows){
    let day=dayMap.get(row.day);
    if(!day){day={day:row.day,seconds:0,sessions:0,books:[]};dayMap.set(row.day,day)}
    const seconds=Number(row.seconds||0),sessions=Number(row.sessions||0);day.seconds+=seconds;day.sessions+=sessions;
    day.books.push({id:row.book_id,title:row.title,authors:row.authors,cover_path:row.cover_path,updated_at:row.updated_at,seconds,sessions});
  }
  return {range:selected,days:[...dayMap.values()]};
}

export function createPairingCode(db, label = 'KOReader') {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 8; i++) code += alphabet[randomInt(alphabet.length)];
  const hash = tokenHash(code);
  const requestId = randomId(16);
  const expiresAt = Date.now() + 10 * 60_000;
  db.prepare(`INSERT INTO pairing_codes(code_hash,request_id,label,expires_at,used_at,paired_device_id) VALUES(?,?,?,?,NULL,NULL)`)
    .run(hash, requestId, String(label).slice(0,80), expiresAt);
  return { code, requestId, expiresAt };
}

export function getPairingStatus(db, requestId) {
  const row = db.prepare(`SELECT request_id,label,expires_at,used_at,paired_device_id FROM pairing_codes WHERE request_id=?`).get(String(requestId || '').slice(0,80));
  if (!row) return null;
  if (!row.used_at && row.expires_at < Date.now()) return { status:'expired', expiresAt:row.expires_at };
  if (!row.used_at) return { status:'pending', expiresAt:row.expires_at };
  const device = row.paired_device_id ? db.prepare(`SELECT id,name,model,plugin_version,last_seen_at FROM devices WHERE id=?`).get(row.paired_device_id) : null;
  return { status:'paired', expiresAt:row.expires_at, device:device || null };
}

export function consumePairingCode(db, code, { deviceId, model, version }) {
  const hash = tokenHash(String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, ''));
  const row = db.prepare(`SELECT * FROM pairing_codes WHERE code_hash=?`).get(hash);
  if (!row || row.used_at || row.expires_at < Date.now()) return null;
  const token = randomToken();
  const tHash = tokenHash(token);
  const id = String(deviceId || randomId(8)).slice(0,128);
  const ts = nowIso();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`UPDATE pairing_codes SET used_at=?,paired_device_id=? WHERE code_hash=?`).run(Date.now(), id, hash);
    db.prepare(`INSERT INTO devices(id,name,model,plugin_version,token_hash,created_at,last_seen_at,revoked_at)
      VALUES(?,?,?,?,?,?,?,NULL)
      ON CONFLICT(id) DO UPDATE SET model=excluded.model, plugin_version=excluded.plugin_version, token_hash=excluded.token_hash, last_seen_at=excluded.last_seen_at, revoked_at=NULL`
    ).run(id, row.label, model || null, version || null, tHash, ts, ts);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { token, deviceId: id, requestId: row.request_id };
}

export function authenticateDevice(db, authorization) {
  const m = /^Bearer\s+(.+)$/i.exec(authorization || '');
  if (!m) return null;
  const hash = tokenHash(m[1]);
  const row = db.prepare(`SELECT * FROM devices WHERE token_hash=? AND revoked_at IS NULL`).get(hash);
  if (!row || !safeEqualHex(hash, row.token_hash)) return null;
  db.prepare(`UPDATE devices SET last_seen_at=? WHERE id=?`).run(nowIso(), row.id);
  return row;
}

export function updateDevicePluginVersion(db, id, version) {
  const v=String(version||'').trim().slice(0,40);
  if(!id || !v) return false;
  return db.prepare(`UPDATE devices SET plugin_version=?, last_seen_at=? WHERE id=?`).run(v,nowIso(),id).changes>0;
}

export function listDevices(db) {
  return db.prepare(`SELECT id,name,model,plugin_version,created_at,last_seen_at,last_sync_at,sync_cursor,last_sync_mode,last_sync_books,last_sync_stats,last_sync_new_sessions,last_sync_annotation_sets,last_sync_annotations,revoked_at FROM devices ORDER BY COALESCE(last_seen_at,created_at) DESC`).all();
}

export function recordDeviceSync(db, deviceId, result, {mode='full',cursorBefore=0,cursorAfter=0}={}) {
  const ts=nowIso();
  const values=[ts,Math.max(0,Number(cursorAfter)||0),String(mode||'full').slice(0,24),Number(result.booksSeen||0),Number(result.sessionsSeen||0),Number(result.newSessions||0),Number(result.annotationBooks||0),Number(result.annotationsStored||0),deviceId];
  db.prepare(`UPDATE devices SET last_sync_at=?,sync_cursor=?,last_sync_mode=?,last_sync_books=?,last_sync_stats=?,last_sync_new_sessions=?,last_sync_annotation_sets=?,last_sync_annotations=?,last_seen_at=? WHERE id=?`)
    .run(...values.slice(0,8),ts,deviceId);
  db.prepare(`INSERT INTO sync_runs(id,device_id,mode,cursor_before,cursor_after,books_seen,sessions_seen,new_sessions,annotation_sets,annotations_stored,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
    .run(randomId(16),deviceId,String(mode||'full').slice(0,24),Math.max(0,Number(cursorBefore)||0),Math.max(0,Number(cursorAfter)||0),Number(result.booksSeen||0),Number(result.sessionsSeen||0),Number(result.newSessions||0),Number(result.annotationBooks||0),Number(result.annotationsStored||0),ts);
  return {syncCursor:Math.max(0,Number(cursorAfter)||0),syncAt:ts};
}

export function getStatus(db) {
  const library=db.prepare(`SELECT COUNT(*) books,COALESCE(SUM(total_read_time),0) reading_seconds,COALESCE(SUM(highlights),0) highlights FROM books`).get();
  const sessions=db.prepare(`SELECT COUNT(*) sessions FROM reading_sessions`).get();
  const annotations=db.prepare(`SELECT COUNT(*) annotations FROM annotations WHERE annotation_type IN ('highlight','note')`).get();
  const covers=db.prepare(`SELECT cover_status status,COUNT(*) count FROM books GROUP BY cover_status`).all();
  const sources=db.prepare(`SELECT COALESCE(cover_source,'none') source,COUNT(*) count FROM books GROUP BY COALESCE(cover_source,'none') ORDER BY count DESC`).all();
  const coverJobs=db.prepare(`SELECT state,COUNT(*) count FROM cover_jobs GROUP BY state`).all();
  const recentImports=db.prepare(`SELECT id,kind,filename,file_size,books_seen,new_books,sessions_seen,new_sessions,warnings_json,created_at FROM imports ORDER BY created_at DESC LIMIT 8`).all().map(r=>({...r,warnings:JSON.parse(r.warnings_json||'[]'),warnings_json:undefined}));
  const recentSyncs=db.prepare(`SELECT s.*,d.name device_name,d.model device_model FROM sync_runs s LEFT JOIN devices d ON d.id=s.device_id ORDER BY s.created_at DESC LIMIT 12`).all();
  return {library:{...library,...sessions,...annotations},covers:{statuses:covers,sources,jobs:coverJobs},devices:listDevices(db),recentImports,recentSyncs};
}

export function revokeDevice(db, id) {
  return db.prepare(`UPDATE devices SET revoked_at=? WHERE id=?`).run(nowIso(), id).changes > 0;
}
