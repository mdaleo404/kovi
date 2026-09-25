import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openAppDb, resolveTimeZone, createPairingCode, getPairingStatus, consumePairingCode, authenticateDevice, getBook, setBookReadOverride, getDashboard, getCalendar, dashboardRange, recordDeviceSync, getStatus } from '../lib/db.mjs';
import { importKoReaderDb, importPluginPayload, validateKoReaderDb, isKoReaderManual, removeExcludedBooks } from '../lib/importer.mjs';
import { scoreCandidate, resolveCover, saveEmbeddedCover, saveManualCover, processCoverBook, getBookCoverState, selectCoverHistory, selectCoverCandidate } from '../lib/covers.mjs';
import { extractIsbn } from '../lib/security.mjs';
import { calibreArgsForBook, fetchCoverWithCalibre } from '../lib/calibre.mjs';
import { createBackupArchive } from '../lib/exports.mjs';
import { gunzipSync } from 'node:zlib';

function fixture(dir,{includeManual=false}={}){const p=path.join(dir,'statistics.sqlite3');const d=new DatabaseSync(p);d.exec(`CREATE TABLE book(id INTEGER PRIMARY KEY,title TEXT,authors TEXT,notes INTEGER,last_open INTEGER,highlights INTEGER,pages INTEGER,series TEXT,language TEXT,md5 TEXT,total_read_time INTEGER,total_read_pages INTEGER);CREATE TABLE page_stat_data(id_book INTEGER,page INTEGER,start_time INTEGER,duration INTEGER,total_pages INTEGER);`);d.prepare(`INSERT INTO book VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(1,'The Hobbit','J.R.R. Tolkien',1,1700000000,2,310,null,'eng','abc123',5000,80);d.prepare(`INSERT INTO page_stat_data VALUES(?,?,?,?,?)`).run(1,80,1700000000,600,310);if(includeManual){d.prepare(`INSERT INTO book VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(2,'KOReader User Guide','KOReader Team',0,1700000001,0,100,null,'eng','manual123',20,1);d.prepare(`INSERT INTO page_stat_data VALUES(?,?,?,?,?)`).run(2,1,1700000001,20,100)}d.close();return p}

test('manual importer validates, imports, and is idempotent',()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kovi-'));const app=openAppDb(path.join(dir,'data'));const p=fixture(dir);assert.doesNotThrow(()=>validateKoReaderDb(p));const one=importKoReaderDb(app,p,{filename:'statistics.sqlite3',fileSize:123});assert.equal(one.newBooks,1);assert.equal(one.newSessions,1);const two=importKoReaderDb(app,p,{filename:'statistics.sqlite3',fileSize:123});assert.equal(two.duplicate,true);assert.equal(app.prepare('SELECT COUNT(*) n FROM books').get().n,1);assert.equal(app.prepare('SELECT COUNT(*) n FROM reading_sessions').get().n,1);app.close();fs.rmSync(dir,{recursive:true,force:true})});



test('dashboard defaults to a rolling 365-day range and filters daily sessions exactly',()=>{
  assert.deepEqual(dashboardRange({},new Date(2026,7,31,12,0,0)),{from:'2025-09-01',to:'2026-08-31'});
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kovi-dashboard-'));const app=openAppDb(dir);
  app.prepare(`INSERT INTO books(id,source_md5,title,total_read_time,created_at,updated_at) VALUES('b','m','Book',7200,'x','x')`).run();
  const ins=app.prepare(`INSERT INTO reading_sessions(id,fingerprint,book_id,device_id,page,start_time,duration,total_pages,created_at) VALUES(?,?,?,?,?,?,?,?,?)`);
  const epoch=(y,m,d)=>Math.floor(new Date(y,m-1,d,12,0,0).getTime()/1000);
  ins.run('s1','f1','b','d',1,epoch(2026,8,1),1800,100,'x');
  ins.run('s2','f2','b','d',2,epoch(2026,8,15),3600,100,'x');
  ins.run('s3','f3','b','d',3,epoch(2026,7,31),600,100,'x');
  const dash=getDashboard(app,{from:'2026-08-01',to:'2026-08-31'});
  assert.equal(dash.range.seconds,5400);assert.equal(dash.range.reading_days,2);assert.equal(dash.days.length,2);
  assert.equal(dash.all_time_reading_seconds,7200);assert.equal(dash.session_seconds,6000);
  app.close();fs.rmSync(dir,{recursive:true,force:true});
});

test('range books read requires both first tracked reading and completion inside the range',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kovi-range-read-'));const app=openAppDb(dir,{timeZone:'UTC'});
  const addBook=app.prepare(`INSERT INTO books(id,source_md5,title,koreader_status,koreader_status_modified,read_override,read_override_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`);
  const addSession=app.prepare(`INSERT INTO reading_sessions(id,fingerprint,book_id,device_id,page,start_time,duration,total_pages,created_at) VALUES(?,?,?,?,?,?,?,?,?)`);
  const epoch=(day,hour=12)=>Date.parse(`${day}T${String(hour).padStart(2,'0')}:00:00Z`)/1000;
  addBook.run('ko','ko-md5','KOReader complete','complete','2026-08-10',null,null,'x','x');addSession.run('ks','kf','ko','d',53,epoch('2026-08-02'),60,100,'x');
  addBook.run('manual','manual-md5','Manual complete',null,null,null,null,'x','x');addSession.run('ms','mf','manual','d',40,epoch('2026-08-03'),60,100,'x');setBookReadOverride(app,'manual',true,epoch('2026-08-12'));
  addBook.run('legacy-manual','legacy-manual-md5','Legacy manual complete',null,null,1,null,'x','x');addSession.run('lms1','lmf1','legacy-manual','d',20,epoch('2026-08-05'),60,100,'x');addSession.run('lms2','lmf2','legacy-manual','d',53,epoch('2026-08-18'),60,100,'x');
  addBook.run('progress','progress-md5','Progress complete',null,null,null,null,'x','x');addSession.run('ps1','pf1','progress','d',1,epoch('2026-08-04'),60,100,'x');addSession.run('ps2','pf2','progress','d',100,epoch('2026-08-15'),60,100,'x');
  addBook.run('boundary','boundary-md5','Boundary complete','complete','2026-08-31',null,null,'x','x');addSession.run('bs','bf','boundary','d',20,epoch('2026-08-01'),60,100,'x');
  addBook.run('old','old-md5','Started before','complete','2026-08-05',null,null,'x','x');addSession.run('os','of','old','d',20,epoch('2026-07-31'),60,100,'x');
  addBook.run('late','late-md5','Completed after','complete','2026-09-01',null,null,'x','x');addSession.run('ls','lf','late','d',20,epoch('2026-08-05'),60,100,'x');
  addBook.run('reverse','reverse-md5','Completion before start','complete','2026-08-10',null,null,'x','x');addSession.run('rs','rf','reverse','d',20,epoch('2026-08-20'),60,100,'x');
  addBook.run('resumed','resumed-md5','Moved after final page',null,null,null,null,'x','x');addSession.run('rr1','rrf1','resumed','d',100,epoch('2026-08-07'),60,100,'x');addSession.run('rr2','rrf2','resumed','d',20,epoch('2026-08-08'),60,100,'x');
  addBook.run('unknown','unknown-md5','Unknown completion','complete',null,null,null,'x','x');addSession.run('us','uf','unknown','d',53,epoch('2026-08-06'),60,100,'x');
  assert.equal(getDashboard(app,{from:'2026-08-01',to:'2026-08-31'}).range.read_books,5);
  app.close();fs.rmSync(dir,{recursive:true,force:true});
});

