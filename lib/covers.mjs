import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { cleanText, nowIso, randomId } from './security.mjs';
import { info, warn } from './logger.mjs';
import { fetchCoverWithCalibre } from './calibre.mjs';

const VERSION = '2026.09.25';
const MATCH_THRESHOLD = 0.72;
const NETWORK_RETRIES = 2;
const COVER_WORKER_CONCURRENCY = Math.max(1, Math.min(4, Number.parseInt(process.env.COVER_WORKER_CONCURRENCY || '2', 10) || 2));
const GOOGLE_DUMMY_MD5 = new Set(['0de4383ebad0adad5eeb8975cd796657','a64fa89d7ebc97075c1d363fc5fea71f']);
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const normalize = (s='') => String(s).toLocaleLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
function tokens(s){ return new Set(normalize(s).split(' ').filter(Boolean)); }
function jaccard(a,b){ const A=tokens(a),B=tokens(b); if(!A.size||!B.size)return 0; let i=0; for(const x of A) if(B.has(x)) i++; return i/(A.size+B.size-i); }
function containment(a,b){ const A=tokens(a),B=tokens(b); if(!A.size||!B.size)return 0; let i=0; for(const x of A) if(B.has(x)) i++; return i/Math.min(A.size,B.size); }

const LANG = {
  it:'it', ita:'it', italian:'it', italiano:'it',
  en:'en', eng:'en', english:'en',
  fr:'fr', fre:'fr', fra:'fr', french:'fr', francais:'fr', français:'fr',
  de:'de', ger:'de', deu:'de', german:'de', deutsch:'de',
  es:'es', spa:'es', spanish:'es', espanol:'es', español:'es',
  pt:'pt', por:'pt', portuguese:'pt', portugues:'pt', português:'pt',
  ja:'ja', jpn:'ja', japanese:'ja',
};
const OL_LANG = {it:'ita',en:'eng',fr:'fre',de:'ger',es:'spa',pt:'por',ja:'jpn'};
function lang2(value){
  const raw=String(value||'').trim().toLocaleLowerCase();
  if(!raw) return null;
  const baseRaw=raw.split(/[-_]/)[0];
  const n=normalize(raw).replace(/\s+/g,'');
  const base=normalize(baseRaw).replace(/\s+/g,'');
  return LANG[raw] || LANG[n] || LANG[baseRaw] || LANG[base] || (base.length===2 ? base : null);
}
function langMatches(bookLang,candidateLangs=[]){
  const two=lang2(bookLang); if(!two) return false;
  const wanted=new Set([two,OL_LANG[two]].filter(Boolean));
  return candidateLangs.some(x=>wanted.has(normalize(x)) || lang2(x)===two);
}

function authorSimilarity(bookAuthor, candidateAuthors) {
  const ba=normalize(bookAuthor||'');
  if(!ba || !candidateAuthors?.length) return 0;
  const authors=candidateAuthors.map(normalize).filter(Boolean);
  if(authors.some(a=>a===ba || a.includes(ba) || ba.includes(a))) return 1;
  const bookTokens=[...tokens(ba)];
  for(const a of authors){
    const at=[...tokens(a)];
    if(at.length>=2 && at.every(t=>bookTokens.includes(t))) return 0.96;
  }
  return Math.max(0,...authors.map(a=>Math.max(jaccard(ba,a), containment(ba,a)*0.9)));
}

export function scoreCandidate(book, doc) {
  if (!doc?.cover_i && !doc?.cover_olid && !doc?.cover_isbn && !doc?.cover_url) return 0;
  const bt=normalize(book.title), dt=normalize(doc.title || '');
  const jac=jaccard(bt,dt), contain=containment(bt,dt);
  let score = bt && bt===dt ? 0.68 : Math.max(0.52*jac, 0.48*contain);
  // Edition catalogues often reorder a series name and translated volume title,
  // e.g. "Nevernight. I grandi giochi" vs "I grandi giochi. Nevernight".
  // If the complete token sets are identical, the title is effectively exact
  // even though word order/punctuation differ. This is safe enough to clear the
  // normal threshold without requiring author metadata on the edition record.
  const btokens=tokens(bt), dtokens=tokens(dt);
  if(jac===1 && btokens.size===dtokens.size && btokens.size>=3) score=Math.max(score,0.76);
  else if (contain >= 0.95 && jac >= 0.72) score = Math.max(score, 0.58);
  const authorScore=authorSimilarity(book.authors,doc.author_name||doc.authors||[]);
  if(authorScore>=0.92) score += 0.28;
  else score += 0.18*authorScore;
  if(book.language && Array.isArray(doc.language) && langMatches(book.language,doc.language)) score+=0.06;
  else if(book.language && doc.language && lang2(book.language)===lang2(doc.language)) score+=0.06;
  return Math.min(1,score);
}

