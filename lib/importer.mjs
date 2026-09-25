import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { cleanText, asInt, nowIso, randomId, sha256, extractIsbn } from './security.mjs';

const REQUIRED_BOOK_COLUMNS = ['id','title','authors','notes','last_open','highlights','pages','series','language','md5','total_read_time','total_read_pages'];
const REQUIRED_STATS_COLUMNS = ['id_book','page','start_time','duration','total_pages'];

function columns(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name);
}
function hasAll(actual, needed) { const set = new Set(actual); return needed.every(x => set.has(x)); }

export function isKoReaderManual(bookOrTitle) {
  const title = cleanText(typeof bookOrTitle === 'object' ? bookOrTitle?.title : bookOrTitle, 500) || '';
  const folded = title.toLocaleLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,' ').trim();
  if (!folded.includes('koreader')) return false;
  if (folded === 'koreader') return true;
  return /\b(user guide|manual|manuale|guida(?: utente)?|guide(?: utilisateur)?|manuel|handbuch|guia(?: del usuario)?|quickstart guide)\b/.test(folded);
}

export function removeExcludedBooks(appDb) {
  const books = appDb.prepare(`SELECT id,title FROM books`).all();
  let removed = 0;
  const del = appDb.prepare(`DELETE FROM books WHERE id=?`);
  for (const book of books) if (isKoReaderManual(book)) removed += del.run(book.id).changes;
  return removed;
}

export function validateKoReaderDb(filePath) {
  const header = Buffer.alloc(16);
  const fd = fs.openSync(filePath, 'r');
  fs.readSync(fd, header, 0, 16, 0); fs.closeSync(fd);
  if (header.toString('ascii',0,16) !== 'SQLite format 3\u0000') throw new Error('This is not a valid SQLite 3 database.');
  const src = new DatabaseSync(filePath, { readOnly: true });
  try {
    const integrity = src.prepare('PRAGMA quick_check').get();
    if (!integrity || Object.values(integrity)[0] !== 'ok') throw new Error('SQLite integrity check failed.');
    const tables = new Set(src.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map(r => r.name));
    if (!tables.has('book') || !tables.has('page_stat_data')) throw new Error('Not a KOReader statistics database: expected book and page_stat_data tables.');
    const bookCols = columns(src, 'book');
    const statCols = columns(src, 'page_stat_data');
    if (!hasAll(bookCols, REQUIRED_BOOK_COLUMNS)) throw new Error(`Unsupported KOReader book schema. Missing: ${REQUIRED_BOOK_COLUMNS.filter(x=>!bookCols.includes(x)).join(', ')}`);
    if (!hasAll(statCols, REQUIRED_STATS_COLUMNS)) throw new Error(`Unsupported KOReader statistics schema. Missing: ${REQUIRED_STATS_COLUMNS.filter(x=>!statCols.includes(x)).join(', ')}`);
    return { bookCols, statCols };
  } finally { src.close(); }
}

