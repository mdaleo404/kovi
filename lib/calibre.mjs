import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { info, warn } from './logger.mjs';

const DEFAULT_BIN = process.env.CALIBRE_FETCH_BIN || 'fetch-ebook-metadata';
const DEFAULT_DEBUG_BIN = process.env.CALIBRE_DEBUG_BIN || 'calibre-debug';
const DEFAULT_TIMEOUT_MS = 75_000;
const MAX_LOG_CHARS = 4000;

// Machine-readable identification pass. Calibre's fetch-ebook-metadata CLI
// prints useful bibliographic metadata, but its human-readable/verbose output
// is not stable enough to parse. This fixed calibre-debug command asks
// Calibre's own identify pipeline for the best matches and emits only a JSON
// marker that kovi can consume. User-controlled metadata is supplied via
// environment variables and is never interpolated into Python source.
const IDENTIFY_JSON_CODE = [
  'import os, json',
  'from io import BytesIO',
  'from threading import Event',
  'from calibre.ebooks.metadata import string_to_authors',
  'from calibre.ebooks.metadata.sources.base import create_log',
  'from calibre.ebooks.metadata.sources.identify import identify',
  'from calibre.ebooks.metadata.sources.update import patch_plugins',
  'patch_plugins()',
  "title=os.environ.get('KOVI_CALIBRE_TITLE') or None",
  "author=os.environ.get('KOVI_CALIBRE_AUTHORS') or ''",
  'authors=string_to_authors(author) if author else []',
  'identifiers={}',
  "isbn=os.environ.get('KOVI_CALIBRE_ISBN') or ''",
  "identifiers.update({'isbn': isbn}) if isbn else None",
  'buf=BytesIO(); log=create_log(buf)',
  "results=identify(log,Event(),title=title,authors=authors,identifiers=identifiers,timeout=int(os.environ.get('KOVI_CALIBRE_TIMEOUT','45')))",
  "payload=[{'title':getattr(m,'title','') or '', 'authors':list(getattr(m,'authors',[]) or []), 'identifiers':m.get_identifiers() if hasattr(m,'get_identifiers') else {}, 'languages':list(getattr(m,'languages',[]) or [])} for m in results[:5]]",
  "print('KOVI_METADATA_JSON='+json.dumps(payload,ensure_ascii=False,separators=(',',':')))",
].join(';');

// Calibre's fetch-ebook-metadata CLI only reaches the cover phase after the
// identify phase succeeds. Google Images is a cover-only source and is disabled
// by default in Calibre, so hard cases with translated titles can otherwise
// never reach it. This fixed command runs Calibre's own cover downloader in a
// separate calibre-debug process, explicitly enabling Google Images. Metadata
// enters only through environment variables, never interpolated Python/source.
const DIRECT_COVER_CODE = [
  'import os',
  'from io import BytesIO',
  'from calibre.customize.ui import enable_plugin',
  "enable_plugin('Google Images')",
  'from calibre.ebooks.metadata import string_to_authors',
  'from calibre.ebooks.metadata.sources.base import create_log',
  'from calibre.ebooks.metadata.sources.covers import download_cover',
  "title=os.environ.get('KOVI_CALIBRE_TITLE') or None",
  "author=os.environ.get('KOVI_CALIBRE_AUTHORS') or ''",
  'authors=string_to_authors(author) if author else []',
  'identifiers={}',
  "isbn=os.environ.get('KOVI_CALIBRE_ISBN') or ''",
  "identifiers.update({'isbn': isbn}) if isbn else None",
  'buf=BytesIO(); log=create_log(buf)',
  "cover=download_cover(log,title=title,authors=authors,identifiers=identifiers,timeout=int(os.environ.get('KOVI_CALIBRE_TIMEOUT','60')))",
  "out=os.environ['KOVI_CALIBRE_OUTPUT']",
  "open(out,'wb').write(cover[-1]) if cover else None",
  "print('provider='+cover[0].name if cover else 'no-cover')",
  "print(buf.getvalue().decode('utf-8','replace') if hasattr(buf.getvalue(),'decode') else str(buf.getvalue()))",
].join(';');

function enabledByEnv() {
  const raw = String(process.env.CALIBRE_COVER_RESOLVER ?? 'auto').trim().toLowerCase();
  return !['0', 'false', 'no', 'off', 'disabled'].includes(raw);
}

function cleanAuthor(value='') {
  const s = String(value || '').trim();
  if (!s || /^(n\/?a|unknown|sconosciuto)$/i.test(s)) return '';
  return s;
}

function stripQtNoise(value='') {
  return String(value || '')
    .replace(/^.*(?:QRhiGles2|QVulkanInstance|WebEngineContext|Unable to detect GPU vendor|createPlatformVulkanInstance).*$/gmi, '')
    .replace(/\n{3,}/g, '\n\n');
}