test('calendar groups each day by book and totals its reading sessions',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kovi-calendar-'));const app=openAppDb(dir);
  app.prepare(`INSERT INTO books(id,source_md5,title,authors,cover_path,created_at,updated_at) VALUES('a','ma','Book A','Author A','/covers/a.jpg','x','x')`).run();
  app.prepare(`INSERT INTO books(id,source_md5,title,authors,created_at,updated_at) VALUES('b','mb','Book B','Author B','x','x')`).run();
  const ins=app.prepare(`INSERT INTO reading_sessions(id,fingerprint,book_id,device_id,page,start_time,duration,total_pages,created_at) VALUES(?,?,?,?,?,?,?,?,?)`);
  const epoch=(y,m,d,h=12)=>Math.floor(new Date(y,m-1,d,h,0,0).getTime()/1000);
  ins.run('c1','cf1','a','d',1,epoch(2026,8,10,9),600,100,'x');
  ins.run('c2','cf2','a','d',2,epoch(2026,8,10,10),900,100,'x');
  ins.run('c3','cf3','b','d',3,epoch(2026,8,10,11),1200,200,'x');
  ins.run('c4','cf4','b','d',4,epoch(2026,8,11,11),300,200,'x');
  const cal=getCalendar(app,{from:'2026-08-01',to:'2026-08-31'});
  assert.equal(cal.days.length,2);assert.equal(cal.days[0].day,'2026-08-10');assert.equal(cal.days[0].seconds,2700);assert.equal(cal.days[0].sessions,3);
  assert.equal(cal.days[0].books.length,2);assert.equal(cal.days[0].books[0].title,'Book A');assert.equal(cal.days[0].books[0].seconds,1500);assert.equal(cal.days[0].books[0].cover_path,'/covers/a.jpg');
  app.close();fs.rmSync(dir,{recursive:true,force:true});
});

test('dashboard and calendar group sessions in the configured IANA time zone across DST',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kovi-timezone-'));const app=openAppDb(dir,{timeZone:'America/New_York'});
  app.prepare(`INSERT INTO books(id,source_md5,title,created_at,updated_at) VALUES('tz','tz-md5','Night Reader','x','x')`).run();
  const ins=app.prepare(`INSERT INTO reading_sessions(id,fingerprint,book_id,device_id,page,start_time,duration,total_pages,created_at) VALUES(?,?,?,?,?,?,?,?,?)`);
  ins.run('tz1','tzf1','tz','d',1,Date.parse('2026-03-08T04:30:00Z')/1000,600,100,'x');
  ins.run('tz2','tzf2','tz','d',2,Date.parse('2026-03-08T07:30:00Z')/1000,900,100,'x');
  const dash=getDashboard(app,{from:'2026-03-07',to:'2026-03-08'});
  assert.deepEqual(dash.days.map(row=>[row.day,row.seconds]),[['2026-03-07',600],['2026-03-08',900]]);
  const calendar=getCalendar(app,{from:'2026-03-07',to:'2026-03-08'});
  assert.deepEqual(calendar.days.map(row=>[row.day,row.seconds]),[['2026-03-07',600],['2026-03-08',900]]);
  assert.equal(dashboardRange({},new Date('2026-01-01T01:00:00Z'),'America/Los_Angeles').to,'2025-12-31');
  setBookReadOverride(app,'tz',true,Date.parse('2026-03-08T04:45:00Z')/1000);
  assert.equal(getDashboard(app,{from:'2026-03-07',to:'2026-03-07'}).range.read_books,1);
  assert.throws(()=>resolveTimeZone('Not/A_Time_Zone'),/Invalid TZ value/);
  app.close();fs.rmSync(dir,{recursive:true,force:true});
});

test('the same page-stat row is not double-counted across manual upload and plugin sync',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kovi-session-dedupe-'));const app=openAppDb(path.join(dir,'data'));const p=fixture(dir);
  const manual=importKoReaderDb(app,p);assert.equal(manual.newSessions,1);
  const plugin=importPluginPayload(app,{books:[{md5:'abc123',title:'The Hobbit',authors:'J.R.R. Tolkien',total_read_time:5000,total_read_pages:80}],stats:[{book_md5:'abc123',page:80,start_time:1700000000,duration:600,total_pages:310}],annotation_sets:[]},{id:'reader1'});
  assert.equal(plugin.newSessions,0);assert.equal(app.prepare(`SELECT COUNT(*) n FROM reading_sessions`).get().n,1);
  app.close();fs.rmSync(dir,{recursive:true,force:true});
});

