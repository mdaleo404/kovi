import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { openAppDb, resolveTimeZone, listBooks, getBook, setBookReadOverride, getDashboard, getCalendar, createPairingCode, getPairingStatus, consumePairingCode, authenticateDevice, listDevices, revokeDevice, updateDevicePluginVersion, recordDeviceSync, getStatus } from './lib/db.mjs';
import { importKoReaderDb, importPluginPayload, removeExcludedBooks } from './lib/importer.mjs';
import { scheduleCoverWork, saveEmbeddedCover, saveManualCover, queueOnlineCoverRetry, getBookCoverState, findCoverCandidates, selectCoverCandidate, selectCoverHistory } from './lib/covers.mjs';
import { json, randomId, cleanText } from './lib/security.mjs';
import { info, warn, error as logError } from './lib/logger.mjs';
import { createBackupArchive, sendBooksCsv, sendHighlightsMarkdown } from './lib/exports.mjs';

const VERSION = '2026.09.25';
const LATEST_PLUGIN_VERSION = '2026.09.25';
const MIN_COVER_PLUGIN_VERSION = '2026.09.25';
const MIN_INCREMENTAL_PLUGIN_VERSION = '2026.09.25';
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(process.env.DATA_PATH || path.join(ROOT, 'data'));
const PUBLIC_DIR = path.join(ROOT, 'public');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const COVER_DIR = path.join(DATA_DIR, 'covers');
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 3000);
const TIME_ZONE = resolveTimeZone(process.env.TZ);
const MAX_FILE_BYTES = Number(process.env.MAX_FILE_SIZE_MB || 100) * 1024 * 1024;
const MAX_JSON_BYTES = Number(process.env.MAX_JSON_MB || 20) * 1024 * 1024;
const MAX_COVER_BYTES = 4 * 1024 * 1024;
const WEB_CSRF = randomId(24);
const pairAttempts = new Map();

function versionParts(value){return String(value||'0').split('.').map(x=>Number.parseInt(x,10)||0).slice(0,3)}
function versionAtLeast(value,minimum){const a=versionParts(value),b=versionParts(minimum);for(let i=0;i<3;i++){if((a[i]||0)>(b[i]||0))return true;if((a[i]||0)<(b[i]||0))return false}return true}
function deviceView(d){return {...d,needs_update:!versionAtLeast(d.plugin_version,LATEST_PLUGIN_VERSION),supports_cover_sync:versionAtLeast(d.plugin_version,MIN_COVER_PLUGIN_VERSION),supports_incremental_sync:versionAtLeast(d.plugin_version,MIN_INCREMENTAL_PLUGIN_VERSION),latest_plugin_version:LATEST_PLUGIN_VERSION,min_cover_plugin_version:MIN_COVER_PLUGIN_VERSION,min_incremental_plugin_version:MIN_INCREMENTAL_PLUGIN_VERSION}}

try {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  fs.mkdirSync(COVER_DIR, { recursive: true });
  fs.accessSync(DATA_DIR, fs.constants.R_OK | fs.constants.W_OK);
} catch (err) {
  if (err?.code === 'EACCES') {
    logError('startup.storage','kovi cannot write to its data directory.',{dataDir:DATA_DIR});
    logError('startup.storage.hint','For Docker bind mounts, make sure the host data directory is writable by the container user, or use the default named-volume docker-compose.yml.');
  }
  throw err;
}
const db = openAppDb(DATA_DIR, {timeZone:TIME_ZONE});
const excludedOnStartup = removeExcludedBooks(db);
if (excludedOnStartup) info('library.cleanup','Removed excluded KOReader manual entries already present in the library.',{removed:excludedOnStartup});
scheduleCoverWork(db, DATA_DIR, [], {reason:'startup'});

function securityHeaders(extra={}) {
  return {
    'X-Content-Type-Options':'nosniff',
    'X-Frame-Options':'DENY',
    'Referrer-Policy':'no-referrer',
    'Permissions-Policy':'camera=(), microphone=(), geolocation=()',
    'Cross-Origin-Resource-Policy':'same-origin',
    'Content-Security-Policy':"default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    ...extra,
  };
}