function trimLog(value='') {
  const s = stripQtNoise(value).replace(/\r/g, '').trim();
  if (!s) return '';
  return s.length > MAX_LOG_CHARS ? `${s.slice(0, MAX_LOG_CHARS)}…` : s;
}

function parseMetadataJson(value='') {
  const text=String(value||'');
  const line=text.split(/\r?\n/).find(x=>x.startsWith('KOVI_METADATA_JSON='));
  if(!line) return [];
  try {
    const parsed=JSON.parse(line.slice('KOVI_METADATA_JSON='.length));
    if(!Array.isArray(parsed)) return [];
    return parsed.slice(0,5).map(x=>({
      title:String(x?.title||'').slice(0,1000),
      authors:Array.isArray(x?.authors)?x.authors.map(a=>String(a).slice(0,500)).slice(0,10):[],
      identifiers:x?.identifiers && typeof x.identifiers==='object' ? Object.fromEntries(Object.entries(x.identifiers).slice(0,20).map(([k,v])=>[String(k).slice(0,80),String(v).slice(0,500)])) : {},
      languages:Array.isArray(x?.languages)?x.languages.map(v=>String(v).slice(0,40)).slice(0,10):[],
    }));
  } catch { return []; }
}

function execFilePromise(file, args, options, impl = execFile) {
  return new Promise((resolve, reject) => {
    impl(file, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      } else resolve({ stdout, stderr });
    });
  });
}

function normalizeTitle(value='') {
  return String(value).toLocaleLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
}

export function calibreTitleVariants(title='') {
  const raw=String(title||'').trim();
  const out=[];
  const push=(value)=>{
    const v=String(value||'').trim();
    if(v && !out.some(x=>normalizeTitle(x)===normalizeTitle(v))) out.push(v);
  };
  push(raw);
  push(raw.replace(/\s*[\[(].*?[\])]\s*$/,'').trim());
  const dot=raw.match(/^.{2,32}\.\s+(.{3,})$/); if(dot) push(dot[1]);
  const colon=raw.match(/^.{2,32}:\s+(.{3,})$/); if(colon) push(colon[1]);
  return out.slice(0,3);
}

export function calibreArgsForBook(book, coverPath, {includeAuthor=true, includeIsbn=true, titleOverride=null}={}) {
  const args = [];
  const title=titleOverride ?? book.title;
  if (title) args.push('--title', String(title).trim());
  args.push('--cover', coverPath, '--timeout', '30');
  const author = cleanAuthor(book.authors);
  if (includeAuthor && author) args.push('--authors', author);
  if (includeIsbn && book.isbn) args.push('--isbn', String(book.isbn));
  args.push('--verbose');
  return args;
}

export function calibreQueryPlans(book) {
  const plans=[];
  const push=(name,opts)=>{
    const key=JSON.stringify(opts);
    if(!plans.some(p=>JSON.stringify(p.opts)===key)) plans.push({name,opts});
  };
  if(book.isbn) push('isbn-title-author',{includeAuthor:true,includeIsbn:true,titleOverride:book.title});
  for(const [i,title] of calibreTitleVariants(book.title).entries()) {
    const label=i===0?'title':`title-variant-${i}`;
    push(`${label}-author`,{includeAuthor:true,includeIsbn:false,titleOverride:title});
    push(`${label}-only`,{includeAuthor:false,includeIsbn:false,titleOverride:title});
  }
  return plans.slice(0,5);
}

function directCoverPlans(book) {
  const author=cleanAuthor(book.authors);
  const plans=[];
  for(const [i,title] of calibreTitleVariants(book.title).entries()) {
    const label=i===0?'direct-title':`direct-title-variant-${i}`;
    if(author) plans.push({name:`${label}-author`,title,author});
    plans.push({name:label,title,author:''});
  }
  return plans.slice(0,5);
}

function calibreEnv(baseEnv, configDir, tmpDir, extra={}) {
  return {
    ...baseEnv,
    CALIBRE_CONFIG_DIRECTORY: configDir,
    CALIBRE_TEMP_DIR: path.join(tmpDir,'tmp'),
    CALIBRE_CACHE_DIRECTORY: path.join(tmpDir,'cache'),
    QT_QPA_PLATFORM: baseEnv.QT_QPA_PLATFORM || 'offscreen',
    QT_OPENGL: baseEnv.QT_OPENGL || 'software',
    QT_QUICK_BACKEND: baseEnv.QT_QUICK_BACKEND || 'software',
    LIBGL_ALWAYS_SOFTWARE: baseEnv.LIBGL_ALWAYS_SOFTWARE || '1',
    QTWEBENGINE_DISABLE_SANDBOX: baseEnv.QTWEBENGINE_DISABLE_SANDBOX || '1',
    QTWEBENGINE_CHROMIUM_FLAGS: baseEnv.QTWEBENGINE_CHROMIUM_FLAGS || '--disable-gpu --disable-dev-shm-usage --no-sandbox',
    ...extra,
  };
}