export function importKoReaderDb(appDb, filePath, meta = {}) {
  validateKoReaderDb(filePath);
  const sourceHash = hashFile(filePath);
  const prior = appDb.prepare(`SELECT * FROM imports WHERE source_hash=?`).get(sourceHash);
  if (prior) return { duplicate: true, importId: prior.id, booksSeen: prior.books_seen, newBooks: 0, sessionsSeen: prior.sessions_seen, newSessions: 0, excludedBooks:0, warnings: JSON.parse(prior.warnings_json) };

  const src = new DatabaseSync(filePath, { readOnly: true });
  const warnings = [];
  let booksSeen = 0, newBooks = 0, sessionsSeen = 0, newSessions = 0, excludedBooks = 0;
  const bookIdToMd5 = new Map();
  const newlyAdded = [];
  const ts = nowIso();
  try {
    const bookCount = Number(src.prepare(`SELECT COUNT(*) n FROM book`).get().n);
    if (bookCount > 100000) throw new Error('Database contains an unreasonable number of books.');
    const statCount = Number(src.prepare(`SELECT COUNT(*) n FROM page_stat_data`).get().n);
    if (statCount > 5_000_000) throw new Error('Database contains an unreasonable number of reading-stat rows.');
    const books = src.prepare(`SELECT id,title,authors,notes,last_open,highlights,pages,series,language,md5,total_read_time,total_read_pages FROM book`).all();
    const statsStmt = src.prepare(`SELECT id_book,page,start_time,duration,total_pages FROM page_stat_data`);

    appDb.exec('BEGIN IMMEDIATE');
    try {
      const findBook = appDb.prepare(`SELECT id FROM books WHERE source_md5=?`);
      const insertBook = appDb.prepare(`INSERT INTO books(id,source_md5,title,authors,notes,last_open,highlights,pages,series,language,total_read_time,total_read_pages,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      const updateBook = appDb.prepare(`UPDATE books SET title=?,authors=?,notes=?,last_open=?,highlights=?,pages=?,series=?,language=?,total_read_time=?,total_read_pages=?,updated_at=? WHERE source_md5=?`);
      const sessionInsert = appDb.prepare(`INSERT OR IGNORE INTO reading_sessions(id,fingerprint,book_id,device_id,page,start_time,duration,total_pages,created_at) VALUES(?,?,?,?,?,?,?,?,?)`);

      for (const b of books) {
        booksSeen++;
        const md5 = cleanText(b.md5, 128);
        const title = cleanText(b.title, 500) || 'Untitled';
        if (isKoReaderManual(title)) { excludedBooks++; continue; }
        if (!md5) { warnings.push(`Skipped book #${b.id}: missing MD5.`); continue; }
        bookIdToMd5.set(Number(b.id), md5);
        const existing = findBook.get(md5);
        const vals = [title,cleanText(b.authors,500),asInt(b.notes,{max:1e7}),asInt(b.last_open,{max:4e9}),asInt(b.highlights,{max:1e7}),asInt(b.pages,{max:1e7}),cleanText(b.series,500),cleanText(b.language,64),asInt(b.total_read_time,{max:1e12}),asInt(b.total_read_pages,{max:1e9})];
        if (existing) updateBook.run(...vals, ts, md5);
        else {
          const id = randomId(16);
          insertBook.run(id,md5,...vals,ts,ts);
          newBooks++; newlyAdded.push(id);
        }
      }

      for (const s of statsStmt.iterate()) {
        sessionsSeen++;
        const md5 = bookIdToMd5.get(Number(s.id_book));
        if (!md5) continue;
        const book = findBook.get(md5);
        if (!book) continue;
        const page = asInt(s.page,{max:1e8});
        const start = asInt(s.start_time,{max:4e9});
        const duration = asInt(s.duration,{max:7*24*3600});
        const totalPages = asInt(s.total_pages,{max:1e8});
        if (!start || duration <= 0) continue;
        const fp = sha256(`${md5}|${page}|${start}|${duration}|${totalPages}|manual`);
        const r = sessionInsert.run(randomId(16),fp,book.id,'manual',page,start,duration,totalPages,ts);
        if (r.changes) newSessions++;
      }

      const importId = randomId(16);
      appDb.prepare(`INSERT INTO imports(id,source_hash,kind,filename,file_size,books_seen,new_books,sessions_seen,new_sessions,warnings_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
        .run(importId,sourceHash,'sqlite',cleanText(meta.filename,255),Number(meta.fileSize||0),booksSeen,newBooks,sessionsSeen,newSessions,JSON.stringify(warnings.slice(0,100)),ts);
      appDb.exec('COMMIT');
      return { duplicate:false, importId, sourceHash, booksSeen,newBooks,sessionsSeen,newSessions,excludedBooks,warnings:warnings.slice(0,100),newBookIds:newlyAdded };
    } catch (e) { appDb.exec('ROLLBACK'); throw e; }
  } finally { src.close(); }
}

function annotationType(a) {
  if (cleanText(a?.note, 20000)) return 'note';
  if (cleanText(a?.text, 20000) || a?.drawer || a?.highlighted) return 'highlight';
  return 'bookmark';
}

function cleanDateKey(value) {
  const key=cleanText(value,40);const match=/^(\d{4})-(\d{2})-(\d{2})$/.exec(key||'');
  if(!match) return null;
  const date=new Date(Date.UTC(Number(match[1]),Number(match[2])-1,Number(match[3])));
  return date.getUTCFullYear()===Number(match[1])&&date.getUTCMonth()===Number(match[2])-1&&date.getUTCDate()===Number(match[3])?key:null;
}

function importAnnotationSets(appDb, sets, device, findBook, ts) {
  if (!Array.isArray(sets)) return { annotationBooks:0, annotationsSeen:0, annotationsStored:0, metadataEnriched:0, coverRefreshIds:[] };
  if (sets.length > 10000) throw new Error('Plugin annotation payload contains too many books.');
  let annotationsSeen = 0, annotationsStored = 0, annotationBooks = 0, metadataEnriched = 0;
  const coverRefreshIds = [];
  const del = appDb.prepare(`DELETE FROM annotations WHERE book_id=? AND device_id=?`);
  const insert = appDb.prepare(`INSERT OR IGNORE INTO annotations(id,fingerprint,book_id,device_id,annotation_type,text,note,chapter,page,pageno,total_pages,annotation_datetime,color,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const updateMetadata = appDb.prepare(`UPDATE books SET identifiers=COALESCE(?,identifiers),isbn=COALESCE(?,isbn),cover_status=?,cover_checked_at=CASE WHEN ? THEN NULL ELSE cover_checked_at END,updated_at=? WHERE id=?`);
  const updateStatus = appDb.prepare(`UPDATE books SET koreader_status=?,koreader_status_modified=?,updated_at=? WHERE id=? AND (koreader_status_modified IS NULL OR (? IS NOT NULL AND koreader_status_modified<=?))`);

  for (const set of sets) {
    const md5 = cleanText(set?.book_md5, 128);
    if (!md5) continue;
    const book = findBook.get(md5);
    if (!book) continue;

    const readingStatus=cleanText(set?.reading_status,40);
    if (['reading','abandoned','complete'].includes(readingStatus)) {
      const statusModified=cleanDateKey(set?.reading_status_modified);
      updateStatus.run(readingStatus,statusModified,ts,book.id,statusModified,statusModified);
    }

    // KOReader stores document metadata, including dc:identifier/ISBN, in each
    // book's doc_props sidecar. Enrich the canonical book record when the plugin
    // sends it so translated titles can use deterministic ISBN cover lookup.
    const identifiers = cleanText(set?.identifiers ?? set?.metadata?.identifiers, 4000);
    const isbn = extractIsbn(set?.isbn ?? identifiers);
    if ((identifiers && identifiers !== book.identifiers) || (isbn && isbn !== book.isbn)) {
      const learnedIsbn = Boolean(isbn && !book.isbn);
      const shouldRetryCover = learnedIsbn && ['none','error'].includes(book.cover_status);
      updateMetadata.run(
        identifiers || null,
        isbn || null,
        shouldRetryCover ? 'pending' : book.cover_status,
        shouldRetryCover ? 1 : 0,
        ts,
        book.id,
      );
      metadataEnriched++;
      if (shouldRetryCover) coverRefreshIds.push(book.id);
    }

    const annotations = Array.isArray(set.annotations) ? set.annotations : [];
    if (annotations.length > 5000) throw new Error('A book contains an unreasonable number of annotations.');
    annotationBooks++;
    del.run(book.id, device.id);
    for (const a of annotations) {
      annotationsSeen++;
      const text = cleanText(a?.text ?? a?.notes, 20000);
      const note = cleanText(a?.note, 20000);
      const chapter = cleanText(a?.chapter, 2000);
      const page = cleanText(a?.page, 1000);
      const pageno = a?.pageno == null ? null : asInt(a.pageno,{max:1e8});
      const totalPages = a?.total_pages == null ? null : asInt(a.total_pages,{max:1e8});
      const datetime = cleanText(a?.datetime, 100);
      const color = cleanText(a?.color, 80);
      const type = annotationType(a);
      if (!text && !note) continue;
      const fp = sha256(`${datetime||''}|${pageno??''}|${page||''}|${chapter||''}|${text||''}|${note||''}|${type}`);
      annotationsStored += insert.run(randomId(16),fp,book.id,device.id,type,text,note,chapter,page,pageno,totalPages,datetime,color,ts).changes;
    }
  }
  return { annotationBooks, annotationsSeen, annotationsStored, metadataEnriched, coverRefreshIds:[...new Set(coverRefreshIds)] };
}

export function importPluginPayload(appDb, payload, device) {
  const books = Array.isArray(payload?.books) ? payload.books : [];
  const stats = Array.isArray(payload?.stats) ? payload.stats : [];
  const annotationSets = Array.isArray(payload?.annotation_sets) ? payload.annotation_sets : [];
  if (books.length > 10000 || stats.length > 500000) throw new Error('Plugin payload is too large.');
  const syncCursorBefore=Math.max(0,asInt(payload?.sync_cursor,{max:4e9}));
  const syncMode=syncCursorBefore>0?'incremental':'full';
  let syncCursorAfter=syncCursorBefore;
  const ts = nowIso();
  let newBooks=0,newSessions=0,excludedBooks=0;
  const newBookIds=[];
  let annotationResult={annotationBooks:0,annotationsSeen:0,annotationsStored:0,metadataEnriched:0,coverRefreshIds:[]};
  appDb.exec('BEGIN IMMEDIATE');
  try {
    const findBook=appDb.prepare(`SELECT id,isbn,identifiers,cover_status,cover_source FROM books WHERE source_md5=?`);
    const insert=appDb.prepare(`INSERT INTO books(id,source_md5,title,authors,notes,last_open,highlights,pages,series,language,identifiers,isbn,total_read_time,total_read_pages,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const update=appDb.prepare(`UPDATE books SET title=?,authors=?,notes=?,last_open=?,highlights=?,pages=?,series=?,language=?,identifiers=COALESCE(?,identifiers),isbn=COALESCE(?,isbn),total_read_time=?,total_read_pages=?,updated_at=? WHERE source_md5=?`);
    for(const b of books){
      const title=cleanText(b?.title,500)||'Untitled';
      if(isKoReaderManual(title)){excludedBooks++;continue;}
      const md5=cleanText(b?.md5,128); if(!md5) continue;
      const identifiers=cleanText(b?.identifiers,4000);
      const isbn=extractIsbn(b?.isbn ?? identifiers);
      const vals=[title,cleanText(b?.authors,500),asInt(b?.notes,{max:1e7}),asInt(b?.last_open,{max:4e9}),asInt(b?.highlights,{max:1e7}),asInt(b?.pages,{max:1e7}),cleanText(b?.series,500),cleanText(b?.language,64),identifiers,isbn,asInt(b?.total_read_time,{max:1e12}),asInt(b?.total_read_pages,{max:1e9})];
      const ex=findBook.get(md5);
      if(ex) {
        update.run(...vals,ts,md5);
        if(isbn && !ex.isbn && ['none','error'].includes(ex.cover_status)) {
          appDb.prepare(`UPDATE books SET cover_status='pending',cover_checked_at=NULL WHERE id=?`).run(ex.id);
          annotationResult.coverRefreshIds.push(ex.id);
        }
      } else {
        const id=randomId(16); insert.run(id,md5,...vals,ts,ts); newBooks++; newBookIds.push(id);
      }
    }
    const insS=appDb.prepare(`INSERT OR IGNORE INTO reading_sessions(id,fingerprint,book_id,device_id,page,start_time,duration,total_pages,created_at) VALUES(?,?,?,?,?,?,?,?,?)`);
    for(const s of stats){
      const md5=cleanText(s?.book_md5,128); if(!md5) continue;
      const book=findBook.get(md5); if(!book) continue;
      const page=asInt(s.page,{max:1e8}), start=asInt(s.start_time,{max:4e9}), duration=asInt(s.duration,{max:7*24*3600}), totalPages=asInt(s.total_pages,{max:1e8});
      if(start>syncCursorAfter) syncCursorAfter=start;
      if(!start||duration<=0) continue;
      const fp=sha256(`${md5}|${page}|${start}|${duration}|${totalPages}|${device.id}`);
      if(insS.run(randomId(16),fp,book.id,device.id,page,start,duration,totalPages,ts).changes) newSessions++;
    }
    const ann = importAnnotationSets(appDb,annotationSets,device,findBook,ts);
    annotationResult = {
      ...ann,
      coverRefreshIds:[...new Set([...(annotationResult.coverRefreshIds||[]),...(ann.coverRefreshIds||[])])],
    };
    appDb.exec('COMMIT');
  } catch(e){appDb.exec('ROLLBACK');throw e;}

  // Ask the current reader for embedded covers only for books that still need one.
  // Cap the list so a single sync remains responsive on slower e-ink devices.
  const coverRequests=[];
  const seen=new Set();
  const coverState=appDb.prepare(`SELECT source_md5,cover_status,cover_source FROM books WHERE source_md5=?`);
  for(const b of books){
    const md5=cleanText(b?.md5,128); if(!md5 || seen.has(md5)) continue;
    seen.add(md5);
    const row=coverState.get(md5);
    if(row && ['pending','none','error'].includes(row.cover_status) && row.cover_source!=='koreader-embedded') coverRequests.push(md5);
    if(coverRequests.length>=20) break;
  }

  return {
    booksSeen:books.length,newBooks,sessionsSeen:stats.length,newSessions,newBookIds,excludedBooks,
    ...annotationResult,
    coverRefreshIds:[...new Set(annotationResult.coverRefreshIds||[])],
    coverRequests,
    syncMode,syncCursorBefore,syncCursorAfter,
  };
}

function hashFile(filePath) {
  const h = createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  const b = Buffer.allocUnsafe(1024*1024);
  try { let n; while ((n=fs.readSync(fd,b,0,b.length,null))>0) h.update(b.subarray(0,n)); }
  finally { fs.closeSync(fd); }
  return h.digest('hex');
}