test('plugin import advances an incremental high-water mark while preserving overlap idempotency',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kovi-sync-cursor-'));const app=openAppDb(dir);
  const payload={sync_cursor:1699999900,books:[{md5:'cursor-book',title:'Cursor Book'}],stats:[
    {book_md5:'cursor-book',page:1,start_time:1700000000,duration:60,total_pages:100},
    {book_md5:'cursor-book',page:2,start_time:1700000300,duration:90,total_pages:100},
  ],annotation_sets:[]};
  const first=importPluginPayload(app,payload,{id:'reader-cursor'});
  assert.equal(first.syncMode,'incremental');assert.equal(first.syncCursorBefore,1699999900);assert.equal(first.syncCursorAfter,1700000300);assert.equal(first.newSessions,2);
  const repeated=importPluginPayload(app,{...payload,sync_cursor:first.syncCursorAfter},{id:'reader-cursor'});
  assert.equal(repeated.syncMode,'incremental');assert.equal(repeated.newSessions,0);assert.equal(repeated.syncCursorAfter,1700000300);
  app.close();fs.rmSync(dir,{recursive:true,force:true});
});

test('device sync diagnostics record cursors and appear in status',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kovi-sync-status-'));const app=openAppDb(dir);
  const {code}=createPairingCode(app,'Libra');consumePairingCode(app,code,{deviceId:'reader-status',model:'Kobo Libra',version:'2026.09.25'});
  recordDeviceSync(app,'reader-status',{booksSeen:12,sessionsSeen:4,newSessions:2,annotationBooks:3,annotationsStored:5},{mode:'incremental',cursorBefore:100,cursorAfter:200});
  const status=getStatus(app);const device=status.devices.find(d=>d.id==='reader-status');
  assert.equal(device.sync_cursor,200);assert.equal(device.last_sync_mode,'incremental');assert.equal(device.last_sync_new_sessions,2);
  assert.equal(status.recentSyncs[0].cursor_before,100);assert.equal(status.recentSyncs[0].cursor_after,200);assert.equal(status.recentSyncs[0].annotations_stored,5);
  app.close();fs.rmSync(dir,{recursive:true,force:true});
});