async function runDirectCoverStage(book,{tmpDir,configDir,execFileImpl,debugBin,timeoutMs,env}) {
  const plans=directCoverPlans(book);
  info('cover.calibre.direct.start','Running Calibre cover-only sources, including Google Images.',{
    bookId:book.id,title:book.title,plans:plans.map(p=>p.name),
  });
  let lastDetail='';
  for(let i=0;i<plans.length;i++){
    const plan=plans[i];
    const output=path.join(tmpDir,`direct-${i}.jpg`);
    info('cover.calibre.direct.attempt','Running Calibre cover-only query.',{bookId:book.id,title:book.title,strategy:plan.name,attempt:i+1,queryTitle:plan.title});
    try{
      const result=await execFilePromise(debugBin,['--command',DIRECT_COVER_CODE],{
        timeout:timeoutMs,
        maxBuffer:2*1024*1024,
        windowsHide:true,
        env:calibreEnv(env,configDir,tmpDir,{
          KOVI_CALIBRE_TITLE:plan.title,
          KOVI_CALIBRE_AUTHORS:plan.author,
          KOVI_CALIBRE_ISBN:String(book.isbn||''),
          KOVI_CALIBRE_OUTPUT:output,
          KOVI_CALIBRE_TIMEOUT:'60',
        }),
      },execFileImpl);
      lastDetail=trimLog(`${result?.stdout||''}\n${result?.stderr||''}`);
    }catch(e){
      if(e?.code==='ENOENT') return {status:'unavailable',reason:'calibre-debug-not-installed'};
      lastDetail=trimLog(e?.stderr||e?.stdout||e?.message);
    }
    if(fs.existsSync(output)){
      const buffer=fs.readFileSync(output);
      info('cover.calibre.direct.result','Calibre cover-only sources returned a candidate.',{bookId:book.id,title:book.title,strategy:plan.name,bytes:buffer.length,detail:lastDetail||undefined});
      return {status:'matched',buffer,strategy:plan.name,detail:lastDetail};
    }
    info('cover.calibre.direct.none','Calibre cover-only query returned no cover.',{bookId:book.id,title:book.title,strategy:plan.name,detail:lastDetail||undefined});
  }
  return {status:'none',reason:'direct-cover-none',detail:lastDetail};
}

async function runMetadataIdentifyStage(book,{tmpDir,configDir,execFileImpl,debugBin,timeoutMs,env}) {
  info('cover.calibre.metadata.start','Asking Calibre for machine-readable identifiers after cover download failed.',{
    bookId:book.id,title:book.title,authors:book.authors,isbn:book.isbn||undefined,
  });
  try {
    const result=await execFilePromise(debugBin,['--command',IDENTIFY_JSON_CODE],{
      timeout:Math.min(timeoutMs,60_000),
      maxBuffer:2*1024*1024,
      windowsHide:true,
      env:calibreEnv(env,configDir,tmpDir,{
        KOVI_CALIBRE_TITLE:String(book.title||''),
        KOVI_CALIBRE_AUTHORS:cleanAuthor(book.authors),
        KOVI_CALIBRE_ISBN:String(book.isbn||''),
        KOVI_CALIBRE_TIMEOUT:'45',
      }),
    },execFileImpl);
    const candidates=parseMetadataJson(`${result?.stdout||''}\n${result?.stderr||''}`);
    info(candidates.length?'cover.calibre.metadata.result':'cover.calibre.metadata.none',candidates.length?'Calibre identified bibliographic records that can be reused for deterministic cover URLs.':'Calibre did not identify reusable bibliographic records.',{
      bookId:book.id,title:book.title,candidates:candidates.length,
      identifiers:candidates.slice(0,3).map(x=>Object.keys(x.identifiers||{})),
    });
    return candidates;
  } catch(e) {
    if(e?.code==='ENOENT') return [];
    warn('cover.calibre.metadata.error','Calibre metadata identification failed after cover lookup.',{bookId:book.id,title:book.title,error:trimLog(e?.stderr||e?.stdout||e?.message)});
    return [];
  }
}

/**
 * Ask Calibre's own metadata-source framework to find the best cover. First
 * use fetch-ebook-metadata (Calibre's identify -> cover path). If identify
 * cannot find the book, run Calibre's cover downloader directly so cover-only
 * sources such as Google Images still get a chance.
 */