async function readJson(req, max=MAX_JSON_BYTES) {
  const chunks=[]; let total=0;
  for await (const chunk of req) {
    total += chunk.length;
    if(total > max) throw Object.assign(new Error('JSON payload too large.'),{status:413});
    chunks.push(chunk);
  }
  if(!total) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Invalid JSON.'),{status:400}); }
}

async function readBinary(req, max=MAX_COVER_BYTES) {
  const declared=Number(req.headers['content-length']||0);
  if(declared && declared>max) throw Object.assign(new Error('Cover upload is too large.'),{status:413});
  const chunks=[]; let total=0;
  for await (const chunk of req) {
    total += chunk.length;
    if(total > max) throw Object.assign(new Error('Cover upload is too large.'),{status:413});
    chunks.push(chunk);
  }
  if(!total) throw Object.assign(new Error('Cover upload was empty.'),{status:400});
  return Buffer.concat(chunks);
}

function routeParam(pathname, pattern) {
  const m = pattern.exec(pathname); return m ? m.slice(1).map(decodeURIComponent) : null;
}

function requireWebCsrf(req) {
  if (req.headers['x-kovi-csrf'] !== WEB_CSRF) throw Object.assign(new Error('Missing browser request token.'), {status:403});
}
function checkPairRate(req) {
  const key=req.socket.remoteAddress || 'unknown', now=Date.now(), windowMs=10*60_000;
  const row=pairAttempts.get(key) || {start:now,count:0};
  if(now-row.start>windowMs){row.start=now;row.count=0}
  row.count++;pairAttempts.set(key,row);
  if(row.count>30) throw Object.assign(new Error('Too many pairing attempts. Try again later.'),{status:429});
}

function storageStats(){
  let databaseBytes=0,coverBytes=0,coverFiles=0;
  try{databaseBytes=fs.statSync(path.join(DATA_DIR,'kovi.sqlite')).size}catch{}
  try{for(const name of fs.readdirSync(COVER_DIR)){try{const st=fs.statSync(path.join(COVER_DIR,name));if(st.isFile()){coverBytes+=st.size;coverFiles++}}catch{}}}catch{}
  return {database_bytes:databaseBytes,cover_bytes:coverBytes,cover_files:coverFiles,total_bytes:databaseBytes+coverBytes};
}