test('invalid sqlite schema is rejected',()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kovi-'));const p=path.join(dir,'bad.sqlite');const d=new DatabaseSync(p);d.exec('CREATE TABLE nope(x TEXT)');d.close();assert.throws(()=>validateKoReaderDb(p),/Not a KOReader/);fs.rmSync(dir,{recursive:true,force:true})});

test('pairing request exposes status and mints a revocable bearer identity',()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kovi-'));const app=openAppDb(dir);const {code,requestId}=createPairingCode(app,'Kobo');assert.equal(getPairingStatus(app,requestId).status,'pending');const paired=consumePairingCode(app,code,{deviceId:'dev1',model:'Kobo Libra',version:'2026.09.25'});assert.ok(paired.token.startsWith('kv_'));assert.equal(consumePairingCode(app,code,{deviceId:'dev2'}),null);assert.equal(getPairingStatus(app,requestId).status,'paired');const dev=authenticateDevice(app,`Bearer ${paired.token}`);assert.equal(dev.id,'dev1');app.close();fs.rmSync(dir,{recursive:true,force:true})});

test('plugin import deduplicates sessions and replaces synced highlight text per device',()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kovi-'));const app=openAppDb(dir);const payload={books:[{md5:'bookmd5',title:'Dune',authors:'Frank Herbert',pages:500,highlights:1}],stats:[{book_md5:'bookmd5',page:5,start_time:1700000000,duration:30,total_pages:500}],annotation_sets:[{book_md5:'bookmd5',annotations:[{datetime:'2026-08-30 08:00:00',text:'Fear is the mind-killer.',chapter:'Litany',pageno:20,total_pages:500}]}]};const device={id:'reader1'};const first=importPluginPayload(app,payload,device);assert.equal(first.newSessions,1);assert.equal(first.annotationsStored,1);assert.equal(getBook(app,app.prepare(`SELECT id FROM books WHERE source_md5='bookmd5'`).get().id).annotations[0].text,'Fear is the mind-killer.');const changed=structuredClone(payload);changed.annotation_sets[0].annotations=[{datetime:'2026-08-30 08:05:00',text:'A beginning is the time for taking the most delicate care.'}];const second=importPluginPayload(app,changed,device);assert.equal(second.newSessions,0);const anns=getBook(app,app.prepare(`SELECT id FROM books WHERE source_md5='bookmd5'`).get().id).annotations;assert.equal(anns.length,1);assert.match(anns[0].text,/beginning/);app.close();fs.rmSync(dir,{recursive:true,force:true})});

test('KOReader completion sync preserves actual progress and manual overrides win',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kovi-read-status-'));const app=openAppDb(dir);const device={id:'reader-status'};
  const payload={books:[{md5:'finished-md5',title:'Fahrenheit 451',pages:100}],stats:[{book_md5:'finished-md5',page:53,start_time:1700000000,duration:60,total_pages:100}],annotation_sets:[{book_md5:'finished-md5',reading_status:'complete',reading_status_modified:'2023-11-14',annotations:[]}]};
  importPluginPayload(app,payload,device);const id=app.prepare(`SELECT id FROM books WHERE source_md5='finished-md5'`).get().id;
  let book=getBook(app,id);assert.equal(book.last_page,53);assert.equal(book.koreader_status,'complete');assert.equal(book.koreader_status_modified,'2023-11-14');assert.equal(book.is_read,1);assert.equal(book.read_source,'koreader');
  payload.annotation_sets[0].reading_status='reading';payload.annotation_sets[0].reading_status_modified='2023-11-13';importPluginPayload(app,payload,device);assert.equal(getBook(app,id).koreader_status,'complete');
  payload.annotation_sets[0].reading_status='complete';payload.annotation_sets[0].reading_status_modified='2023-11-14';
  book=setBookReadOverride(app,id,false);assert.equal(book.is_read,0);assert.equal(book.read_source,'manual');assert.equal(book.read_override_at,null);
  importPluginPayload(app,payload,device);assert.equal(getBook(app,id).is_read,0);
  book=setBookReadOverride(app,id,true,1700001000);assert.equal(book.read_override_at,1700001000);
  book=setBookReadOverride(app,id,null);assert.equal(book.is_read,1);assert.equal(book.read_source,'koreader');assert.equal(book.read_override_at,null);assert.equal(getDashboard(app).read_books,1);
  payload.annotation_sets[0].reading_status='reading';payload.annotation_sets[0].reading_status_modified='2023-11-15';importPluginPayload(app,payload,device);assert.equal(getBook(app,id).is_read,0);
  app.close();fs.rmSync(dir,{recursive:true,force:true});
});

test('KOReader manual is excluded from imports and existing libraries',()=>{assert.equal(isKoReaderManual('KOReader User Guide'),true);assert.equal(isKoReaderManual('Manuale utente KOReader'),true);assert.equal(isKoReaderManual('koreader'),true);const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kovi-'));const app=openAppDb(path.join(dir,'data'));const p=fixture(dir,{includeManual:true});const r=importKoReaderDb(app,p);assert.equal(r.excludedBooks,1);assert.equal(app.prepare(`SELECT COUNT(*) n FROM books`).get().n,1);app.prepare(`INSERT INTO books(id,source_md5,title,created_at,updated_at) VALUES('m','m','KOReader Manual','x','x')`).run();assert.equal(removeExcludedBooks(app),1);app.close();fs.rmSync(dir,{recursive:true,force:true})});

test('cover matching prefers exact title and author',()=>{const score=scoreCandidate({title:'The Left Hand of Darkness',authors:'Ursula K. Le Guin',language:'eng'},{title:'The Left Hand of Darkness',author_name:['Ursula K. Le Guin'],cover_i:123,language:['eng']});assert.ok(score>.9);const wrong=scoreCandidate({title:'The Hobbit',authors:'J.R.R. Tolkien'},{title:'Hobbit Cookbook',author_name:['Someone Else'],cover_i:22});assert.ok(wrong<.72)});

test('cover resolver checks native catalogues in parallel and caches the strongest Open Library image', async()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kovi-cover-'));let calls=0;const fakeFetch=async(url)=>{calls++;if(String(url).startsWith('https://openlibrary.org/search.json')) return new Response(JSON.stringify({docs:[{title:'Dune',author_name:['Frank Herbert'],cover_i:42,language:['eng']}]}),{status:200,headers:{'Content-Type':'application/json'}});if(String(url).startsWith('https://www.googleapis.com/books/v1/volumes')) return new Response(JSON.stringify({totalItems:0,items:[]}),{status:200,headers:{'Content-Type':'application/json'}});const jpg=Buffer.from([0xff,0xd8,0xff,0xe0,0x00,0x10,0x4a,0x46,0x49,0x46,0x00,0xff,0xd9]);return new Response(jpg,{status:200,headers:{'Content-Type':'image/jpeg','Content-Length':String(jpg.length)}})};const r=await resolveCover({id:'book1',title:'Dune',authors:'Frank Herbert',language:'eng'},{dataDir:dir,fetchImpl:fakeFetch});assert.equal(r.status,'matched');assert.equal(r.source,'openlibrary');assert.equal(calls,3);assert.ok(fs.existsSync(path.join(dir,r.path.replace(/^\//,''))));fs.rmSync(dir,{recursive:true,force:true})});

test('Italian edition titles and language preference can provide the cover', async()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kovi-cover-it-'));let searchUrl='';const jpg=Buffer.from([0xff,0xd8,0xff,0xe0,0x00,0x10,0x4a,0x46,0x49,0x46,0x00,0xff,0xd9]);const fakeFetch=async(url)=>{if(String(url).startsWith('https://openlibrary.org/search.json')){searchUrl=String(url);return new Response(JSON.stringify({docs:[{title:'The Name of the Rose',author_name:['Umberto Eco'],editions:{docs:[{key:'/books/OL123M',title:'Il nome della rosa',cover_i:99,language:['ita']}]}}]}),{status:200})}return new Response(jpg,{status:200,headers:{'Content-Length':String(jpg.length)}})};const r=await resolveCover({id:'eco',title:'Il nome della rosa',authors:'Umberto Eco',language:'ita'},{dataDir:dir,fetchImpl:fakeFetch});assert.equal(r.status,'matched');assert.equal(r.matchedTitle,'Il nome della rosa');assert.match(searchUrl,/lang=it/);assert.match(searchUrl,/[?&]q=/);assert.doesNotMatch(searchUrl,/[?&]title=/);fs.rmSync(dir,{recursive:true,force:true})});


test('Italian locale tags such as it-IT are normalized for cover lookup', async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kovi-cover-itit-'));let searchUrl='';
  const jpg=Buffer.from([0xff,0xd8,0xff,0xe0,0x00,0x10,0x4a,0x46,0x49,0x46,0x00,0xff,0xd9]);
  const fakeFetch=async(url)=>{if(String(url).startsWith('https://openlibrary.org/search.json')){searchUrl=String(url);return new Response(JSON.stringify({docs:[{title:'Piranesi',author_name:['Susanna Clarke'],cover_i:4,language:['ita']}]}),{status:200})}return new Response(jpg,{status:200,headers:{'Content-Length':String(jpg.length)}})};
  const r=await resolveCover({id:'piranesi',title:'Piranesi',authors:'Susanna Clarke',language:'it-IT'},{dataDir:dir,fetchImpl:fakeFetch});
  assert.equal(r.status,'matched');assert.match(searchUrl,/lang=it/);fs.rmSync(dir,{recursive:true,force:true});
});

test('cover lookup falls back from author-constrained edition search to title-only edition search', async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kovi-cover-fallback-'));const urls=[];
  const jpg=Buffer.from([0xff,0xd8,0xff,0xe0,0x00,0x10,0x4a,0x46,0x49,0x46,0x00,0xff,0xd9]);
  const fakeFetch=async(url)=>{urls.push(String(url));if(String(url).startsWith('https://openlibrary.org/search.json')){const u=new URL(url);const q=u.searchParams.get('q')||'';if(q.includes('author:'))return new Response(JSON.stringify({numFound:0,docs:[]}),{status:200});return new Response(JSON.stringify({numFound:1,docs:[{title:'Days at the Morisaki Bookshop',author_name:['Satoshi Yagisawa'],editions:{docs:[{key:'/books/OL40163582M',title:'I miei giorni alla libreria Morisaki',cover_i:401,language:['ita']}]}}]}),{status:200})}return new Response(jpg,{status:200,headers:{'Content-Length':String(jpg.length)}})};
  const r=await resolveCover({id:'morisaki',title:'I miei giorni alla libreria Morisaki',authors:'Satoshi Yagisawa',language:'it'},{dataDir:dir,fetchImpl:fakeFetch});
  assert.equal(r.status,'matched');assert.equal(r.matchedTitle,'I miei giorni alla libreria Morisaki');assert.ok(r.trace.some(x=>x.strategy==='edition-title'&&x.candidates>0));fs.rmSync(dir,{recursive:true,force:true});
});

test('Google Books joins the native fallback when Open Library has no candidate', async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kovi-cover-google-'));const urls=[];
  const jpg=Buffer.from([0xff,0xd8,0xff,0xe0,0x00,0x10,0x4a,0x46,0x49,0x46,0x00,0xff,0xd9]);
  const fakeFetch=async(url)=>{urls.push(String(url));if(String(url).startsWith('https://openlibrary.org/search.json'))return new Response(JSON.stringify({numFound:0,docs:[]}),{status:200});if(String(url).startsWith('https://www.googleapis.com/books/v1/volumes'))return new Response(JSON.stringify({totalItems:1,items:[{id:'g1',volumeInfo:{title:'Il ladro linguanera',authors:['Christopher Buehlman'],language:'it',industryIdentifiers:[{type:'ISBN_13',identifier:'9788804717973'}]}}]}),{status:200});return new Response(jpg,{status:200,headers:{'Content-Length':String(jpg.length)}})};
  const r=await resolveCover({id:'blacktongue',title:'Il ladro linguanera',authors:'Christopher Buehlman',language:'it-IT'},{dataDir:dir,fetchImpl:fakeFetch,googleBooksApiKey:'test-key'});
  assert.equal(r.status,'matched');assert.equal(r.source,'openlibrary-via-googlebooks');assert.ok(urls.some(u=>u.includes('googleapis.com')&&u.includes('key=test-key')&&u.includes('langRestrict=it')));fs.rmSync(dir,{recursive:true,force:true});
});

test('Google Books native search works without requiring an API key', async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kovi-cover-google-anon-'));const urls=[];
  const jpg=Buffer.from([0xff,0xd8,0xff,0xe0,0x00,0x10,0x4a,0x46,0x49,0x46,0x00,0xff,0xd9]);
  const fakeFetch=async(url)=>{urls.push(String(url));if(String(url).startsWith('https://openlibrary.org/search.json'))return new Response(JSON.stringify({numFound:0,docs:[]}),{status:200});if(String(url).startsWith('https://www.googleapis.com/books/v1/volumes'))return new Response(JSON.stringify({totalItems:1,items:[{id:'g2',volumeInfo:{title:'Piranesi',authors:['Susanna Clarke'],language:'en',imageLinks:{thumbnail:'https://books.google.com/cover.jpg'}}}]}),{status:200});return new Response(jpg,{status:200,headers:{'Content-Length':String(jpg.length)}})};
  const r=await resolveCover({id:'piranesi-anon',title:'Piranesi',authors:'Susanna Clarke',language:'en'},{dataDir:dir,fetchImpl:fakeFetch});
  assert.equal(r.status,'matched');assert.equal(r.source,'googlebooks');const googleUrl=urls.find(u=>u.includes('googleapis.com'));assert.ok(googleUrl);assert.doesNotMatch(googleUrl,/[?&]key=/);fs.rmSync(dir,{recursive:true,force:true});
});

test('KOReader sidecar identifiers enrich an existing book with a validated ISBN and requeue its cover',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kovi-isbn-'));
  const app=openAppDb(dir);
  const device={id:'reader-isbn'};
  importPluginPayload(app,{books:[{md5:'translated-md5',title:'Il ladro linguanera',authors:'Christopher Buehlman',language:'it-IT'}],stats:[],annotation_sets:[]},device);
  app.prepare(`UPDATE books SET cover_status='none' WHERE source_md5='translated-md5'`).run();
  const r=importPluginPayload(app,{books:[{md5:'translated-md5',title:'Il ladro linguanera',authors:'Christopher Buehlman',language:'it-IT'}],stats:[],annotation_sets:[{book_md5:'translated-md5',identifiers:'uuid:abc\\nisbn:9791259676450',annotations:[]}]},device);
  const book=app.prepare(`SELECT isbn,cover_status FROM books WHERE source_md5='translated-md5'`).get();
  assert.equal(book.isbn,'9791259676450');
  assert.equal(book.cover_status,'pending');
  assert.deepEqual(r.coverRequests,['translated-md5']);
  app.close();fs.rmSync(dir,{recursive:true,force:true});
});

test('Open Library cover lookup continues after a bad placeholder image and uses the next candidate', async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kovi-cover-bad-image-'));
  const jpg=Buffer.from([0xff,0xd8,0xff,0xe0,0x00,0x10,0x4a,0x46,0x49,0x46,0x00,0xff,0xd9]);
  const fakeFetch=async(url)=>{
    const u=String(url);
    if(u.startsWith('https://openlibrary.org/search.json')) return new Response(JSON.stringify({numFound:2,docs:[
      {title:'Oltre le tenebre',author_name:['Brent Weeks'],cover_i:1,language:['ita']},
      {title:'Oltre le tenebre',author_name:['Brent Weeks'],cover_i:2,language:['ita']},
    ]}),{status:200});
    if(u.includes('/id/1-')) return new Response(Buffer.from('<html>not an image</html>'),{status:200,headers:{'Content-Type':'text/html'}});
    return new Response(jpg,{status:200,headers:{'Content-Type':'image/jpeg','Content-Length':String(jpg.length)}});
  };
  const r=await resolveCover({id:'weeks',title:'Oltre le tenebre',authors:'Brent Weeks',language:'it'},{dataDir:dir,fetchImpl:fakeFetch});
  assert.equal(r.status,'matched');
  assert.equal(r.source,'openlibrary');
  assert.ok(fs.existsSync(path.join(dir,r.path.replace(/^\//,''))));
  fs.rmSync(dir,{recursive:true,force:true});
});

test('series-prefixed translated titles try the volume title as a search variant', async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kovi-cover-series-prefix-'));
  const queries=[];
  const jpg=Buffer.from([0xff,0xd8,0xff,0xe0,0x00,0x10,0x4a,0x46,0x49,0x46,0x00,0xff,0xd9]);
  const fakeFetch=async(url)=>{
    const u=new URL(String(url));
    if(u.hostname==='openlibrary.org'){
      const q=u.searchParams.get('q')||''; queries.push(q);
      if(q.includes('"I grandi giochi"')) return new Response(JSON.stringify({numFound:1,docs:[{title:'I grandi giochi',author_name:['Jay Kristoff'],cover_i:77,language:['ita']}]}),{status:200});
      return new Response(JSON.stringify({numFound:0,docs:[]}),{status:200});
    }
    return new Response(jpg,{status:200,headers:{'Content-Type':'image/jpeg','Content-Length':String(jpg.length)}});
  };
  const r=await resolveCover({id:'nevernight2',title:'Nevernight. I grandi giochi',authors:'Jay Kristoff',language:'it'},{dataDir:dir,fetchImpl:fakeFetch});
  assert.equal(r.status,'matched');
  assert.ok(queries.some(q=>q.includes('"I grandi giochi"')));
  fs.rmSync(dir,{recursive:true,force:true});
});


test('ISBN extraction validates common KOReader identifier forms',()=>{
  assert.equal(extractIsbn('uuid:abc\nisbn:9791259676450'),'9791259676450');
  assert.equal(extractIsbn('ISBN 978-88-04-71795-9'),'9788804717959');
  assert.equal(extractIsbn('isbn:1234567890123'),null);
});

test('authenticated embedded cover storage prefers the exact KOReader edition',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kovi-embedded-cover-'));
  const app=openAppDb(dir);
  importPluginPayload(app,{books:[{md5:'exact-cover-md5',title:'Il Re Giallo',authors:'Robert W. Chambers',language:'it'}],stats:[],annotation_sets:[]},{id:'reader-cover'});
  const jpg=Buffer.alloc(128);jpg[0]=0xff;jpg[1]=0xd8;jpg[2]=0xff;jpg[3]=0xe0;jpg[126]=0xff;jpg[127]=0xd9;
  const saved=saveEmbeddedCover(app,dir,'exact-cover-md5',jpg);
  assert.equal(saved.ignored,false);
  const book=app.prepare(`SELECT cover_status,cover_source,cover_path FROM books WHERE source_md5='exact-cover-md5'`).get();
  assert.equal(book.cover_status,'matched');
  assert.equal(book.cover_source,'koreader-embedded');
  assert.match(book.cover_path,/-koreader-.*\.jpg$/);
  assert.ok(fs.existsSync(path.join(dir,book.cover_path.replace(/^\//,''))));
  app.close();fs.rmSync(dir,{recursive:true,force:true});
});

test('manual browser cover storage has highest priority',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kovi-manual-cover-'));
  const app=openAppDb(dir);
  importPluginPayload(app,{books:[{md5:'manual-cover-md5',title:'Fahrenheit 451',authors:'Ray Bradbury'}],stats:[],annotation_sets:[]},{id:'reader-manual'});
  const jpg=Buffer.alloc(128);jpg[0]=0xff;jpg[1]=0xd8;jpg[2]=0xff;jpg[3]=0xe0;jpg[126]=0xff;jpg[127]=0xd9;
  const saved=saveManualCover(app,dir,app.prepare(`SELECT id FROM books WHERE source_md5='manual-cover-md5'`).get().id,jpg);
  assert.match(saved.path,/-manual-.*\.jpg$/);
  const book=app.prepare(`SELECT cover_status,cover_source,cover_path,cover_retry_mode FROM books WHERE source_md5='manual-cover-md5'`).get();
  assert.equal(book.cover_status,'manual');assert.equal(book.cover_source,'manual-upload');assert.equal(book.cover_retry_mode,null);
  const embedded=saveEmbeddedCover(app,dir,'manual-cover-md5',jpg);
  assert.equal(embedded.ignored,true);assert.equal(embedded.reason,'manual-cover');
  app.close();fs.rmSync(dir,{recursive:true,force:true});
});


test('cover history can restore an older selection and promote a cached candidate',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kovi-cover-history-'));const app=openAppDb(dir);
  importPluginPayload(app,{books:[{md5:'history-md5',title:'History Book',authors:'A. Writer'}],stats:[],annotation_sets:[]},{id:'reader-history'});
  const bookId=app.prepare(`SELECT id FROM books WHERE source_md5='history-md5'`).get().id;
  const jpg=Buffer.alloc(128);jpg[0]=0xff;jpg[1]=0xd8;jpg[2]=0xff;jpg[3]=0xe0;jpg[126]=0xff;jpg[127]=0xd9;
  saveEmbeddedCover(app,dir,'history-md5',jpg);const embedded=getBookCoverState(app,bookId).history.find(h=>h.source==='koreader-embedded');
  saveManualCover(app,dir,bookId,jpg);let state=getBookCoverState(app,bookId);assert.equal(state.history.length,2);assert.equal(state.book.cover_source,'manual-upload');
  assert.equal(selectCoverHistory(app,bookId,embedded.id),true);state=getBookCoverState(app,bookId);assert.equal(state.book.cover_source,'koreader-embedded');
  const candidatePath='/covers/history-candidate.jpg';fs.writeFileSync(path.join(dir,'covers','history-candidate.jpg'),jpg);
  app.prepare(`INSERT INTO cover_candidates(id,book_id,path,source,strategy,score,title,authors,created_at) VALUES('candidate-1',?,?,?,?,?,?,?,?)`).run(bookId,candidatePath,'openlibrary','test-candidate',0.98,'History Book','A. Writer',new Date().toISOString());
  assert.equal(selectCoverCandidate(app,bookId,'candidate-1'),true);state=getBookCoverState(app,bookId);assert.equal(state.book.cover_source,'openlibrary');assert.equal(state.history[0].path,candidatePath);assert.equal(state.history[0].selected,1);
  app.close();fs.rmSync(dir,{recursive:true,force:true});
});

test('explicit online retry can replace a KOReader embedded cover',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kovi-cover-online-retry-'));
  const app=openAppDb(dir);
  importPluginPayload(app,{books:[{md5:'retry-md5',title:'Fahrenheit 451',authors:'Ray Bradbury',language:'it-IT'}],stats:[],annotation_sets:[]},{id:'reader-retry'});
  const jpg=Buffer.alloc(128);jpg[0]=0xff;jpg[1]=0xd8;jpg[2]=0xff;jpg[3]=0xe0;jpg[126]=0xff;jpg[127]=0xd9;
  saveEmbeddedCover(app,dir,'retry-md5',jpg);
  const book=app.prepare(`SELECT id,title,authors,language,isbn,identifiers FROM books WHERE source_md5='retry-md5'`).get();
  app.prepare(`UPDATE books SET cover_status='pending',cover_retry_mode='online' WHERE id=?`).run(book.id);
  await processCoverBook(app,dir,book,{resolver:async()=>({status:'matched',path:'/covers/retry-online.jpg',source:'openlibrary',score:1,matchedTitle:'Fahrenheit 451',strategy:'test',trace:[]})});
  const after=app.prepare(`SELECT cover_status,cover_source,cover_path,cover_retry_mode FROM books WHERE id=?`).get(book.id);
  assert.equal(after.cover_status,'matched');assert.equal(after.cover_source,'openlibrary');assert.equal(after.cover_path,'/covers/retry-online.jpg');assert.equal(after.cover_retry_mode,null);
  app.close();fs.rmSync(dir,{recursive:true,force:true});
});

test('failed explicit online retry keeps the existing KOReader cover and clears pending state',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kovi-cover-retry-fallback-'));
  const app=openAppDb(dir);
  importPluginPayload(app,{books:[{md5:'retry-fallback-md5',title:'Fahrenheit 451',authors:'Ray Bradbury'}],stats:[],annotation_sets:[]},{id:'reader-retry-fallback'});
  const jpg=Buffer.alloc(128);jpg[0]=0xff;jpg[1]=0xd8;jpg[2]=0xff;jpg[3]=0xe0;jpg[126]=0xff;jpg[127]=0xd9;
  saveEmbeddedCover(app,dir,'retry-fallback-md5',jpg);
  const before=app.prepare(`SELECT id,title,authors,language,isbn,identifiers,cover_path FROM books WHERE source_md5='retry-fallback-md5'`).get();
  app.prepare(`UPDATE books SET cover_status='pending',cover_retry_mode='online' WHERE id=?`).run(before.id);
  await processCoverBook(app,dir,before,{resolver:async()=>({status:'none',score:0.4,trace:[{provider:'test'}]})});
  const after=app.prepare(`SELECT cover_status,cover_source,cover_path,cover_retry_mode FROM books WHERE id=?`).get(before.id);
  assert.equal(after.cover_status,'matched');assert.equal(after.cover_source,'koreader-embedded');assert.equal(after.cover_path,before.cover_path);assert.equal(after.cover_retry_mode,null);
  app.close();fs.rmSync(dir,{recursive:true,force:true});
});

test('stale pending local cover is repaired instead of being retried forever',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kovi-cover-pending-local-'));
  const app=openAppDb(dir);
  importPluginPayload(app,{books:[{md5:'stale-pending-md5',title:'Book'}],stats:[],annotation_sets:[]},{id:'reader-stale'});
  const jpg=Buffer.alloc(128);jpg[0]=0xff;jpg[1]=0xd8;jpg[2]=0xff;jpg[3]=0xe0;jpg[126]=0xff;jpg[127]=0xd9;
  saveEmbeddedCover(app,dir,'stale-pending-md5',jpg);
  const book=app.prepare(`SELECT id,title,authors,language,isbn,identifiers FROM books WHERE source_md5='stale-pending-md5'`).get();
  app.prepare(`UPDATE books SET cover_status='pending',cover_retry_mode=NULL WHERE id=?`).run(book.id);
  let called=false;
  await processCoverBook(app,dir,book,{resolver:async()=>{called=true;throw new Error('should not run')}});
  const after=app.prepare(`SELECT cover_status,cover_source FROM books WHERE id=?`).get(book.id);
  assert.equal(called,false);assert.equal(after.cover_status,'matched');assert.equal(after.cover_source,'koreader-embedded');
  app.close();fs.rmSync(dir,{recursive:true,force:true});
});


test('Calibre CLI arguments are passed as data, not a shell command',()=>{
  const args=calibreArgsForBook({title:'Book; touch /tmp/pwned',authors:'Author $(id)',isbn:'9791259676450'},'/tmp/cover.jpg');
  assert.deepEqual(args.slice(0,4),['--title','Book; touch /tmp/pwned','--cover','/tmp/cover.jpg']);
  assert.ok(args.includes('Author $(id)'));
  assert.ok(args.includes('9791259676450'));
});

test('Calibre resolver accepts the cover produced by fetch-ebook-metadata', async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kovi-calibre-cli-'));
  const jpg=Buffer.alloc(256);jpg[0]=0xff;jpg[1]=0xd8;jpg[2]=0xff;jpg[3]=0xe0;jpg[254]=0xff;jpg[255]=0xd9;
  const fakeExec=(file,args,opts,cb)=>{
    assert.equal(file,'fetch-ebook-metadata');
    const idx=args.indexOf('--cover'); assert.ok(idx>=0);
    fs.writeFileSync(args[idx+1],jpg);
    cb(null,'metadata ok','');
  };
  const r=await fetchCoverWithCalibre({id:'cal1',title:'Il ladro linguanera',authors:'Christopher Buehlman'},{dataDir:dir,execFileImpl:fakeExec});
  assert.equal(r.status,'matched');assert.equal(r.buffer.length,jpg.length);
  fs.rmSync(dir,{recursive:true,force:true});
});

