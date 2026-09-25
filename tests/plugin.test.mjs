import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const callApi=fs.readFileSync(new URL('../plugins/kovi.koplugin/call_api.lua', import.meta.url),'utf8');
const rawHttp=fs.readFileSync(new URL('../plugins/kovi.koplugin/raw_http.lua', import.meta.url),'utf8');
const upload=fs.readFileSync(new URL('../plugins/kovi.koplugin/upload.lua', import.meta.url),'utf8');
const annotations=fs.readFileSync(new URL('../plugins/kovi.koplugin/annotation_reader.lua', import.meta.url),'utf8');
const settings=fs.readFileSync(new URL('../plugins/kovi.koplugin/settings.lua', import.meta.url),'utf8');
const server=fs.readFileSync(new URL('../server.mjs', import.meta.url),'utf8');
const main=fs.readFileSync(new URL('../plugins/kovi.koplugin/main.lua', import.meta.url),'utf8');

test('plugin has a direct TCP/HTTP path plus KOReader HTTP fallback',()=>{assert.match(rawHttp,/socket\.tcp\(\)/);assert.match(rawHttp,/tcp:connect\(parsed\.host, parsed\.port\)/);assert.match(rawHttp,/HTTP\/1\.1/);assert.match(callApi,/RawHttp\.request/);assert.match(callApi,/Fall back to KOReader's standard HTTP stack/);assert.match(callApi,/socket\.skip\(1, http\.request\(request\)\)/)});

test('plugin reports the network stage instead of generic Network Error',()=>{assert.match(callApi,/kovi .* error/);assert.match(callApi,/stage == "tcp"/);assert.match(upload,/TCP connection to/);assert.doesNotMatch(callApi,/error = "Network Error"/)});

test('pairing performs layered diagnostics before consuming the code',()=>{assert.match(upload,/function U\.diagnose/);assert.match(upload,/RawHttp\.probe/);assert.match(upload,/local reachable, diagnostic = U\.diagnose\(server_url\)/);assert.match(upload,/\/api\/plugin\/ping/);assert.match(server,/plugin\.ping/)});

test('plugin rejects addresses that cannot point to the kovi host',()=>{assert.match(settings,/localhost/);assert.match(settings,/127%\./);assert.match(settings,/0%\.0%\.0%\.0/);assert.match(settings,/LAN IP/)});

test('plugin ensures a non-empty KOReader device id',()=>{assert.match(upload,/require\("random"\)/);assert.match(upload,/random\.uuid\(\)/);assert.match(upload,/saveSetting\("device_id", id\)/)});

test('plugin exposes a standalone layered connection test',()=>{assert.match(main,/Test server connection/);assert.match(main,/Upload\.diagnose\(url\)/)});

test('plugin scans KOReader sidecars and sends annotation sets with normal sync',()=>{assert.match(annotations,/require\("docsettings"\)/);assert.match(annotations,/require, "readhistory"/);assert.match(annotations,/readSetting\("annotations"\)/);assert.match(annotations,/partial_md5_checksum/);assert.match(upload,/Annotations\.changed\(previous_versions\)/)});

test('plugin syncs dated KOReader completion status and rescans existing sidecars once after upgrade',()=>{assert.match(annotations,/readSetting\("summary"\)/);assert.match(annotations,/reading_status = summary\.status/);assert.match(annotations,/reading_status_modified = summary\.modified/);assert.match(upload,/kovi_completion_sync_version/);assert.match(upload,/needs_completion_scan/)});

const coverReader=fs.readFileSync(new URL('../plugins/kovi.koplugin/cover_reader.lua', import.meta.url),'utf8');

test('plugin enriches sync from doc_props identifiers and can upload exact embedded covers',()=>{
  assert.match(annotations,/readSetting\("doc_props"\)/);
  assert.match(annotations,/identifiers = props\.identifiers/);
  assert.match(coverReader,/FileManagerBookInfo:getCoverImage\(nil, file_path\)/);
  assert.match(coverReader,/writeToFile\(tmp, "jpg", 82, false\)/);
  assert.match(upload,/response\.cover_requests/);
  assert.match(upload,/X-Kovi-Book-MD5/);
  assert.match(upload,/\/api\/plugin\/cover/);
  assert.match(server,/cover\.embedded\.saved/);
});

test('server detects plugins too old for embedded-cover requests',()=>{
  assert.match(server,/MIN_COVER_PLUGIN_VERSION/);
  assert.match(server,/plugin\.outdated\.cover-sync/);
  assert.match(server,/update_recommended/);
});

test('packaged plugin version is aligned with kovi 2026.09.25',()=>{
  const constants=fs.readFileSync(new URL('../plugins/kovi.koplugin/const.lua', import.meta.url),'utf8');
  assert.match(constants,/2026\.09\.25/);
});


test('plugin uses a persisted sync cursor with a one-day reading overlap',()=>{
  const dbReader=fs.readFileSync(new URL('../plugins/kovi.koplugin/db_reader.lua', import.meta.url),'utf8');
  assert.match(upload,/kovi_sync_cursor/);assert.match(upload,/sync_cursor = cursor/);assert.match(upload,/response\.sync_cursor/);
  assert.match(dbReader,/function Reader\.progressData\(sync_cursor, books\)/);assert.match(dbReader,/OVERLAP_SECONDS = 24 \* 60 \* 60/);assert.match(dbReader,/cursor - OVERLAP_SECONDS/);assert.match(dbReader,/start_time >=/);
});

test('plugin only opens changed annotation sidecars and sends deletion tombstones',()=>{
  assert.match(upload,/kovi_annotation_versions/);assert.match(upload,/Annotations\.changed\(previous_versions\)/);assert.match(upload,/saveSetting\("kovi_annotation_versions", annotation_versions\)/);
  assert.match(annotations,/lfs/);assert.match(annotations,/signature/);assert.match(annotations,/previous_versions/);assert.match(annotations,/present_md5/);assert.match(annotations,/annotations = \{\}/);
});