async function handleApi(req,res,url) {
  if(req.method==='GET' && url.pathname==='/api/session') return json(res,200,{csrf:WEB_CSRF},securityHeaders());
  if(req.method==='GET' && url.pathname==='/api/health') return json(res,200,{ok:true,name:'kovi',version:VERSION},securityHeaders());
  if(req.method==='GET' && url.pathname==='/api/plugin/ping') {
    info('plugin.ping','KOReader ping received.',{remote:req.socket.remoteAddress || 'unknown',userAgent:cleanText(req.headers['user-agent'],120) || 'none'});
    return json(res,200,{ok:true,name:'kovi',version:VERSION},securityHeaders());
  }
  if(req.method==='GET' && url.pathname==='/api/books') return json(res,200,{books:listBooks(db)},securityHeaders());
  const bookRoute=routeParam(url.pathname,/^\/api\/books\/([^/]+)$/);
  if(req.method==='GET' && bookRoute){ const book=getBook(db,bookRoute[0]); if(!book)return json(res,404,{error:'Book not found.'},securityHeaders()); const covers=getBookCoverState(db,book.id); return json(res,200,{...book,cover_history:covers?.history||[],cover_candidates:covers?.candidates||[],cover_job:covers?.job||null},securityHeaders()); }
  const bookReadRoute=routeParam(url.pathname,/^\/api\/books\/([^/]+)\/read$/);
  if(req.method==='PUT' && bookReadRoute){
    requireWebCsrf(req);
    const body=await readJson(req,4096);
    if(body.read!==null && typeof body.read!=='boolean') return json(res,400,{error:'read must be true, false, or null.'},securityHeaders());
    const book=setBookReadOverride(db,bookReadRoute[0],body.read);
    return json(res,book?200:404,book||{error:'Book not found.'},securityHeaders());
  }
  if(req.method==='GET' && url.pathname==='/api/dashboard') return json(res,200,getDashboard(db,{from:url.searchParams.get('from'),to:url.searchParams.get('to')}),securityHeaders());
  if(req.method==='GET' && url.pathname==='/api/calendar') return json(res,200,getCalendar(db,{from:url.searchParams.get('from'),to:url.searchParams.get('to')}),securityHeaders());
  if(req.method==='GET' && url.pathname==='/api/devices') return json(res,200,{devices:listDevices(db).map(deviceView),latest_plugin_version:LATEST_PLUGIN_VERSION},securityHeaders());
  if(req.method==='GET' && url.pathname==='/api/status') return json(res,200,{...getStatus(db),storage:storageStats(),version:VERSION,latest_plugin_version:LATEST_PLUGIN_VERSION,time_zone:TIME_ZONE,generated_at:new Date().toISOString()},securityHeaders({'Cache-Control':'no-store'}));
  if(req.method==='GET' && url.pathname==='/api/export/books.csv'){sendBooksCsv(res,db,securityHeaders());return true}
  if(req.method==='GET' && url.pathname==='/api/export/highlights.md'){sendHighlightsMarkdown(res,db,securityHeaders());return true}
  if(req.method==='GET' && url.pathname==='/api/backup'){
    const backupPath=path.join(UPLOAD_DIR,`kovi-backup-${Date.now()}-${randomId(6)}.tar.gz`);
    await createBackupArchive(db,DATA_DIR,backupPath,{version:VERSION});
    try{const st=await fsp.stat(backupPath);res.writeHead(200,securityHeaders({'Content-Type':'application/gzip','Content-Disposition':`attachment; filename="kovi-backup-${new Date().toISOString().slice(0,10)}.tar.gz"`,'Content-Length':st.size,'Cache-Control':'no-store'}));await pipeline(fs.createReadStream(backupPath),res)}finally{await fsp.rm(backupPath,{force:true}).catch(()=>{})}
    return true;
  }

  if(req.method==='POST' && url.pathname==='/api/pairing-codes') {
    requireWebCsrf(req);
    const body=await readJson(req,4096);
    const label=cleanText(body.label,80)||'KOReader';
    const pair=createPairingCode(db,label);
    info('pairing.code.created','Created a short-lived pairing request.',{requestId:pair.requestId,label,expiresAt:new Date(pair.expiresAt).toISOString()});
    return json(res,201,pair,securityHeaders());
  }

  const pairingStatus=routeParam(url.pathname,/^\/api\/pairing-codes\/([^/]+)$/);
  if(req.method==='GET' && pairingStatus){
    const status=getPairingStatus(db,pairingStatus[0]);
    return json(res,status?200:404,status||{error:'Pairing request not found.'},securityHeaders());
  }

  const revoke=routeParam(url.pathname,/^\/api\/devices\/([^/]+)\/revoke$/);
  if(req.method==='POST' && revoke) {
    requireWebCsrf(req);
    const changed=revokeDevice(db,revoke[0]);
    if(changed) info('device.revoked','Revoked a KOReader device token.',{deviceId:revoke[0]});
    return json(res,changed?200:404,{ok:changed},securityHeaders());
  }

  if(req.method==='POST' && url.pathname==='/api/plugin/pair') {
    checkPairRate(req);
    const body=await readJson(req,32*1024);
    const paired=consumePairingCode(db,body.code,{deviceId:body.device_id,model:cleanText(body.model,120),version:cleanText(body.version,40)});
    if(!paired) {
      warn('pairing.rejected','Pairing attempt rejected because the code was invalid, expired, or already used.',{remote:req.socket.remoteAddress || 'unknown',deviceId:cleanText(body.device_id,128),model:cleanText(body.model,120)});
      return json(res,401,{error:'Pairing code is invalid, expired, or already used.'},securityHeaders());
    }
    info('device.paired','KOReader paired successfully.',{deviceId:paired.deviceId,model:cleanText(body.model,120),pluginVersion:cleanText(body.version,40),remote:req.socket.remoteAddress || 'unknown'});
    if(!versionAtLeast(body.version,MIN_COVER_PLUGIN_VERSION)) warn('plugin.outdated','Paired KOReader plugin is too old for embedded-cover and ISBN sync.',{deviceId:paired.deviceId,pluginVersion:cleanText(body.version,40),minimumVersion:MIN_COVER_PLUGIN_VERSION,latestVersion:LATEST_PLUGIN_VERSION});
    return json(res,200,{message:'KOReader paired with kovi.',token:paired.token,device_id:paired.deviceId,latest_plugin_version:LATEST_PLUGIN_VERSION,update_recommended:!versionAtLeast(body.version,LATEST_PLUGIN_VERSION)},securityHeaders());
  }

  if(req.method==='POST' && url.pathname==='/api/plugin/import') {
    const device=authenticateDevice(db,req.headers.authorization);
    if(!device) {
      warn('plugin.sync.rejected','Rejected plugin sync with missing or invalid device token.',{remote:req.socket.remoteAddress || 'unknown'});
      return json(res,401,{error:'Device token is missing or invalid.'},securityHeaders());
    }
    const body=await readJson(req);
    const reportedVersion=cleanText(body?.version,40)||device.plugin_version||'';
    if(reportedVersion) updateDevicePluginVersion(db,device.id,reportedVersion);
    info('plugin.sync.start','KOReader sync started.',{deviceId:device.id,books:Array.isArray(body?.books)?body.books.length:0,stats:Array.isArray(body?.stats)?body.stats.length:0,annotationSets:Array.isArray(body?.annotation_sets)?body.annotation_sets.length:0});
    const result=importPluginPayload(db,body,device);
    const coverQueueIds=[...new Set([...(result.newBookIds||[]),...(result.coverRefreshIds||[])])];
    scheduleCoverWork(db,DATA_DIR,coverQueueIds,{reason:`plugin-sync:${device.id}`,delayMs:(result.coverRequests?.length||0)>0?4000:50});
    if((result.coverRequests?.length||0)>0 && !versionAtLeast(reportedVersion,MIN_COVER_PLUGIN_VERSION)) warn('plugin.outdated.cover-sync','KOReader ignored server cover requests because its plugin predates embedded-cover sync. Update the kovi plugin on the reader.',{deviceId:device.id,pluginVersion:reportedVersion||'unknown',minimumVersion:MIN_COVER_PLUGIN_VERSION,missingCoverRequests:result.coverRequests.length});
    recordDeviceSync(db,device.id,result,{mode:result.syncMode,cursorBefore:result.syncCursorBefore,cursorAfter:result.syncCursorAfter});
    info('plugin.sync.complete','KOReader sync completed.',{deviceId:device.id,...result,coverRequests:result.coverRequests?.length||0,newBookIds:undefined,coverRefreshIds:undefined});
    return json(res,200,{
      message:`Synced ${result.booksSeen} books, ${result.sessionsSeen} reading rows, and ${result.annotationsStored} annotations.`,
      ...result,
      sync_cursor:result.syncCursorAfter,
      sync_mode:result.syncMode,
      cover_requests:result.coverRequests||[],
      latest_plugin_version:LATEST_PLUGIN_VERSION,
      update_recommended:!versionAtLeast(reportedVersion,LATEST_PLUGIN_VERSION),
      coverRequests:undefined,
    },securityHeaders());
  }

  if(req.method==='POST' && url.pathname==='/api/plugin/cover') {
    const device=authenticateDevice(db,req.headers.authorization);
    if(!device) {
      warn('cover.embedded.rejected','Rejected embedded cover upload with missing or invalid device token.',{remote:req.socket.remoteAddress || 'unknown'});
      return json(res,401,{error:'Device token is missing or invalid.'},securityHeaders());
    }
    const md5=cleanText(req.headers['x-kovi-book-md5'],128);
    if(!md5) return json(res,400,{error:'Book MD5 header is required.'},securityHeaders());
    const payload=await readBinary(req);
    const saved=saveEmbeddedCover(db,DATA_DIR,md5,payload);
    if(saved.ignored) {
      info('cover.embedded.ignored','Ignored embedded cover because a manual cover has priority.',{deviceId:device.id,bookId:saved.book?.id,title:saved.book?.title,reason:saved.reason});
      return json(res,200,{ok:true,ignored:true,reason:saved.reason},securityHeaders());
    }
    info('cover.embedded.saved','Stored an embedded cover supplied by KOReader.',{deviceId:device.id,bookId:saved.bookId,title:saved.title,bytes:saved.bytes,type:saved.type});
    return json(res,201,{ok:true,book_id:saved.bookId,path:saved.path},securityHeaders());
  }

  if(req.method==='PUT' && url.pathname==='/api/import/sqlite') {
    requireWebCsrf(req);
    const contentLength=Number(req.headers['content-length']||0);
    const filename=cleanText(req.headers['x-kovi-filename'],255)||'statistics.sqlite3';
    if(contentLength && contentLength>MAX_FILE_BYTES) return json(res,413,{error:`File exceeds ${Math.round(MAX_FILE_BYTES/1024/1024)} MB limit.`},securityHeaders());
    const tempPath=path.join(UPLOAD_DIR,`${Date.now()}-${randomId(12)}.sqlite`);
    let size=0; let first=Buffer.alloc(0);
    const limiter=new Transform({
      transform(chunk,enc,cb){
        size+=chunk.length;
        if(first.length<16) first=Buffer.concat([first,chunk]).subarray(0,16);
        if(size>MAX_FILE_BYTES) return cb(Object.assign(new Error('File too large.'),{status:413}));
        cb(null,chunk);
      }
    });
    info('import.sqlite.start','Manual KOReader database upload started.',{filename,contentLength:contentLength||undefined,remote:req.socket.remoteAddress || 'unknown'});
    try {
      await pipeline(req,limiter,fs.createWriteStream(tempPath,{flags:'wx',mode:0o600}));
      if(size<16 || first.toString('ascii',0,16)!=='SQLite format 3\u0000') throw Object.assign(new Error('The selected file is not a SQLite database.'),{status:400});
      const result=importKoReaderDb(db,tempPath,{filename,fileSize:size});
      scheduleCoverWork(db,DATA_DIR,result.newBookIds||[],{reason:'manual-import'});
      info(result.duplicate?'import.sqlite.duplicate':'import.sqlite.complete',result.duplicate?'Manual import matched an already-imported database.':'Manual KOReader database import completed.',{filename,fileSize:size,...result,newBookIds:undefined,sourceHash:undefined,warnings:result.warnings?.length||0});
      return json(res,200,{message:result.duplicate?'This exact database was already imported.':'Import complete.',...result},securityHeaders());
    } finally {
      await fsp.rm(tempPath,{force:true}).catch(()=>{});
    }
  }

  if(req.method==='POST' && url.pathname==='/api/covers/retry') {
    requireWebCsrf(req);
    const ids=db.prepare(`SELECT id FROM books WHERE cover_path IS NULL AND cover_status IN ('none','error','pending')`).all().map(r=>r.id);
    info('cover.retry.all','User requested retry for missing covers.',{queued:ids.length});
    scheduleCoverWork(db,DATA_DIR,ids,{reason:'user-retry-all'});
    return json(res,202,{message:'Cover lookup queued.',queued:ids.length},securityHeaders());
  }

  const manualBookCover=routeParam(url.pathname,/^\/api\/books\/([^/]+)\/cover$/);
  if(req.method==='PUT' && manualBookCover) {
    requireWebCsrf(req);
    const payload=await readBinary(req);
    const saved=saveManualCover(db,DATA_DIR,manualBookCover[0],payload);
    info('cover.manual.saved','Stored a cover uploaded from the browser.',{bookId:saved.bookId,title:saved.title,bytes:saved.bytes,type:saved.type});
    return json(res,201,{ok:true,book_id:saved.bookId,path:saved.path,cover_source:'manual-upload'},securityHeaders());
  }

  const candidateSearch=routeParam(url.pathname,/^\/api\/books\/([^/]+)\/cover\/candidates$/);
  if(req.method==='POST' && candidateSearch){
    requireWebCsrf(req);
    info('cover.candidates.start','User requested alternative cover candidates.',{bookId:candidateSearch[0]});
    const candidates=await findCoverCandidates(db,DATA_DIR,candidateSearch[0]);
    if(candidates===null)return json(res,404,{error:'Book not found.'},securityHeaders());
    info('cover.candidates.complete','Alternative cover search completed.',{bookId:candidateSearch[0],candidates:candidates.length});
    return json(res,200,{candidates},securityHeaders());
  }

  const candidateSelect=routeParam(url.pathname,/^\/api\/books\/([^/]+)\/cover\/candidates\/([^/]+)$/);
  if(req.method==='PUT' && candidateSelect){
    requireWebCsrf(req);const selected=selectCoverCandidate(db,candidateSelect[0],candidateSelect[1]);
    if(selected===null)return json(res,404,{error:'Book not found.'},securityHeaders());
    if(!selected)return json(res,404,{error:'Cover candidate not found.'},securityHeaders());
    info('cover.candidate.selected','User selected an alternative cover.',{bookId:candidateSelect[0],candidateId:candidateSelect[1]});
    return json(res,200,{ok:true},securityHeaders());
  }

  const historySelect=routeParam(url.pathname,/^\/api\/books\/([^/]+)\/cover\/history\/([^/]+)$/);
  if(req.method==='PUT' && historySelect){
    requireWebCsrf(req);const selected=selectCoverHistory(db,historySelect[0],historySelect[1]);
    if(selected===null)return json(res,404,{error:'Book not found.'},securityHeaders());
    if(!selected)return json(res,404,{error:'Cover history item not found.'},securityHeaders());
    info('cover.history.selected','User restored a previous cover.',{bookId:historySelect[0],coverId:historySelect[1]});
    return json(res,200,{ok:true},securityHeaders());
  }

  const retryBookCover=routeParam(url.pathname,/^\/api\/books\/([^/]+)\/cover\/retry$/);
  if(req.method==='POST' && retryBookCover) {
    requireWebCsrf(req);
    const book=queueOnlineCoverRetry(db,DATA_DIR,retryBookCover[0],{reason:'user-retry-book'});
    if(!book) return json(res,404,{error:'Book not found.'},securityHeaders());
    info('cover.retry.book','User requested a cover retry for one book.',{bookId:book.id,title:book.title});
    return json(res,202,{message:'Cover lookup queued for this book.'},securityHeaders());
  }

  return false;
}