test('cover resolver falls back to an injected Calibre-style multi-source result after native catalogue misses', async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kovi-calibre-cover-'));
  const jpg=Buffer.alloc(512);jpg[0]=0xff;jpg[1]=0xd8;jpg[2]=0xff;jpg[3]=0xe0;jpg[510]=0xff;jpg[511]=0xd9;
  let nativeCalls=0;
  const fakeFetch=async()=>{nativeCalls++;return new Response(JSON.stringify({numFound:0,docs:[]}),{status:200})};
  const calibreResolver=async()=>({status:'matched',buffer:jpg});
  const r=await resolveCover({id:'calibrebook',title:'Il Re Giallo',authors:'Robert W. Chambers',language:'it'},{dataDir:dir,fetchImpl:fakeFetch,calibreResolver});
  assert.equal(r.status,'matched');assert.equal(r.source,'calibre');assert.ok(nativeCalls>0);
  assert.match(r.path,/-calibre-.*\.jpg$/);
  fs.rmSync(dir,{recursive:true,force:true});
});

test('reordered translated series titles clear the confidence threshold',()=>{
  const score=scoreCandidate(
    {title:'Nevernight. I grandi giochi',authors:'Jay Kristoff',language:'it'},
    {title:'I grandi giochi. Nevernight',author_name:[],cover_i:77,language:['ita']}
  );
  assert.ok(score>=.72,`expected reordered exact token set to match, got ${score}`);
});

