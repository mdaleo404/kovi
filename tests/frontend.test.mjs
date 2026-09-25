import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source=fs.readFileSync(new URL('../public/app.js', import.meta.url),'utf8');
const html=fs.readFileSync(new URL('../public/index.html', import.meta.url),'utf8');
const css=fs.readFileSync(new URL('../public/styles.css', import.meta.url),'utf8');

test('manual SQLite upload attaches the browser CSRF token',()=>{
  assert.match(source,/setRequestHeader\('X-Kovi-CSRF',csrf\)/);
  assert.match(source,/ensureCsrf\(true\)/);
});

test('state-changing fetch requests can refresh a stale CSRF token',()=>{
  assert.match(source,/r\.status===403/);
  assert.match(source,/Missing browser request token/);
});

test('book cards route to a dedicated book page instead of a dialog',()=>{
  assert.match(source,/href=\"\/books\//);
  assert.match(source,/function openBook/);
  assert.match(html,/id="bookView"/);
  assert.doesNotMatch(html,/id="bookDialog"/);
});

test('library supports persisted sorting, reading-state filters, and combined search',()=>{
  assert.match(html,/id="bookSort"/);assert.match(html,/Recently read/);assert.match(html,/Reading time/);assert.match(html,/id="bookFilter"/);assert.match(html,/In progress/);assert.match(html,/Completed/);
  assert.match(source,/kovi-library-sort/);assert.match(source,/kovi-library-filter/);assert.match(source,/localStorage\.setItem\('kovi-library-sort'/);assert.match(source,/localStorage\.setItem\('kovi-library-filter'/);
  assert.match(source,/function bookReadingState/);assert.match(source,/function renderLibrary/);assert.match(source,/state\.libraryQuery/);assert.match(source,/total_read_time/);assert.match(source,/recent_read/);
  assert.match(css,/\.library-controls\{/);assert.match(css,/\.library-select select\{/);assert.match(css,/@media\(max-width:620px\)[^}]*\.library-controls/);
});

test('book page can retry an online cover and upload a manual cover',()=>{
  assert.match(source,/\/cover\/retry/);
  assert.match(source,/id="uploadBookCover"/);
  assert.match(source,/id="manualCoverInput"/);
  assert.match(source,/accept="image\/jpeg,image\/png,image\/webp,image\/gif"/);
  assert.match(source,/method:'PUT'/);
  assert.match(source,/Cover images must be 4 MB or smaller/);
});

test('completion is independent from document progress and can be overridden',()=>{
  assert.match(source,/const bookIsRead=/);assert.match(source,/b\.is_read/);assert.match(source,/book-read-badge/);
  assert.match(source,/Document progress/);assert.match(source,/id="toggleBookRead"/);assert.match(source,/id="clearBookRead"/);assert.match(source,/\/read/);assert.match(source,/Use synced status/);
  assert.match(css,/\.reading-status\{/);assert.match(css,/\.book-read-badge\{/);
});

test('pairing page polls its one-time request and refreshes the device list on success',()=>{
  assert.match(source,/function pollPairing/);
  assert.match(source,/\/api\/pairing-codes\//);
  assert.match(source,/await loadDevices\(\)/);
  assert.match(source,/pairDialog\.close\(\)/);
});

test('reading dashboard defaults to last year and offers all requested date filters',()=>{
  assert.match(html,/data-range="year"/);
  assert.match(html,/data-range="week"/);
  assert.match(html,/data-range="month"/);
  assert.match(html,/data-range="three-months"/);
  assert.match(html,/data-range="six-months"/);
  assert.match(html,/data-range="custom"/);
  assert.match(source,/RANGE_DAYS=.*year:365/);
  assert.match(source,/\/api\/dashboard\?\$\{params\}/);
});

test('dashboard shows books both started and completed in the selected range',()=>{assert.match(source,/Books read/);assert.match(source,/d\.range\?\.read_books/);assert.match(source,/started and completed/);assert.match(css,/#metrics\{grid-template-columns:repeat\(5/)});

test('recently read is replaced by a daily reading-time line graph',()=>{
  assert.doesNotMatch(html,/<h2>Recently read<\/h2>/i);
  assert.doesNotMatch(html,/id="recentShelf"/);
  assert.match(html,/id="lineChart"/);
  assert.match(html,/Daily reading time/);
  assert.match(source,/function renderLineChart/);
  assert.match(source,/chart-line/);
});

test('reading rhythm renders a range-aware GitHub-style heatmap without horizontal scrolling',()=>{
  assert.match(html,/heatmap-weekdays/);
  assert.match(source,/function renderHeatmap\(days,range\)/);
  assert.match(source,/--heat-weeks/);
  assert.match(source,/HEATMAP_REFERENCE_WEEKS=53/);
  assert.match(source,/referenceCell/);
  assert.match(source,/class=\"day \$\{outside\?'outside'/);
  assert.match(css,/\.heatmap-scroll\{[^}]*overflow:hidden!important/);
  assert.match(css,/grid-template-columns:repeat\(var\(--heat-weeks\),var\(--heat-cell\)\)/);
  assert.match(css,/\.heatmap\{[^}]*width:max-content/);
  assert.match(css,/--heatmap-empty:/);
});

test('mobile keeps the light-dark theme switch visible',()=>{
  assert.match(source,/function setTheme/);
  assert.match(css,/@media\(max-width:760px\)[\s\S]*?\.top-actions \.icon-button\{display:grid\}/);
});

test('reading time card uses the explicit all-time total instead of taking an arbitrary max',()=>{
  assert.match(source,/all_time_reading_seconds/);
  assert.doesNotMatch(source,/Math\.max\(d\.total_read_time/);
  assert.match(source,/all-time KOReader total/);
});

test('device page visibly warns when the KOReader plugin is too old for embedded cover sync',()=>{
  assert.match(source,/Plugin update needed/);
  assert.match(source,/Embedded covers and ISBN enrichment require plugin/);
  assert.match(source,/\/kovi-plugin\.zip/);
});


test('reading trend exposes interactive hover and tap values, including highlighted spike points',()=>{
  assert.match(source,/function chartKeyPointIndices/);
  assert.match(source,/chart-tooltip/);
  assert.match(source,/addEventListener\('pointermove'/);
  assert.match(source,/addEventListener\('click'/);
  assert.match(source,/data-chart-index/);
  assert.match(css,/\.chart-tooltip\{/);
});

test('calendar is a dedicated routed page with direct date jumping and per-day reading details',()=>{
  assert.match(html,/data-view="calendar"/);
  assert.match(html,/id="calendarView"/);
  assert.match(html,/id="calendarGrid"/);
  assert.match(html,/id="calendarDetail"/);
  assert.match(html,/id="calendarDateForm"/);
  assert.match(html,/id="calendarDateInput" type="date"/);
  assert.match(source,/calendar:'\/calendar'/);
  assert.match(source,/\/api\/calendar\?/);
  assert.match(source,/function renderCalendarDetail/);
  assert.match(source,/function jumpToCalendarDate/);
  assert.match(source,/calendarDateForm/);
  assert.doesNotMatch(source,/<span>Sessions<\/span>/);
  assert.match(css,/\.calendar-date-search\{/);
  assert.match(css,/\.calendar-grid\{/);
});


test('cover manager exposes transient candidates, history, and live job polling',()=>{
  assert.match(source,/Find online replacement/);assert.match(source,/Find alternatives/);assert.match(source,/cover\/candidates/);assert.match(source,/cover\/history/);assert.match(source,/function pollBookCoverJob/);assert.doesNotMatch(source,/2600/);
  assert.match(source,/Cover manager/);assert.match(css,/\.cover-option-grid\{/);
  assert.match(source,/coverChooserBookId:null/);assert.match(source,/showCoverChoices=state\.coverChooserBookId===b\.id/);
  assert.match(source,/state\.coverChooserBookId=b\.id/);assert.ok((source.match(/state\.coverChooserBookId=null/g)||[]).length>=4);
});

test('status page exposes sync diagnostics plus backup and human-friendly exports',()=>{
  assert.match(html,/data-view="status"/);assert.match(html,/id="statusView"/);assert.match(html,/Download kovi backup/);assert.match(source,/status:'\/status'/);assert.match(source,/\/api\/status/);assert.match(source,/function renderStatus/);
  assert.match(html,/\/api\/backup/);assert.doesNotMatch(html,/reading\.json/);assert.match(html,/\/api\/export\/books\.csv/);assert.match(html,/\/api\/export\/highlights\.md/);
  assert.match(source,/Time zone/);assert.match(source,/d\.time_zone/);assert.match(source,/dashboard and calendar dates/);
});

test('status refresh bypasses cache and shows visible progress and completion feedback',()=>{
  assert.match(source,/Refreshing…/);assert.match(source,/cache:'no-store'/);assert.match(source,/fresh=\$\{Date\.now\(\)\}/);assert.match(source,/Status refreshed at/);
});

test('device page explains the incremental sync upgrade',()=>{
  assert.match(source,/Incremental statistics and annotation sync require plugin/);assert.match(source,/min_incremental_plugin_version/);
});

test('sidebar and empty state use the kovi logo assets instead of split legacy branding',()=>{
  assert.match(html,/\/kovi-mark\.png/);assert.match(html,/\/kovi-logo\.png/);
  assert.doesNotMatch(html,/<span>KO<\/span>/);assert.doesNotMatch(html,/<b>DATA<\/b>/);
  assert.match(html,/id="themeColor"/);assert.match(source,/themeColor/);
});

test('the favicon uses the kovi mascot instead of the old svg mark',()=>{
  assert.match(html,/rel="icon" href="\/favicon\.png"/);assert.doesNotMatch(html,/logo\.svg/);
});