const MIME={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.ico':'image/x-icon','.zip':'application/zip'};
async function serveFile(res,filePath,{cache=false}={}) {
  try {
    const st=await fsp.stat(filePath); if(!st.isFile()) return false;
    res.writeHead(200,securityHeaders({'Content-Type':MIME[path.extname(filePath).toLowerCase()]||'application/octet-stream','Content-Length':st.size,'Cache-Control':cache?'public, max-age=86400':'no-cache'}));
    fs.createReadStream(filePath).pipe(res); return true;
  } catch { return false; }
}

const server=http.createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,`http://${req.headers.host||'localhost'}`);
    if(url.pathname.startsWith('/api/')){
      const handled=await handleApi(req,res,url); if(handled!==false) return;
      return json(res,404,{error:'Not found.'},securityHeaders());
    }
    if(url.pathname.startsWith('/covers/')){
      const name=path.basename(url.pathname); if(name!==url.pathname.slice('/covers/'.length)) return json(res,400,{error:'Bad path.'},securityHeaders());
      if(await serveFile(res,path.join(COVER_DIR,name),{cache:true})) return;
      return json(res,404,{error:'Cover not found.'},securityHeaders());
    }
    const requested=url.pathname==='/'?'index.html':url.pathname.slice(1);
    const normalized=path.normalize(requested);
    if(normalized.startsWith('..')) return json(res,400,{error:'Bad path.'},securityHeaders());
    if(await serveFile(res,path.join(PUBLIC_DIR,normalized))) return;
    if(await serveFile(res,path.join(PUBLIC_DIR,'index.html'))) return;
    res.writeHead(404); res.end('Not found');
  }catch(err){
    const status=err.status||500;
    if(status>=500) logError('request.error','Request failed unexpectedly.',{method:req.method,url:req.url,error:err.message,stack:err.stack});
    else warn('request.rejected','Request rejected.',{method:req.method,url:req.url,status,error:err.message});
    if(!res.headersSent) json(res,status,{error:err.status?err.message:'Something went wrong.'},securityHeaders()); else res.destroy();
  }
});

server.listen(PORT,HOST,()=>info('startup.ready','kovi is ready.',{version:VERSION,url:`http://${HOST}:${PORT}`,dataDir:DATA_DIR,timeZone:TIME_ZONE,maxUploadMb:Math.round(MAX_FILE_BYTES/1024/1024)}));