test('Calibre resolver runs cover-only stage when identify cannot find a book', async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kovi-calibre-direct-'));
  const jpg=Buffer.alloc(320);jpg[0]=0xff;jpg[1]=0xd8;jpg[2]=0xff;jpg[3]=0xe0;jpg[318]=0xff;jpg[319]=0xd9;
  let identifyCalls=0,directCalls=0;
  const fakeExec=(file,args,opts,cb)=>{
    if(file==='fetch-ebook-metadata'){
      identifyCalls++;
      const err=Object.assign(new Error('no results'),{code:1});
      return cb(err,'','No results found');
    }
    if(file==='calibre-debug'){
      directCalls++;
      assert.deepEqual(args.slice(0,1),['--command']);
      assert.equal(opts.env.KOVI_CALIBRE_TITLE,'Il diavolo nella bottiglia');
      fs.writeFileSync(opts.env.KOVI_CALIBRE_OUTPUT,jpg);
      return cb(null,'provider=Google Images','');
    }
    cb(Object.assign(new Error('unexpected binary'),{code:'ENOENT'}),'','');
  };
  const r=await fetchCoverWithCalibre({id:'cal-direct',title:'Il diavolo nella bottiglia',authors:'Robert Louis Stevenson'},{dataDir:dir,execFileImpl:fakeExec});
  assert.equal(r.status,'matched');
  assert.equal(r.buffer.length,jpg.length);
  assert.ok(identifyCalls>=1);
  assert.equal(directCalls,1);
  fs.rmSync(dir,{recursive:true,force:true});
});