export async function fetchCoverWithCalibre(book, {
  dataDir,
  execFileImpl = execFile,
  bin = DEFAULT_BIN,
  debugBin = DEFAULT_DEBUG_BIN,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  env = process.env,
} = {}) {
  if (!enabledByEnv()) return { status:'unavailable', reason:'disabled' };
  if (!book?.title && !book?.isbn) return { status:'none', reason:'insufficient-metadata' };

  const base = path.join(dataDir || os.tmpdir(), 'uploads');
  fs.mkdirSync(base, { recursive:true });
  const tmpDir = fs.mkdtempSync(path.join(base, 'calibre-cover-'));
  const configDir = path.join(tmpDir, 'config');
  fs.mkdirSync(configDir, { recursive:true });
  fs.mkdirSync(path.join(tmpDir,'tmp'),{recursive:true});
  fs.mkdirSync(path.join(tmpDir,'cache'),{recursive:true});
  const started = Date.now();
  const plans = calibreQueryPlans(book);

  info('cover.calibre.start', 'Asking Calibre metadata sources for a cover.', {
    bookId:book.id, title:book.title, authors:book.authors, isbn:book.isbn || undefined, plans:plans.map(p=>p.name),
  });

  try {
    let lastDetail='';
    for (let i=0;i<plans.length;i++) {
      const plan=plans[i];
      const coverPath = path.join(tmpDir, `cover-${i}.jpg`);
      const args = calibreArgsForBook(book, coverPath, plan.opts);
      info('cover.calibre.attempt','Running a Calibre identify/cover query.',{bookId:book.id,title:book.title,strategy:plan.name,attempt:i+1,queryTitle:plan.opts.titleOverride||book.title});
      let result;
      try {
        result = await execFilePromise(bin, args, {
          timeout: timeoutMs,
          maxBuffer: 2 * 1024 * 1024,
          windowsHide: true,
          env: calibreEnv(env,configDir,tmpDir),
        }, execFileImpl);
      } catch (e) {
        if (e?.code === 'ENOENT') {
          info('cover.calibre.unavailable', 'Calibre cover resolver is not installed; continuing with native providers.', {bookId:book.id,title:book.title,bin});
          return { status:'unavailable', reason:'not-installed' };
        }
        lastDetail=trimLog(e?.stderr || e?.stdout || e?.message);
        if (!fs.existsSync(coverPath)) {
          info('cover.calibre.attempt.none', 'Calibre identify/cover query did not return a cover.', {
            bookId:book.id,title:book.title,strategy:plan.name,exitCode:e?.code ?? null, detail:lastDetail || undefined,
          });
          continue;
        }
        result = { stdout:e?.stdout || '', stderr:e?.stderr || '' };
      }

      if (!fs.existsSync(coverPath)) {
        lastDetail=trimLog(result?.stderr || result?.stdout);
        info('cover.calibre.attempt.none', 'Calibre identify/cover query completed without a cover.', {
          bookId:book.id,title:book.title,strategy:plan.name,detail:lastDetail || undefined,
        });
        continue;
      }

      const buffer = fs.readFileSync(coverPath);
      info('cover.calibre.result', 'Calibre returned a cover candidate.', {
        bookId:book.id,title:book.title,strategy:plan.name,bytes:buffer.length,durationMs:Date.now()-started,
      });
      return { status:'matched', buffer, strategy:plan.name, detail:trimLog(result?.stderr || result?.stdout) };
    }

    const direct=await runDirectCoverStage(book,{tmpDir,configDir,execFileImpl,debugBin,timeoutMs,env});
    if(direct.status==='matched') return direct;
    lastDetail=direct.detail||lastDetail;

    // Even when Calibre cannot download a cover, its identify providers may
    // know a stable Google Books id or ISBN. Preserve those identifiers so the
    // kovi resolver can use deterministic provider URLs instead of relying
    // on Google Images scraping.
    const metadataCandidates=await runMetadataIdentifyStage(book,{tmpDir,configDir,execFileImpl,debugBin,timeoutMs,env});

    info('cover.calibre.none', 'Calibre did not return a cover after identify and cover-only query plans.', {
      bookId:book.id,title:book.title,durationMs:Date.now()-started,metadataCandidates:metadataCandidates.length,detail:lastDetail || undefined,
    });
    return { status:'none', reason:'no-cover', detail:lastDetail, metadataCandidates };
  } catch (e) {
    warn('cover.calibre.error', 'Calibre cover lookup failed; continuing with native providers.', {
      bookId:book.id,title:book.title,error:String(e?.message || e),durationMs:Date.now()-started,
    });
    return { status:'none', reason:'error', detail:String(e?.message || e) };
  } finally {
    fs.rmSync(tmpDir, { recursive:true, force:true });
  }
}
