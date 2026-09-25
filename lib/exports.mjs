import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

function sqlString(value){return `'${String(value).replaceAll("'","''")}'`}
function csv(value){const s=String(value??'');return /[",\r\n]/.test(s)?`"${s.replaceAll('"','""')}"`:s}
function md(value){return String(value??'').replace(/\r?\n/g,' ').trim()}
function octal(value,width){return Math.max(0,Number(value)||0).toString(8).padStart(width-1,'0').slice(-(width-1))+'\0'}
function put(buf,offset,length,value){const src=Buffer.from(String(value));src.copy(buf,offset,0,Math.min(length,src.length))}
function tarHeader(name,size,mtime=Math.floor(Date.now()/1000),mode=0o644){
  const h=Buffer.alloc(512,0);put(h,0,100,name);put(h,100,8,octal(mode,8));put(h,108,8,octal(0,8));put(h,116,8,octal(0,8));put(h,124,12,octal(size,12));put(h,136,12,octal(mtime,12));h.fill(0x20,148,156);h[156]='0'.charCodeAt(0);put(h,257,6,'ustar\0');put(h,263,2,'00');put(h,265,32,'kovi');put(h,297,32,'kovi');let sum=0;for(const b of h)sum+=b;put(h,148,8,sum.toString(8).padStart(6,'0')+'\0 ');return h;
}
async function writeChunk(stream,chunk){if(!stream.write(chunk)) await new Promise(resolve=>stream.once('drain',resolve))}
async function addBuffer(stream,name,buffer){await writeChunk(stream,tarHeader(name,buffer.length));await writeChunk(stream,buffer);const pad=(512-(buffer.length%512))%512;if(pad)await writeChunk(stream,Buffer.alloc(pad))}
async function addFile(stream,name,filePath){const st=await fsp.stat(filePath);await writeChunk(stream,tarHeader(name,st.size,Math.floor(st.mtimeMs/1000),st.mode&0o777));for await(const chunk of fs.createReadStream(filePath)) await writeChunk(stream,chunk);const pad=(512-(st.size%512))%512;if(pad)await writeChunk(stream,Buffer.alloc(pad))}

export async function createBackupArchive(db,dataDir,outputPath,{version='unknown'}={}){
  const workDir=path.join(dataDir,'uploads');await fsp.mkdir(workDir,{recursive:true});
  const snapshot=path.join(workDir,`.backup-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`);
  const tarPath=`${outputPath}.tar`;
  try{
    db.exec(`VACUUM INTO ${sqlString(snapshot)}`);
    const manifest={name:'kovi backup',version,generated_at:new Date().toISOString(),database:'kovi.sqlite',covers:[]};
    const referenced=new Set(db.prepare(`SELECT path FROM book_covers UNION SELECT cover_path path FROM books WHERE cover_path IS NOT NULL`).all().map(r=>r.path).filter(Boolean));
    const coverFiles=[];
    for(const webPath of referenced){
      const relative=String(webPath).replace(/^\/+/, '');
      if(!relative.startsWith('covers/'))continue;
      const local=path.join(dataDir,relative);try{const st=await fsp.stat(local);if(st.isFile()){coverFiles.push({webPath,local,relative});manifest.covers.push(webPath)}}catch{}
    }
    const tar=fs.createWriteStream(tarPath,{flags:'wx',mode:0o600});
    await addBuffer(tar,'manifest.json',Buffer.from(JSON.stringify(manifest,null,2)+'\n'));
    await addFile(tar,'kovi.sqlite',snapshot);
    for(const file of coverFiles) await addFile(tar,file.relative,file.local);
    await writeChunk(tar,Buffer.alloc(1024));tar.end();await new Promise((resolve,reject)=>{tar.on('finish',resolve);tar.on('error',reject)});
    await pipeline(fs.createReadStream(tarPath),createGzip({level:6}),fs.createWriteStream(outputPath,{flags:'wx',mode:0o600}));
    return {covers:coverFiles.length};
  } finally {await fsp.rm(snapshot,{force:true}).catch(()=>{});await fsp.rm(tarPath,{force:true}).catch(()=>{});}
}

function humanDuration(seconds){
  let remaining=Math.max(0,Math.round(Number(seconds)||0));
  const hours=Math.floor(remaining/3600);remaining%=3600;
  const minutes=Math.floor(remaining/60);const secs=remaining%60;
  const parts=[];if(hours)parts.push(`${hours}h`);if(minutes)parts.push(`${minutes}m`);if(secs||!parts.length)parts.push(`${secs}s`);
  return parts.join(' ');
}
function humanUnixTime(value){
  const seconds=Number(value);if(!Number.isFinite(seconds)||seconds<=0)return '';
  const d=new Date(seconds*1000);if(Number.isNaN(d.getTime()))return '';
  const pad=n=>String(n).padStart(2,'0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`;
}

export function sendBooksCsv(res,db,headers={}){
  res.writeHead(200,{...headers,'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="kovi-books.csv"','Cache-Control':'no-store'});
  res.write('title,authors,series,language,isbn,status,document_progress,reading_time,read_pages,highlights,last_opened,cover_source\r\n');
  for(const b of db.prepare(`SELECT title,authors,series,language,isbn,total_read_time,total_read_pages,highlights,last_open,cover_source,pages,koreader_status,read_override,(SELECT page FROM reading_sessions s WHERE s.book_id=books.id ORDER BY start_time DESC LIMIT 1) last_page,(SELECT total_pages FROM reading_sessions s WHERE s.book_id=books.id ORDER BY start_time DESC LIMIT 1) last_total_pages FROM books ORDER BY title COLLATE NOCASE`).iterate()){
    const total=Number(b.last_total_pages||b.pages||0),progress=total>0?Math.min(100,Math.round(Number(b.last_page||0)/total*100)):0;
    const read=b.read_override==null?b.koreader_status==='complete'||progress===100:Boolean(b.read_override);
    const status=read?'read':b.read_override===0?'unread':progress?'reading':'unread';
    res.write([b.title,b.authors,b.series,b.language,b.isbn,status,`${progress}%`,humanDuration(b.total_read_time),b.total_read_pages,b.highlights,humanUnixTime(b.last_open),b.cover_source].map(csv).join(',')+'\r\n');
  }
  res.end();
}

export function sendHighlightsMarkdown(res,db,headers={}){
  res.writeHead(200,{...headers,'Content-Type':'text/markdown; charset=utf-8','Content-Disposition':'attachment; filename="kovi-highlights.md"','Cache-Control':'no-store'});
  const books=db.prepare(`SELECT id,title,authors FROM books WHERE EXISTS (SELECT 1 FROM annotations a WHERE a.book_id=books.id AND a.annotation_type IN ('highlight','note') AND (a.text IS NOT NULL OR a.note IS NOT NULL)) ORDER BY title COLLATE NOCASE`).all();
  for(const b of books){res.write(`# ${md(b.title)}\n\n${b.authors?`_${md(b.authors)}_\n\n`:''}`);const anns=db.prepare(`SELECT annotation_type,text,note,chapter,page,pageno,annotation_datetime FROM annotations WHERE book_id=? AND annotation_type IN ('highlight','note') ORDER BY COALESCE(annotation_datetime,created_at)`).all(b.id);for(const a of anns){if(a.text)res.write(`> ${String(a.text).replace(/\r?\n/g,'\n> ')}\n\n`);if(a.note)res.write(`**Note:** ${String(a.note).trim()}\n\n`);const loc=[a.chapter,a.pageno?`page ${a.pageno}`:a.page?`page ${a.page}`:null,a.annotation_datetime].filter(Boolean).map(md).join(' · ');if(loc)res.write(`_${loc}_\n\n`);res.write('---\n\n')}}res.end();
}