test('Calibre preserves machine-readable identifiers when cover plugins fail', async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kovi-calibre-meta-'));
  let directCalls=0,metadataCalls=0;
  const fakeExec=(file,args,opts,cb)=>{
    if(file==='fetch-ebook-metadata') return cb(null,'','No cover found');
    if(file==='calibre-debug' && opts.env.KOVI_CALIBRE_OUTPUT){
      directCalls++;
      return cb(null,'no-cover','');
    }
    if(file==='calibre-debug'){
      metadataCalls++;
      return cb(null,'KOVI_METADATA_JSON=[{"title":"La montagna dei gatti. Fiabe e leggende del terzo fratello Grimm","authors":["Ferdinand Grimm"],"identifiers":{"google":"abc123","isbn":"9781234567897"},"languages":["ita"]}]','');
    }
    cb(Object.assign(new Error('unexpected binary'),{code:'ENOENT'}),'','');
  };
  const r=await fetchCoverWithCalibre({id:'meta1',title:'La montagna dei gatti',authors:'Ferdinand Grimm'},{dataDir:dir,execFileImpl:fakeExec});
  assert.equal(r.status,'none');
  assert.equal(r.metadataCandidates.length,1);
  assert.equal(r.metadataCandidates[0].identifiers.google,'abc123');
  assert.ok(directCalls>=1);assert.equal(metadataCalls,1);
  fs.rmSync(dir,{recursive:true,force:true});
});