function candidateDocs(data) {
  const out=[];
  for(const work of data?.docs||[]){
    if(work.cover_i) out.push(work);
    const editions=work?.editions?.docs;
    if(Array.isArray(editions)) for(const edition of editions){
      const cover_i=edition.cover_i || work.cover_i;
      const cover_olid=String(edition.key||'').replace(/^\/books\//,'') || null;
      if(!cover_i && !cover_olid) continue;
      out.push({
        ...work,
        title:edition.title || work.title,
        cover_i,
        language:edition.language || work.language,
        edition_key:edition.key,
        cover_olid,
      });
    }
  }
  return out;
}

function simplifiedTitle(title='') {
  return String(title)
    .replace(/\s*[\[(].*?[\])]\s*$/,'')
    .replace(/\s*[:–—-]\s+[^:–—-]{3,}$/,'')
    .trim();
}

function titleVariants(title='') {
  const raw=String(title||'').trim();
  const out=[];
  const push=v=>{v=String(v||'').trim(); if(v && !out.some(x=>normalize(x)===normalize(v))) out.push(v);};
  push(raw);
  push(simplifiedTitle(raw));
  // Italian publishers often prefix the translated volume title with the series,
  // e.g. "Nevernight. I grandi giochi" while catalogues store "I grandi giochi".
  const dot=raw.match(/^.{2,32}\.\s+(.{3,})$/);
  if(dot) { push(dot[1]); push(simplifiedTitle(dot[1])); }
  const colon=raw.match(/^.{2,32}:\s+(.{3,})$/);
  if(colon) push(colon[1]);
  return out.slice(0,4);
}

function quoteSolr(value=''){ return `"${String(value).replace(/["\\]/g,' ').replace(/\s+/g,' ').trim()}"`; }
function openLibraryStrategies(book){
  const author=String(book.authors||'').trim();
  const out=[];
  const push=(name,q)=>{ if(q && !out.some(x=>x.q===q)) out.push({name,q}); };
  for(const [i,title] of titleVariants(book.title).entries()) {
    const label=i===0?'edition-title':`title-variant-${i}`;
    if(author) push(`${label}-author`, `${quoteSolr(title)} author:${quoteSolr(author)}`);
    push(label, quoteSolr(title));
  }
  const raw=String(book.title||'').trim();
  if(raw&&author) push('relaxed-title-author', `${raw} author:${quoteSolr(author)}`);
  return out.slice(0,8);
}

async function fetchWithRetry(url, options, fetchImpl, { attempts=NETWORK_RETRIES, label='request', timeoutMs=7000 }={}) {
  let lastError;
  for(let attempt=0; attempt<attempts; attempt++){
    try {
      const resp=await fetchImpl(url,{...options,signal:AbortSignal.timeout(timeoutMs)});
      if(resp.ok || ![408,425,429,500,502,503,504].includes(resp.status)) return resp;
      lastError=Object.assign(new Error(`${label} returned ${resp.status}`),{status:resp.status});
    } catch(e) {
      lastError=e;
      if(e?.name==='AbortError' || e?.name==='TimeoutError') lastError=e;
    }
    if(attempt<attempts-1) await sleep(180 * (attempt+1));
  }
  throw lastError || new Error(`${label} failed`);
}

async function searchOpenLibrary(book, strategy, fetchImpl) {
  const params=new URLSearchParams({
    q:strategy.q,
    fields:'key,title,author_name,cover_i,language,first_publish_year,editions,editions.key,editions.title,editions.cover_i,editions.language',
    limit:'20'
  });
  const preferred=lang2(book.language);
  if(preferred) params.set('lang',preferred);
  const searchUrl=`https://openlibrary.org/search.json?${params}`;
  const resp=await fetchWithRetry(searchUrl,{headers:{'User-Agent':`kovi/${VERSION} (+self-hosted-reader-dashboard)`}},fetchImpl,{label:'Open Library search',timeoutMs:6500});
  if(!resp.ok) throw new Error(`Open Library search returned ${resp.status}`);
  return { data:await resp.json(), searchUrl };
}

function googleStrategies(book){
  const author=String(book.authors||'').trim();
  const out=[];
  const push=(name,q)=>{if(q&&!out.some(x=>x.q===q))out.push({name,q});};
  if(book.isbn) push('google-isbn',`isbn:${book.isbn}`);
  for(const [i,title] of titleVariants(book.title).entries()) {
    const label=i===0?'google-title':`google-title-variant-${i}`;
    if(author) push(`${label}-author`, `intitle:${quoteSolr(title)} inauthor:${quoteSolr(author)}`);
    push(label, `intitle:${quoteSolr(title)}`);
  }
  return out.slice(0,8);
}

function googleCandidates(data){
  const out=[];
  for(const item of data?.items||[]){
    const v=item?.volumeInfo||{};
    const identifiers=Array.isArray(v.industryIdentifiers)?v.industryIdentifiers:[];
    const isbn13=identifiers.find(x=>x?.type==='ISBN_13')?.identifier;
    const isbn10=identifiers.find(x=>x?.type==='ISBN_10')?.identifier;
    const isbn=String(isbn13||isbn10||'').replace(/[^0-9Xx]/g,'');
    const imageLinks=v.imageLinks||{};
    const coverUrl=imageLinks.extraLarge||imageLinks.large||imageLinks.medium||imageLinks.small||imageLinks.thumbnail||imageLinks.smallThumbnail||null;
    if(!isbn && !coverUrl) continue;
    out.push({
      title:v.title||'',
      author_name:Array.isArray(v.authors)?v.authors:[],
      language:v.language||null,
      cover_isbn:isbn||null,
      cover_url:coverUrl,
      google_id:item.id,
    });
  }
  return out;
}

async function searchGoogleBooks(book,strategy,fetchImpl,apiKey){
  const params=new URLSearchParams({q:strategy.q,maxResults:'20',printType:'books',projection:'lite'});
  if(apiKey) params.set('key',apiKey);
  const preferred=lang2(book.language); if(preferred) params.set('langRestrict',preferred);
  const url=`https://www.googleapis.com/books/v1/volumes?${params}`;
  const resp=await fetchWithRetry(url,{headers:{'User-Agent':`kovi/${VERSION}`}},fetchImpl,{label:'Google Books search',timeoutMs:6500});
  if(!resp.ok) throw new Error(`Google Books search returned ${resp.status}`);
  return {data:await resp.json(),searchUrl:url};
}

export function detectImageType(buf){
  if(buf.length>3 && buf[0]===0xff&&buf[1]===0xd8&&buf[2]===0xff) return {ext:'jpg',mime:'image/jpeg'};
  if(buf.length>8 && buf.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return {ext:'png',mime:'image/png'};
  if(buf.length>12 && buf.toString('ascii',0,4)==='RIFF' && buf.toString('ascii',8,12)==='WEBP') return {ext:'webp',mime:'image/webp'};
  if(buf.length>6 && (buf.toString('ascii',0,6)==='GIF87a' || buf.toString('ascii',0,6)==='GIF89a')) return {ext:'gif',mime:'image/gif'};
  return null;
}

function googleHostAllowed(url) {
  try {
    const host=new URL(url).hostname.toLowerCase();
    return host==='books.google.com' || host==='books.googleapis.com' || host.endsWith('.googleusercontent.com');
  } catch { return false; }
}

async function fetchValidatedImage(url, provider, fetchImpl) {
  const target=provider==='googlebooks' ? String(url).replace(/^http:/,'https:') : String(url);
  if(provider==='googlebooks' && !googleHostAllowed(target)) throw new Error('Google Books returned an unexpected cover host');
  const img=await fetchWithRetry(target,{headers:{'User-Agent':`kovi/${VERSION}`},redirect:'follow'},fetchImpl,{label:`${provider} cover fetch`,timeoutMs:8000});
  if(!img.ok) {
    const err=new Error(`${provider} cover fetch returned ${img.status}`);
    err.status=img.status;
    throw err;
  }
  if(provider==='googlebooks' && img.url && !googleHostAllowed(img.url)) throw new Error('Google Books cover redirected to an unexpected host');
  const len=Number(img.headers.get('content-length')||0);
  if(len>5_000_000) throw new Error('Cover image too large');
  const buf=Buffer.from(await img.arrayBuffer());
  if(buf.length>5_000_000) throw new Error('Cover image too large');
  if(provider==='googlebooks'){
    const md5=createHash('md5').update(buf).digest('hex');
    if(GOOGLE_DUMMY_MD5.has(md5)) throw new Error('Google Books returned a known dummy cover image');
  }
  const type=detectImageType(buf);
  if(!type){
    const err=new Error('Cover provider returned unsupported image data');
    err.coverMeta={contentType:cleanText(img.headers.get('content-type'),100),bytes:buf.length};
    throw err;
  }
  return {buf,type,url:target};
}

function cacheBuffer(book, dataDir, buf, type, suffix='') {
  const coversDir=path.join(dataDir,'covers'); fs.mkdirSync(coversDir,{recursive:true});
  // Cover paths are immutable so cover history can safely point at an older image.
  // The random suffix also eliminates browser-cache ambiguity after replacements.
  const filename=`${book.id}${suffix}-${Date.now().toString(36)}-${randomId(4)}.${type.ext}`;
  const finalPath=path.join(coversDir,filename);
  const tempPath=path.join(coversDir,`.${filename}.${randomId(6)}.tmp`);
  fs.writeFileSync(tempPath,buf,{mode:0o644,flag:'wx'});
  fs.renameSync(tempPath,finalPath);
  return `/covers/${filename}`;
}

function openLibraryCandidateUrls(candidate){
  const urls=[];
  const push=u=>{if(u&&!urls.includes(u))urls.push(u);};
  if(candidate.cover_i){
    push(`https://covers.openlibrary.org/b/id/${Number(candidate.cover_i)}-L.jpg?default=false`);
    push(`https://covers.openlibrary.org/b/id/${Number(candidate.cover_i)}-M.jpg?default=false`);
  }
  if(candidate.cover_olid) push(`https://covers.openlibrary.org/b/olid/${encodeURIComponent(candidate.cover_olid)}-L.jpg?default=false`);
  if(candidate.cover_isbn) push(`https://covers.openlibrary.org/b/isbn/${encodeURIComponent(candidate.cover_isbn)}-L.jpg?default=false`);
  return urls;
}

async function tryCandidateDownload(book,candidate,provider,dataDir,fetchImpl,{strategy='unknown'}={}){
  const attempts=[];
  const urls=[];
  if(provider==='openlibrary') for(const url of openLibraryCandidateUrls(candidate)) urls.push({url,fetchProvider:'openlibrary',source:'openlibrary'});
  if(provider==='googlebooks') {
    // Prefer ISBN through Open Library when Google found the bibliographic record,
    // but use Google's own returned cover as a validated/cacheable fallback.
    for(const url of openLibraryCandidateUrls(candidate)) urls.push({url,fetchProvider:'openlibrary',source:'openlibrary-via-googlebooks'});
    if(candidate.cover_url) urls.push({url:candidate.cover_url,fetchProvider:'googlebooks',source:'googlebooks'});
    for(const url of candidate.cover_urls||[]) if(url) urls.push({url,fetchProvider:'googlebooks',source:'googlebooks-via-calibre-id'});
  }
  for(const item of urls){
    try{
      const {buf,type}=await fetchValidatedImage(item.url,item.fetchProvider,fetchImpl);
      return {ok:true,path:cacheBuffer(book,dataDir,buf,type),source:item.source};
    }catch(e){
      const failure={provider:item.fetchProvider,strategy,error:e.message,status:e.status||null,...(e.coverMeta||{})};
      attempts.push(failure);
      warn('cover.download.rejected','Rejected a cover image and will continue with other candidates.',{bookId:book.id,title:book.title,...failure});
    }
  }
  return {ok:false,attempts};
}

function calibreMetadataDocs(calibre){
  const out=[];
  for(const item of calibre?.metadataCandidates||[]){
    const ids=item?.identifiers||{};
    const google=String(ids.google||ids.Google||'').trim();
    const isbn=String(ids.isbn||ids.ISBN||'').replace(/[^0-9Xx]/g,'');
    const cover_urls=[];
    if(google){
      const id=encodeURIComponent(google);
      // This is the same stable Google Books cover endpoint used by Calibre's
      // Google metadata source. Try both zoom levels because some records only
      // expose one of them.
      cover_urls.push(`https://books.google.com/books?id=${id}&printsec=frontcover&img=1&zoom=0`);
      cover_urls.push(`https://books.google.com/books?id=${id}&printsec=frontcover&img=1&zoom=1`);
    }
    if(!google && !isbn) continue;
    out.push({
      title:item.title||'',
      author_name:Array.isArray(item.authors)?item.authors:[],
      language:Array.isArray(item.languages)?item.languages:item.languages||null,
      cover_isbn:isbn||null,
      google_id:google||null,
      cover_urls,
    });
  }
  return out;
}

async function tryDirectIsbn(book,dataDir,fetchImpl){
  if(!book.isbn) return null;
  const candidate={title:book.title,author_name:[book.authors].filter(Boolean),language:book.language,cover_isbn:book.isbn};
  const dl=await tryCandidateDownload(book,candidate,'openlibrary',dataDir,fetchImpl,{strategy:'isbn-direct'});
  const attempt={provider:'openlibrary',strategy:'isbn-direct',isbn:book.isbn,candidates:1,bestScore:1,downloaded:dl.ok};
  info('cover.lookup.attempt','Cover lookup strategy completed.',{bookId:book.id,title:book.title,...attempt});
  return dl.ok ? {status:'matched',path:dl.path,source:dl.source,score:1,matchedTitle:book.title,strategy:'isbn-direct',trace:[attempt]} : {status:'none',score:1,trace:[attempt,...dl.attempts]};
}

async function tryGoogleIsbn(book,dataDir,fetchImpl,apiKey){
  if(!book.isbn) return null;
  try {
    const strategy={name:'google-isbn',q:`isbn:${book.isbn}`};
    const {data}=await searchGoogleBooks(book,strategy,fetchImpl,apiKey);
    const docs=googleCandidates(data);
    const ranked=docs.map(d=>({doc:d,score:scoreCandidate(book,d)})).sort((a,b)=>b.score-a.score);
    const attempt={provider:'googlebooks',strategy:'google-isbn',isbn:book.isbn,results:Number(data?.totalItems||0),candidates:docs.length,bestScore:ranked[0]?.score||0};
    for(const candidate of ranked.slice(0,3)){
      // ISBN queries are deterministic enough to accept a returned cover even if
      // translated title metadata differs, while still preferring the best rank.
      const dl=await tryCandidateDownload(book,candidate.doc,'googlebooks',dataDir,fetchImpl,{strategy:'google-isbn'});
      if(dl.ok) return {status:'matched',path:dl.path,source:dl.source,score:Math.max(candidate.score,0.95),matchedTitle:candidate.doc.title||book.title,strategy:'google-isbn',trace:[attempt]};
      attempt.downloadFailures=(attempt.downloadFailures||0)+dl.attempts.length;
    }
    return {status:'none',score:attempt.bestScore,trace:[attempt]};
  } catch(e) {
    return {status:'none',score:0,trace:[{provider:'googlebooks',strategy:'google-isbn',error:e.message,status:e.status||null}]};
  }
}

async function searchNativePair(book, olStrategy, googleStrategy, fetchImpl, apiKey){
  const [ol,google]=await Promise.allSettled([
    olStrategy ? searchOpenLibrary(book,olStrategy,fetchImpl) : Promise.resolve(null),
    googleStrategy ? searchGoogleBooks(book,googleStrategy,fetchImpl,apiKey) : Promise.resolve(null),
  ]);
  return {ol,google};
}

export async function resolveCover(book, { dataDir, fetchImpl = fetch, googleBooksApiKey = process.env.GOOGLE_BOOKS_API_KEY || '', calibreResolver = fetchCoverWithCalibre } = {}) {
  const trace=[];
  let bestScore=0;

  // Stable identifiers are the quickest and most reliable path. Open Library's
  // ISBN cover endpoint is a single request; if it misses, Google Books gets a
  // deterministic ISBN query before we fall back to fuzzy title matching.
  if(book.isbn){
    const direct=await tryDirectIsbn(book,dataDir,fetchImpl);
    if(direct?.status==='matched') return direct;
    if(direct) { trace.push(...direct.trace); bestScore=Math.max(bestScore,direct.score||0); }
    const googleIsbn=await tryGoogleIsbn(book,dataDir,fetchImpl,googleBooksApiKey);
    if(googleIsbn?.status==='matched') { googleIsbn.trace=[...trace,...(googleIsbn.trace||[])]; return googleIsbn; }
    if(googleIsbn) { trace.push(...(googleIsbn.trace||[])); bestScore=Math.max(bestScore,googleIsbn.score||0); }
  }

  const olStrategies=openLibraryStrategies(book);
  const googlePlans=googleStrategies({...book,isbn:null}).filter(x=>x.name!=='google-isbn');
  const maxNative=Math.max(olStrategies.length,googlePlans.length);

  // Query the two lightweight catalogues together. This removes the old
  // Open-Library-first waterfall (and its per-query sleeps), so a Google Books
  // hit can arrive without waiting through every Open Library title variant.
  for(let i=0;i<maxNative;i++){
    const olStrategy=olStrategies[i]||null;
    const googleStrategy=googlePlans[i]||null;
    const pair=await searchNativePair(book,olStrategy,googleStrategy,fetchImpl,googleBooksApiKey);
    const groups=[];

    if(olStrategy){
      if(pair.ol.status==='fulfilled'){
        const data=pair.ol.value?.data;
        const docs=candidateDocs(data);
        const ranked=docs.map(d=>({doc:d,score:scoreCandidate(book,d)})).sort((a,b)=>b.score-a.score);
        const top=ranked[0]; bestScore=Math.max(bestScore,top?.score||0);
        const attempt={provider:'openlibrary',strategy:olStrategy.name,results:Number(data?.numFound||data?.docs?.length||0),candidates:docs.length,bestScore:top?.score||0,matchedTitle:top?.doc?.title||null};
        trace.push(attempt); groups.push({provider:'openlibrary',strategy:olStrategy.name,ranked});
        info('cover.lookup.attempt','Cover search strategy completed.',{bookId:book.id,title:book.title,...attempt,bestScore:Number((attempt.bestScore||0).toFixed(3))});
      } else trace.push({provider:'openlibrary',strategy:olStrategy.name,error:pair.ol.reason?.message||'request failed',status:pair.ol.reason?.status||null});
    }
    if(googleStrategy){
      if(pair.google.status==='fulfilled'){
        const data=pair.google.value?.data;
        const docs=googleCandidates(data);
        const ranked=docs.map(d=>({doc:d,score:scoreCandidate(book,d)})).sort((a,b)=>b.score-a.score);
        const top=ranked[0]; bestScore=Math.max(bestScore,top?.score||0);
        const attempt={provider:'googlebooks',strategy:googleStrategy.name,results:Number(data?.totalItems||0),candidates:docs.length,bestScore:top?.score||0,matchedTitle:top?.doc?.title||null};
        trace.push(attempt); groups.push({provider:'googlebooks',strategy:googleStrategy.name,ranked});
        info('cover.lookup.attempt','Cover search strategy completed.',{bookId:book.id,title:book.title,...attempt,bestScore:Number((attempt.bestScore||0).toFixed(3))});
      } else trace.push({provider:'googlebooks',strategy:googleStrategy.name,error:pair.google.reason?.message||'request failed',status:pair.google.reason?.status||null});
    }

    // Try the strongest candidates across both providers first. This avoids
    // wasting downloads on a merely acceptable result when another catalogue
    // already returned an exact title/author match in the same round.
    const candidates=groups.flatMap(g=>g.ranked.slice(0,4).map(x=>({...x,provider:g.provider,strategy:g.strategy})))
      .filter(x=>x.score>=MATCH_THRESHOLD).sort((a,b)=>b.score-a.score);
    for(const candidate of candidates.slice(0,6)){
      const dl=await tryCandidateDownload(book,candidate.doc,candidate.provider,dataDir,fetchImpl,{strategy:candidate.strategy});
      if(dl.ok) return {status:'matched',path:dl.path,source:dl.source,score:candidate.score,matchedTitle:candidate.doc.title,strategy:candidate.strategy,trace};
      trace.push(...dl.attempts);
    }
  }

  // Heavyweight federation is deliberately last. It is excellent for difficult
  // books, but spawning Calibre is much slower than the native HTTP catalogues.
  if (calibreResolver && (fetchImpl === fetch || calibreResolver !== fetchCoverWithCalibre)) {
    const calibre = await calibreResolver(book,{dataDir});
    trace.push({provider:'calibre',strategy:'metadata-source-federation',status:calibre?.status||'unknown'});
    if(calibre?.status==='matched' && calibre.buffer){
      const type=detectImageType(calibre.buffer);
      if(type && calibre.buffer.length<=5_000_000){
        const coverPath=cacheBuffer(book,dataDir,calibre.buffer,type,'-calibre');
        info('cover.calibre.matched','Accepted Calibre-selected cover.',{bookId:book.id,title:book.title,bytes:calibre.buffer.length,mime:type.mime,calibreStrategy:calibre.strategy||undefined});
        return {status:'matched',path:coverPath,source:'calibre',score:1,matchedTitle:book.title,strategy:`calibre:${calibre.strategy||'metadata-sources'}`,trace};
      }
      warn('cover.calibre.rejected','Calibre returned an unsupported or oversized image; continuing with identifier recovery.',{bookId:book.id,title:book.title,bytes:calibre.buffer.length});
    }

    const metaDocs=calibreMetadataDocs(calibre);
    const ranked=metaDocs.map(d=>({doc:d,score:scoreCandidate(book,{...d,cover_url:d.cover_urls?.[0]||null})})).sort((a,b)=>b.score-a.score);
    if(ranked.length){
      const top=ranked[0];
      const attempt={provider:'calibre-identifiers',strategy:'google-id-or-isbn',candidates:ranked.length,bestScore:top.score,matchedTitle:top.doc.title||null,googleId:Boolean(top.doc.google_id),isbn:Boolean(top.doc.cover_isbn)};
      trace.push(attempt);
      for(const rankedCandidate of ranked.slice(0,5)){
        if(rankedCandidate.score<MATCH_THRESHOLD) break;
        const dl=await tryCandidateDownload(book,rankedCandidate.doc,'googlebooks',dataDir,fetchImpl,{strategy:'calibre-identifiers'});
        if(dl.ok) return {status:'matched',path:dl.path,source:dl.source,score:rankedCandidate.score,matchedTitle:rankedCandidate.doc.title,strategy:'calibre-identifiers',trace};
        trace.push(...dl.attempts);
      }
    }
  }

  return { status:'none', score:bestScore, trace };
}

function coverStatusForSource(source, fallback='matched') {
  return source==='manual-upload' ? 'manual' : fallback;
}

function recordCoverSelection(db, book, {path:coverPath,source,status='matched',strategy=null,score=null,matchedTitle=null}={}) {
  if(!coverPath) throw new Error('A selected cover must have a local path.');
  const ts=nowIso();
  // openAppDb backfills old current covers, but keep this defensive for tests and
  // databases opened before the migration completed.
  if(book.cover_path && !db.prepare(`SELECT 1 ok FROM book_covers WHERE book_id=? AND path=?`).get(book.id,book.cover_path)){
    db.prepare(`INSERT INTO book_covers(id,book_id,path,source,strategy,score,matched_title,cover_status,selected,created_at) VALUES(?,?,?,?,NULL,NULL,NULL,?,1,?)`)
      .run(randomId(16),book.id,book.cover_path,book.cover_source,book.cover_status||coverStatusForSource(book.cover_source),book.cover_checked_at||book.updated_at||ts);
  }
  db.prepare(`UPDATE book_covers SET selected=0 WHERE book_id=?`).run(book.id);
  let existing=db.prepare(`SELECT id FROM book_covers WHERE book_id=? AND path=?`).get(book.id,coverPath);
  let id=existing?.id;
  if(id){
    db.prepare(`UPDATE book_covers SET source=?,strategy=?,score=?,matched_title=?,cover_status=?,selected=1 WHERE id=?`)
      .run(source||null,strategy||null,score==null?null:Number(score),matchedTitle||null,status,id);
  }else{
    id=randomId(16);
    db.prepare(`INSERT INTO book_covers(id,book_id,path,source,strategy,score,matched_title,cover_status,selected,created_at) VALUES(?,?,?,?,?,?,?,?,1,?)`)
      .run(id,book.id,coverPath,source||null,strategy||null,score==null?null:Number(score),matchedTitle||null,status,ts);
  }
  db.prepare(`UPDATE books SET cover_status=?,cover_path=?,cover_source=?,cover_retry_mode=NULL,cover_checked_at=?,updated_at=? WHERE id=?`)
    .run(status,coverPath,source||null,ts,ts,book.id);
  return id;
}

export function getBookCoverState(db, bookId) {
  const book=db.prepare(`SELECT id,title,cover_status,cover_path,cover_source,cover_checked_at FROM books WHERE id=?`).get(bookId);
  if(!book) return null;
  const history=db.prepare(`SELECT id,path,source,strategy,score,matched_title,cover_status,selected,created_at FROM book_covers WHERE book_id=? ORDER BY selected DESC,created_at DESC LIMIT 30`).all(bookId);
  const candidates=db.prepare(`SELECT id,path,source,strategy,score,title,authors,created_at FROM cover_candidates WHERE book_id=? ORDER BY score DESC,created_at DESC LIMIT 12`).all(bookId);
  const job=db.prepare(`SELECT state,reason,force_online,attempts,requested_at,started_at,finished_at,last_error,result_status,result_source FROM cover_jobs WHERE book_id=?`).get(bookId)||null;
  return {book,history,candidates,job};
}

export function saveEmbeddedCover(db, dataDir, sourceMd5, buffer) {
  if(!Buffer.isBuffer(buffer)) buffer=Buffer.from(buffer||[]);
  if(buffer.length<32) throw Object.assign(new Error('Embedded cover is empty or too small.'),{status:400});
  if(buffer.length>4_000_000) throw Object.assign(new Error('Embedded cover exceeds the 4 MB limit.'),{status:413});
  const type=detectImageType(buffer);
  if(!type) throw Object.assign(new Error('Embedded cover is not a supported JPEG, PNG, WebP, or GIF image.'),{status:400});
  const book=db.prepare(`SELECT id,title,cover_status,cover_path,cover_source,cover_checked_at,updated_at FROM books WHERE source_md5=?`).get(sourceMd5);
  if(!book) throw Object.assign(new Error('Book for embedded cover was not found.'),{status:404});
  if(book.cover_status==='manual' || book.cover_source==='manual-upload') return {ignored:true,reason:'manual-cover',book};
  const coverPath=cacheBuffer(book,dataDir,buffer,type,'-koreader');
  recordCoverSelection(db,book,{path:coverPath,source:'koreader-embedded',status:'matched',strategy:'koreader-embedded'});
  return {ignored:false,bookId:book.id,title:book.title,path:coverPath,type:type.mime,bytes:buffer.length};
}

export function saveManualCover(db, dataDir, bookId, buffer) {
  if(!Buffer.isBuffer(buffer)) buffer=Buffer.from(buffer||[]);
  if(buffer.length<32) throw Object.assign(new Error('Cover image is empty or too small.'),{status:400});
  if(buffer.length>4_000_000) throw Object.assign(new Error('Cover image exceeds the 4 MB limit.'),{status:413});
  const type=detectImageType(buffer);
  if(!type) throw Object.assign(new Error('Cover image must be a JPEG, PNG, WebP, or GIF image.'),{status:400});
  const book=db.prepare(`SELECT id,title,cover_status,cover_path,cover_source,cover_checked_at,updated_at FROM books WHERE id=?`).get(bookId);
  if(!book) throw Object.assign(new Error('Book not found.'),{status:404});
  const coverPath=cacheBuffer(book,dataDir,buffer,type,'-manual');
  recordCoverSelection(db,book,{path:coverPath,source:'manual-upload',status:'manual',strategy:'manual-upload'});
  // A later manual choice supersedes any queued/running online request.
  db.prepare(`DELETE FROM cover_jobs WHERE book_id=?`).run(book.id);
  return {bookId:book.id,title:book.title,path:coverPath,type:type.mime,bytes:buffer.length};
}

function queueCoverJob(db,bookId,{reason='automatic',forceOnline=false}={}){
  const ts=nowIso();
  db.prepare(`INSERT INTO cover_jobs(book_id,state,reason,force_online,attempts,requested_at,started_at,finished_at,last_error,result_status,result_source)
    VALUES(?,'queued',?,?,0,?,NULL,NULL,NULL,NULL,NULL)
    ON CONFLICT(book_id) DO UPDATE SET state='queued',reason=excluded.reason,force_online=excluded.force_online,requested_at=excluded.requested_at,started_at=NULL,finished_at=NULL,last_error=NULL,result_status=NULL,result_source=NULL`)
    .run(bookId,reason,forceOnline?1:0,ts);
}

export function queueOnlineCoverRetry(db, dataDir, bookId, {reason='user-retry-book',delayMs=50}={}) {
  const book=db.prepare(`SELECT id,title FROM books WHERE id=?`).get(bookId);
  if(!book) return null;
  // Do not mutate a perfectly good local/current cover while lookup is running.
  db.prepare(`UPDATE books SET cover_retry_mode=NULL WHERE id=?`).run(book.id);
  queueCoverJob(db,book.id,{reason,forceOnline:true});
  scheduleCoverWork(db,dataDir,[],{reason,delayMs});
  return book;
}

export function selectCoverHistory(db,bookId,coverId){
  const book=db.prepare(`SELECT id,title,cover_status,cover_path,cover_source,cover_checked_at,updated_at FROM books WHERE id=?`).get(bookId);
  if(!book) return null;
  const cover=db.prepare(`SELECT * FROM book_covers WHERE id=? AND book_id=?`).get(coverId,bookId);
  if(!cover) return false;
  recordCoverSelection(db,book,{path:cover.path,source:cover.source,status:cover.cover_status||coverStatusForSource(cover.source),strategy:cover.strategy,score:cover.score,matchedTitle:cover.matched_title});
  db.prepare(`DELETE FROM cover_jobs WHERE book_id=?`).run(bookId);
  return true;
}

export function selectCoverCandidate(db,bookId,candidateId){
  const book=db.prepare(`SELECT id,title,cover_status,cover_path,cover_source,cover_checked_at,updated_at FROM books WHERE id=?`).get(bookId);
  if(!book) return null;
  const candidate=db.prepare(`SELECT * FROM cover_candidates WHERE id=? AND book_id=?`).get(candidateId,bookId);
  if(!candidate) return false;
  recordCoverSelection(db,book,{path:candidate.path,source:candidate.source,status:'matched',strategy:candidate.strategy,score:candidate.score,matchedTitle:candidate.title});
  db.prepare(`DELETE FROM cover_jobs WHERE book_id=?`).run(bookId);
  return true;
}

export async function findCoverCandidates(db,dataDir,bookId,{fetchImpl=fetch,googleBooksApiKey=process.env.GOOGLE_BOOKS_API_KEY||'',limit=6}={}){
  const book=db.prepare(`SELECT id,title,authors,language,isbn,identifiers FROM books WHERE id=?`).get(bookId);
  if(!book) return null;
  // Candidate images are local cached previews. Remove old, unselected previews
  // for this book before building the next set.
  const old=db.prepare(`SELECT path FROM cover_candidates WHERE book_id=?`).all(bookId);
  db.prepare(`DELETE FROM cover_candidates WHERE book_id=?`).run(bookId);
  for(const row of old){
    if(db.prepare(`SELECT 1 ok FROM book_covers WHERE path=?`).get(row.path)) continue;
    const local=path.join(dataDir,String(row.path||'').replace(/^\/+/,''));
    try{fs.rmSync(local,{force:true})}catch{}
  }

  const pool=[];
  const add=(provider,strategy,docs)=>{
    for(const doc of docs||[]){
      const score=scoreCandidate(book,doc);
      if(score<0.5) continue;
      const key=`${provider}|${doc.cover_i||doc.cover_olid||doc.cover_isbn||doc.cover_url||doc.google_id||''}|${normalize(doc.title||'')}`;
      if(pool.some(x=>x.key===key)) continue;
      pool.push({key,provider,strategy,doc,score});
    }
  };
  if(book.isbn) add('openlibrary','isbn-direct',[{title:book.title,author_name:[book.authors].filter(Boolean),language:book.language,cover_isbn:book.isbn}]);
  const olPlans=openLibraryStrategies(book).slice(0,2),googlePlans=googleStrategies(book).slice(0,2);
  for(let i=0;i<Math.max(olPlans.length,googlePlans.length);i++){
    const ol=olPlans[i]||null,google=googlePlans[i]||null;
    const pair=await searchNativePair(book,ol,google,fetchImpl,googleBooksApiKey);
    if(ol && pair.ol.status==='fulfilled') add('openlibrary',ol.name,candidateDocs(pair.ol.value?.data));
    if(google && pair.google.status==='fulfilled') add('googlebooks',google.name,googleCandidates(pair.google.value?.data));
  }
  pool.sort((a,b)=>b.score-a.score);
  const rows=[];
  for(const item of pool.slice(0,Math.max(limit*3,12))){
    if(rows.length>=limit) break;
    const dl=await tryCandidateDownload(book,item.doc,item.provider,dataDir,fetchImpl,{strategy:item.strategy});
    if(!dl.ok) continue;
    const id=randomId(16),createdAt=nowIso();
    const authors=(item.doc.author_name||item.doc.authors||[]); const authorText=Array.isArray(authors)?authors.join(', '):String(authors||'');
    db.prepare(`INSERT INTO cover_candidates(id,book_id,path,source,strategy,score,title,authors,created_at) VALUES(?,?,?,?,?,?,?,?,?)`)
      .run(id,book.id,dl.path,dl.source||item.provider,item.strategy,item.score,cleanText(item.doc.title,500)||book.title,cleanText(authorText,500),createdAt);
    rows.push({id,path:dl.path,source:dl.source||item.provider,strategy:item.strategy,score:item.score,title:item.doc.title||book.title,authors:authorText,created_at:createdAt});
  }
  return rows;
}

let coverWorkerRunning=false;
let coverWorkerTimer=null;
let coverRecoveryDone=false;

export async function processCoverBook(db,dataDir,book,{resolver=resolveCover,forceOnline=false}={}){
  const before=db.prepare(`SELECT cover_status,cover_path,cover_source,cover_retry_mode,cover_checked_at,updated_at FROM books WHERE id=?`).get(book.id);
  forceOnline=Boolean(forceOnline || before?.cover_retry_mode==='online');
  const localPriority=before?.cover_status==='manual' || before?.cover_source==='koreader-embedded' || before?.cover_source==='manual-upload';
  if(localPriority && !forceOnline){
    const restored=coverStatusForSource(before.cover_source);
    if(before.cover_status==='pending') db.prepare(`UPDATE books SET cover_status=?,cover_retry_mode=NULL,updated_at=? WHERE id=?`).run(restored,nowIso(),book.id);
    info('cover.lookup.local-preserved','Skipped online lookup because a higher-priority local cover is already present.',{bookId:book.id,title:book.title,coverSource:before.cover_source});
    return {status:'preserved',source:before.cover_source};
  }
  info('cover.lookup.start','Looking up cover.',{bookId:book.id,title:book.title,authors:book.authors,language:book.language,isbn:book.isbn||undefined,googleBooks:true,forceOnline});
  try{
    const r=await resolver(book,{dataDir});
    const current=db.prepare(`SELECT cover_status,cover_path,cover_source,cover_checked_at,updated_at FROM books WHERE id=?`).get(book.id);
    const changedDuringLookup=current && (current.cover_path!==before?.cover_path || current.cover_source!==before?.cover_source);
    const currentLocal=current?.cover_status==='manual' || current?.cover_source==='koreader-embedded' || current?.cover_source==='manual-upload';
    if(currentLocal && (changedDuringLookup || !forceOnline)){
      info('cover.lookup.superseded','Online cover result was superseded by a newer/higher-priority local cover.',{bookId:book.id,title:book.title,coverSource:current.cover_source});
      return {status:'superseded',source:current.cover_source};
    }
    if(forceOnline && r.status!=='matched' && current?.cover_path){
      const restored=coverStatusForSource(current.cover_source);
      db.prepare(`UPDATE books SET cover_status=?,cover_retry_mode=NULL,cover_checked_at=?,updated_at=? WHERE id=?`).run(restored,nowIso(),nowIso(),book.id);
      info('cover.lookup.none','No confident online cover match found; keeping the existing cover.',{bookId:book.id,title:book.title,coverSource:current.cover_source,bestScore:Number((r.score||0).toFixed(3)),attempts:r.trace});
      return {status:'none-kept',source:current.cover_source};
    }
    if(r.status==='matched'){
      const fullBook={...book,...current};
      recordCoverSelection(db,fullBook,{path:r.path,source:r.source,status:'matched',strategy:r.strategy,score:r.score,matchedTitle:r.matchedTitle});
      info('cover.lookup.matched','Cover matched and cached.',{bookId:book.id,title:book.title,matchedTitle:r.matchedTitle,score:Number((r.score||0).toFixed(3)),provider:r.source,strategy:r.strategy,attempts:r.trace});
      return {status:'matched',source:r.source};
    }
    db.prepare(`UPDATE books SET cover_status='none',cover_path=NULL,cover_source=NULL,cover_retry_mode=NULL,cover_checked_at=?,updated_at=? WHERE id=?`).run(nowIso(),nowIso(),book.id);
    info('cover.lookup.none','No confident cover match found.',{bookId:book.id,title:book.title,bestScore:Number((r.score||0).toFixed(3)),attempts:r.trace});
    return {status:'none',source:null};
  }catch(e){
    const current=db.prepare(`SELECT cover_status,cover_path,cover_source FROM books WHERE id=?`).get(book.id);
    if(current?.cover_path) db.prepare(`UPDATE books SET cover_status=?,cover_retry_mode=NULL,cover_checked_at=?,updated_at=? WHERE id=?`).run(coverStatusForSource(current.cover_source),nowIso(),nowIso(),book.id);
    else db.prepare(`UPDATE books SET cover_status='error',cover_retry_mode=NULL,cover_checked_at=?,updated_at=? WHERE id=?`).run(nowIso(),nowIso(),book.id);
    warn('cover.lookup.error','Cover lookup failed.',{bookId:book.id,title:book.title,error:e.message});
    return {status:'error',source:current?.cover_source||null,error:e.message};
  }
}

async function runCoverBatch(db,dataDir){
  const jobs=db.prepare(`SELECT j.book_id,j.reason,j.force_online,b.id,b.title,b.authors,b.language,b.isbn,b.identifiers,b.cover_path,b.cover_source,b.cover_status
    FROM cover_jobs j JOIN books b ON b.id=j.book_id WHERE j.state='queued' ORDER BY j.requested_at LIMIT 100`).all();
  if(!jobs.length) return 0;
  let cursor=0;
  const workers=Array.from({length:Math.min(COVER_WORKER_CONCURRENCY,jobs.length)},async()=>{
    while(cursor<jobs.length){
      const job=jobs[cursor++];
      const claimed=db.prepare(`UPDATE cover_jobs SET state='running',attempts=attempts+1,started_at=?,finished_at=NULL,last_error=NULL WHERE book_id=? AND state='queued'`).run(nowIso(),job.book_id).changes;
      if(!claimed) continue;
      const outcome=await processCoverBook(db,dataDir,job,{forceOnline:Boolean(job.force_online)});
      const state=outcome.status==='error'?'error':'done';
      db.prepare(`UPDATE cover_jobs SET state=?,finished_at=?,last_error=?,result_status=?,result_source=? WHERE book_id=?`)
        .run(state,nowIso(),outcome.error||null,outcome.status||null,outcome.source||null,job.book_id);
    }
  });
  await Promise.all(workers);
  return jobs.length;
}

export function scheduleCoverWork(db, dataDir, ids = [], {reason='automatic',delayMs=50}={}) {
  // Recover interrupted jobs once after a process restart. Do not rewrite a genuinely
  // running job when another import/user action schedules unrelated work.
  if(!coverRecoveryDone){db.prepare(`UPDATE cover_jobs SET state='queued',started_at=NULL WHERE state='running'`).run();coverRecoveryDone=true;}
  const legacy=db.prepare(`SELECT id,cover_path,cover_source,cover_status,cover_retry_mode FROM books WHERE cover_retry_mode='online'`).all();
  for(const row of legacy){
    const restored=row.cover_path ? coverStatusForSource(row.cover_source) : 'pending';
    db.prepare(`UPDATE books SET cover_status=?,cover_retry_mode=NULL WHERE id=?`).run(restored,row.id);
    queueCoverJob(db,row.id,{reason:'legacy-user-retry',forceOnline:true});
  }

  const staleErrors=db.prepare(`SELECT id FROM books WHERE cover_status='error' AND (cover_checked_at IS NULL OR cover_checked_at < datetime('now','-6 hours'))`).all();
  for(const row of staleErrors){db.prepare(`UPDATE books SET cover_status='pending' WHERE id=? AND cover_path IS NULL`).run(row.id);queueCoverJob(db,row.id,{reason:'recover-error'});}
  let explicitlyQueued=0;
  for(const id of ids){
    const row=db.prepare(`SELECT id,cover_path,cover_status FROM books WHERE id=?`).get(id); if(!row) continue;
    if(!row.cover_path) db.prepare(`UPDATE books SET cover_status='pending' WHERE id=?`).run(id);
    queueCoverJob(db,id,{reason}); explicitlyQueued++;
  }
  // Any pending book without a job still deserves one; this is how imported
  // books are recovered automatically on startup.
  const pendingBooks=db.prepare(`SELECT id FROM books WHERE cover_status='pending'`).all();
  for(const row of pendingBooks) if(!db.prepare(`SELECT 1 ok FROM cover_jobs WHERE book_id=? AND state IN ('queued','running')`).get(row.id)) queueCoverJob(db,row.id,{reason:'pending-cover'});
  const pending=Number(db.prepare(`SELECT COUNT(*) n FROM cover_jobs WHERE state='queued'`).get().n);
  if(explicitlyQueued || pending) info('cover.queue','Cover work queued.',{reason,pending,requested:ids.length,delayMs,concurrency:COVER_WORKER_CONCURRENCY});
  if(coverWorkerRunning || !pending) return;
  if(coverWorkerTimer) clearTimeout(coverWorkerTimer);
  coverWorkerTimer=setTimeout(async()=>{
    coverWorkerTimer=null;
    if(coverWorkerRunning) return;
    coverWorkerRunning=true;
    info('cover.worker.start','Cover worker started.',{pending,concurrency:COVER_WORKER_CONCURRENCY});
    let processed=0;
    try{ processed=await runCoverBatch(db,dataDir); }
    finally {
      coverWorkerRunning=false;
      const remaining=Number(db.prepare(`SELECT COUNT(*) n FROM cover_jobs WHERE state='queued'`).get().n);
      info('cover.worker.stop','Cover worker finished a batch.',{processed,remaining});
      if(remaining) scheduleCoverWork(db,dataDir,[],{reason:'continue-batch',delayMs:100});
    }
  },Math.max(0,Number(delayMs)||0));
}