test('cover resolver reuses Calibre Google Books identifiers after Calibre image download fails', async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kovi-calibre-google-id-'));
  const jpg=Buffer.alloc(420);jpg[0]=0xff;jpg[1]=0xd8;jpg[2]=0xff;jpg[3]=0xe0;jpg[418]=0xff;jpg[419]=0xd9;
  const urls=[];
  const fakeFetch=async(url)=>{
    urls.push(String(url));
    if(String(url).startsWith('https://openlibrary.org/search.json')) return new Response(JSON.stringify({numFound:0,docs:[]}),{status:200});
    if(String(url).startsWith('https://covers.openlibrary.org/')) return new Response('',{status:404});
    if(String(url).startsWith('https://books.google.com/books?id=gvol1')) return new Response(jpg,{status:200,headers:{'Content-Type':'image/jpeg','Content-Length':String(jpg.length)}});
    return new Response('',{status:404});
  };
  const calibreResolver=async()=>({status:'none',metadataCandidates:[{title:'La montagna dei gatti',authors:['Ferdinand Grimm'],identifiers:{google:'gvol1'},languages:['ita']} ]});
  const r=await resolveCover({id:'gmeta',title:'La montagna dei gatti',authors:'Ferdinand Grimm',language:'it'},{dataDir:dir,fetchImpl:fakeFetch,calibreResolver});
  assert.equal(r.status,'matched');
  assert.equal(r.source,'googlebooks-via-calibre-id');
  assert.ok(urls.some(u=>u.includes('books.google.com/books?id=gvol1')));
  fs.rmSync(dir,{recursive:true,force:true});
});


test('backup archive contains a consistent database snapshot, manifest, and selected cover files',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kovi-backup-'));const app=openAppDb(dir);
  importPluginPayload(app,{books:[{md5:'backup-md5',title:'Backup Book'}],stats:[],annotation_sets:[]},{id:'reader-backup'});
  const bookId=app.prepare(`SELECT id FROM books WHERE source_md5='backup-md5'`).get().id;
  const jpg=Buffer.alloc(128);jpg[0]=0xff;jpg[1]=0xd8;jpg[2]=0xff;jpg[3]=0xe0;jpg[126]=0xff;jpg[127]=0xd9;
  const saved=saveManualCover(app,dir,bookId,jpg);const output=path.join(dir,'kovi-backup.tar.gz');
  const result=await createBackupArchive(app,dir,output,{version:'2026.09.25'});assert.equal(result.covers,1);assert.ok(fs.statSync(output).size>512);
  const tar=gunzipSync(fs.readFileSync(output));const text=tar.toString('latin1');assert.ok(text.includes('manifest.json'));assert.ok(text.includes('kovi.sqlite'));assert.ok(text.includes(saved.path.replace(/^\//,'')));assert.ok(text.includes('2026.09.25'));
  app.close();fs.rmSync(dir,{recursive:true,force:true});
});
