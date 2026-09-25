const $=(s,r=document)=>r.querySelector(s), $$=(s,r=document)=>[...r.querySelectorAll(s)];
const LIBRARY_SORTS=['recent','title','author','time','progress'],LIBRARY_FILTERS=['all','unread','progress','completed'];
const storedChoice=(key,choices,fallback)=>{const value=localStorage.getItem(key);return choices.includes(value)?value:fallback};
const state={books:[],dashboard:null,csrf:null,pairPoll:null,currentBook:null,status:null,rangeKey:'year',calendar:null,calendarMonth:null,calendarSelectedDay:null,coverChooserBookId:null,librarySort:storedChoice('kovi-library-sort',LIBRARY_SORTS,'recent'),libraryFilter:storedChoice('kovi-library-filter',LIBRARY_FILTERS,'all'),libraryQuery:''};
const VIEW_PATHS={home:'/',library:'/library',calendar:'/calendar',devices:'/devices',status:'/status'};
const RANGE_LABELS={week:'Last week',month:'Last month','three-months':'Last three months','six-months':'Last six months',year:'Last year',custom:'Custom dates'};
const RANGE_DAYS={week:7,month:30,'three-months':90,'six-months':180,year:365};
const HEATMAP_REFERENCE_WEEKS=53;
const fmtSeconds=s=>{s=Math.max(0,Number(s||0));const h=Math.floor(s/3600),m=Math.floor((s%3600)/60);return h?`${h}h ${m}m`:`${m}m`};
const fmtCompactSeconds=s=>{s=Math.max(0,Number(s||0));const m=Math.max(1,Math.round(s/60));return m>=60?`${(m/60).toFixed(m%60?1:0)}h`:`${m}m`};
const esc=s=>String(s??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
const progress=b=>{const page=Number(b.last_page||0),total=Number(b.last_total_pages||b.pages||0);return total>0?Math.min(100,Math.round(page/total*100)):0};
const bookIsRead=b=>b.is_read==null?progress(b)===100:Boolean(Number(b.is_read));
const localDateKey=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const parseLocalDateKey=key=>{const m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key||''));if(!m)return null;const d=new Date(Number(m[1]),Number(m[2])-1,Number(m[3]),12,0,0,0);return d.getFullYear()===Number(m[1])&&d.getMonth()===Number(m[2])-1&&d.getDate()===Number(m[3])?d:null};
const formatDate=(key,opts={month:'short',day:'numeric',year:'numeric'})=>parseLocalDateKey(key)?.toLocaleDateString(undefined,opts)||key;
function toast(msg){const el=$('#toast');el.textContent=msg;el.classList.add('show');setTimeout(()=>el.classList.remove('show'),3200)}

async function api(url,opts={},retryCsrf=true){
  const method=(opts.method||'GET').toUpperCase();
  const request={...opts,headers:{...(opts.headers||{})}};
  if(method!=='GET'&&!state.csrf){const session=await api('/api/session',{},false);state.csrf=session.csrf}
  if(method!=='GET'&&state.csrf)request.headers['X-Kovi-CSRF']=state.csrf;
  const r=await fetch(url,request);const data=await r.json().catch(()=>({}));
  if(!r.ok&&r.status===403&&retryCsrf&&method!=='GET'&&data.error==='Missing browser request token.'){const session=await api('/api/session',{},false);state.csrf=session.csrf;return api(url,opts,false)}
  if(!r.ok)throw new Error(data.error||`Request failed (${r.status})`);return data;
}

function coverImageSrc(b){if(!b.cover_path)return '';const version=b.updated_at||b.cover_checked_at||'';return version?`${b.cover_path}${b.cover_path.includes('?')?'&':'?'}v=${encodeURIComponent(version)}`:b.cover_path}
function coverMarkup(b){return b.cover_path?`<img src="${esc(coverImageSrc(b))}" alt="Cover of ${esc(b.title)}" loading="lazy">`:`<div class="cover-placeholder"><b>${esc(b.title)}</b><span>${esc(b.authors||'Unknown author')}</span></div>`}
function bookCard(b){const p=progress(b),read=bookIsRead(b);return `<a class="book-card" href="/books/${encodeURIComponent(b.id)}" data-book-id="${esc(b.id)}" data-search="${esc(`${b.title} ${b.authors||''}`.toLowerCase())}"><div class="cover">${coverMarkup(b)}${read?'<span class="book-read-badge">Read</span>':''}</div><h3 title="${esc(b.title)}">${esc(b.title)}</h3><p>${esc(b.authors||'Unknown author')}</p><progress class="book-progress" value="${p}" max="100" title="Approx. ${p}% document progress">${p}%</progress></a>`}

function bookReadingState(book){if(bookIsRead(book))return 'completed';if(book.read_override!=null&&Number(book.read_override)===0)return 'unread';return progress(book)===0?'unread':'progress'}
function renderLibrary(){
  const collator=new Intl.Collator(undefined,{sensitivity:'base',numeric:true}),title=(a,b)=>collator.compare(a.title||'',b.title||'');
  const comparators={recent:(a,b)=>Number(b.recent_read||b.last_open||0)-Number(a.recent_read||a.last_open||0)||title(a,b),title,author:(a,b)=>collator.compare(a.authors||'Unknown author',b.authors||'Unknown author')||title(a,b),time:(a,b)=>Number(b.total_read_time||0)-Number(a.total_read_time||0)||title(a,b),progress:(a,b)=>progress(b)-progress(a)||title(a,b)};
  const query=state.libraryQuery.trim().toLowerCase();
  const books=state.books.filter(book=>(state.libraryFilter==='all'||bookReadingState(book)===state.libraryFilter)&&(!query||`${book.title} ${book.authors||''}`.toLowerCase().includes(query))).sort(comparators[state.librarySort]);
  $('#bookSort').value=state.librarySort;$('#bookFilter').value=state.libraryFilter;
  $('#librarySummary').textContent=books.length===state.books.length?`${books.length} book${books.length===1?'':'s'}`:`Showing ${books.length} of ${state.books.length} books`;
  $('#bookGrid').innerHTML=books.map(bookCard).join('')||`<p class="muted">${state.books.length?'No books match these filters.':'No books yet.'}</p>`;
}

function rangeLabel(){return RANGE_LABELS[state.rangeKey]||'Custom dates'}
function rangeDescription(range){return `${formatDate(range.from)} – ${formatDate(range.to)}`}
function buildRangeSeries(days,range){
  const by=new Map((days||[]).map(x=>[x.day,Number(x.seconds||0)]));
  const start=parseLocalDateKey(range?.from),end=parseLocalDateKey(range?.to);if(!start||!end)return [];
  const out=[];for(const d=new Date(start);d<=end;d.setDate(d.getDate()+1)){const day=localDateKey(d);out.push({day,seconds:by.get(day)||0})}return out;
}

function render(){
  const d=state.dashboard,b=state.books;const empty=!b.length;
  $('#emptyState').classList.toggle('hidden',!empty);$('#dashboardContent').classList.toggle('hidden',empty);
  if(!empty&&d){
    $('#metrics').innerHTML=[
      ['Books',d.books,'in your reading history'],
      ['Books read',Number(d.range?.read_books||0).toLocaleString(),`started and completed · ${rangeLabel()}`],
      ['Reading time',fmtSeconds(d.all_time_reading_seconds??d.total_read_time??d.session_seconds),'all-time KOReader total'],
      ['Pages',Number(d.total_read_pages||0).toLocaleString(),'pages turned'],
      ['Highlights',Number(d.highlights||0).toLocaleString(),'ideas kept'],
    ].map(x=>`<article class="metric"><span>${x[0]}</span><strong>${x[1]}</strong><small>${x[2]}</small></article>`).join('');
    renderRangeUi(d.range);renderHeatmap(d.days||[],d.range);renderLineChart(d.days||[],d.range,d);
  }
  renderLibrary();
}

function renderRangeUi(range){
  if(!range)return;
  const label=rangeLabel();
  $('#rangeSummary').textContent=state.rangeKey==='custom'?rangeDescription(range):label;
  $('#rhythmRangeLabel').textContent=label;$('#trendRangeLabel').textContent=label;
  $$('.range-button').forEach(button=>button.classList.toggle('active',button.dataset.range===state.rangeKey));
  $('#customFrom').value=range.from;$('#customTo').value=range.to;
  const today=localDateKey(new Date());$('#customFrom').max=today;$('#customTo').max=today;
}

function heatLevel(sec,active){
  if(!sec)return 0;if(!active.length)return 1;
  const sorted=[...active].sort((a,b)=>a-b),q=p=>sorted[Math.min(sorted.length-1,Math.floor((sorted.length-1)*p))];
  if(sec<=q(.25))return 1;if(sec<=q(.5))return 2;if(sec<=q(.75))return 3;return 4;
}
function renderHeatmap(days,range){
  const from=parseLocalDateKey(range?.from),to=parseLocalDateKey(range?.to);if(!from||!to)return;
  const by=new Map(days.map(x=>[x.day,Number(x.seconds||0)])),active=[...by.values()].filter(Boolean);
  const start=new Date(from);start.setDate(start.getDate()-start.getDay());
  const end=new Date(to);end.setDate(end.getDate()+(6-end.getDay()));
  const cellCount=Math.round((end-start)/86400000)+1,weeks=Math.ceil(cellCount/7);
  let html='',activeDays=0,total=0;
  for(let i=0;i<cellCount;i++){
    const dt=new Date(start);dt.setDate(start.getDate()+i);const outside=dt<from||dt>to;const key=localDateKey(dt),sec=outside?0:(by.get(key)||0);
    if(sec){activeDays++;total+=sec}const level=heatLevel(sec,active);
    html+=`<span class="day ${outside?'outside':level?'l'+level:''}" title="${outside?'':`${key}: ${fmtSeconds(sec)}`}"></span>`;
  }
  const heatmap=$('#heatmap'),months=$('#heatmapMonths'),canvas=heatmap.closest('.heatmap-scroll'),layout=heatmap.closest('.heatmap-layout');heatmap.innerHTML=html;
  const monthCells=[];let prior='';
  for(let week=0;week<weeks;week++){
    const weekDate=new Date(start);weekDate.setDate(start.getDate()+week*7);
    const mid=new Date(weekDate);mid.setDate(mid.getDate()+3);const monthKey=`${mid.getFullYear()}-${mid.getMonth()}`;
    const changed=week===0||monthKey!==prior;
    const sparse=weeks>180 ? mid.getMonth()===0 : weeks>90 ? (mid.getMonth()===0||mid.getMonth()===6) : true;
    monthCells.push(`<span>${changed&&sparse?esc(mid.toLocaleDateString(undefined,{month:weeks>90?'short':'short'})):''}</span>`);prior=monthKey;
  }
  months.innerHTML=monthCells.join('');
  // Keep the visual scale stable across filters: shorter ranges should reveal fewer
  // GitHub-style columns, not stretch those columns to fill the whole panel.
  // The selected range therefore uses the same cell size a full 53-week year
  // would use at the current viewport. On narrow screens that reference size
  // naturally shrinks, so even the full year still fits without scrolling.
  const available=Math.max(1,canvas?.clientWidth||0),gap=available<480?1.5:3;
  const referenceCell=Math.max(.25,(available-gap*(HEATMAP_REFERENCE_WEEKS-1))/HEATMAP_REFERENCE_WEEKS);
  const cell=Math.min(referenceCell,(available-gap*Math.max(0,weeks-1))/Math.max(1,weeks));
  [canvas,layout].filter(Boolean).forEach(el=>{el.style.setProperty('--heat-weeks',String(weeks));el.style.setProperty('--heat-gap',`${gap}px`);el.style.setProperty('--heat-cell',`${cell}px`)});
  $('#heatmapCaption').textContent=activeDays?`${activeDays} reading day${activeDays===1?'':'s'} · ${fmtSeconds(total)} tracked from ${formatDate(range.from)} to ${formatDate(range.to)}.`:`No dated reading sessions in ${rangeDescription(range)}.`;
}

function niceStep(value){
  if(value<=0)return 15;const power=10**Math.floor(Math.log10(value));const scaled=value/power;
  const factor=scaled<=1?1:scaled<=2?2:scaled<=5?5:10;return factor*power;
}
function axisMinutes(minutes){if(minutes>=60){const hours=minutes/60;return Number.isInteger(hours)?`${hours}h`:`${hours.toFixed(1)}h`}return `${Math.round(minutes)}m`}
function chartDateLabel(key,span){const d=parseLocalDateKey(key);if(!d)return key;if(span<=14)return d.toLocaleDateString(undefined,{weekday:'short'});if(span<=120)return d.toLocaleDateString(undefined,{month:'short',day:'numeric'});return d.toLocaleDateString(undefined,{month:'short',year:'2-digit'})}
function chartKeyPointIndices(series){
  const active=series.map((item,index)=>({index,seconds:item.seconds})).filter(x=>x.seconds>0);
  if(!active.length)return new Set();
  if(series.length<=45)return new Set(active.map(x=>x.index));
  const values=active.map(x=>x.seconds).sort((a,b)=>a-b),threshold=values[Math.max(0,Math.floor(values.length*.75)-1)]||0;
  const keys=new Set();let max=active[0];
  for(const point of active){
    if(point.seconds>max.seconds)max=point;
    const prev=series[point.index-1]?.seconds||0,next=series[point.index+1]?.seconds||0;
    if(point.seconds>=threshold&&point.seconds>=prev&&point.seconds>=next)keys.add(point.index);
  }
  keys.add(max.index);return keys;
}
function renderLineChart(days,range,dashboard){
  const series=buildRangeSeries(days,range),total=series.reduce((sum,x)=>sum+x.seconds,0),readingDays=series.filter(x=>x.seconds>0).length;
  $('#trendTotal').textContent=fmtSeconds(total);$('#trendDays').textContent=String(readingDays);
  const chart=$('#lineChart');
  if(!series.length||!series.some(x=>x.seconds>0)){
    chart.innerHTML='<div class="chart-empty">No reading sessions in this range.</div>';
    chart.setAttribute('aria-label',`No dated reading sessions from ${formatDate(range.from)} to ${formatDate(range.to)}.`);
  }else{
    const width=Math.max(320,Math.round(chart.clientWidth||900)),height=270,left=54,right=18,top=18,bottom=42,plotW=width-left-right,plotH=height-top-bottom;
    const maxMinutes=Math.max(...series.map(x=>x.seconds/60)),step=niceStep(maxMinutes/4),yMax=Math.max(step*4,Math.ceil(maxMinutes/step)*step);
    const x=i=>left+(series.length===1?plotW/2:(i/(series.length-1))*plotW),y=seconds=>top+plotH-(seconds/60/yMax)*plotH;
    const grid=[];for(let i=0;i<=4;i++){const min=(yMax/4)*i,yy=top+plotH-(i/4)*plotH;grid.push(`<line x1="${left}" y1="${yy}" x2="${width-right}" y2="${yy}" class="chart-grid"/><text x="${left-10}" y="${yy+4}" text-anchor="end" class="chart-axis">${axisMinutes(min)}</text>`)}
    const points=series.map((item,i)=>`${x(i).toFixed(2)},${y(item.seconds).toFixed(2)}`).join(' ');
    const tickIndices=[0,.25,.5,.75,1].map(p=>Math.round((series.length-1)*p)).filter((v,i,a)=>a.indexOf(v)===i);
    const ticks=tickIndices.map(i=>`<text x="${x(i)}" y="${height-12}" text-anchor="${i===0?'start':i===series.length-1?'end':'middle'}" class="chart-axis">${esc(chartDateLabel(series[i].day,series.length))}</text>`).join('');
    const keyPoints=chartKeyPointIndices(series);
    const dots=[...keyPoints].sort((a,b)=>a-b).map(i=>`<circle cx="${x(i)}" cy="${y(series[i].seconds)}" r="3.75" class="chart-dot key" tabindex="0" role="button" data-chart-index="${i}" aria-label="${esc(`${formatDate(series[i].day)}: ${fmtSeconds(series[i].seconds)}`)}"><title>${esc(`${formatDate(series[i].day)}: ${fmtSeconds(series[i].seconds)}`)}</title></circle>`).join('');
    chart.innerHTML=`<svg viewBox="0 0 ${width} ${height}" aria-label="Interactive daily reading time chart"><g aria-hidden="true">${grid.join('')}<polyline points="${points}" class="chart-line" vector-effect="non-scaling-stroke"/>${ticks}<line x1="${left}" x2="${left}" y1="${top}" y2="${top+plotH}" class="chart-hover-guide hidden"/><circle cx="${left}" cy="${top+plotH}" r="5" class="chart-hover-dot hidden"/></g>${dots}<rect x="${left}" y="${top}" width="${plotW}" height="${plotH}" class="chart-hit-area" aria-hidden="true"/></svg><div class="chart-tooltip hidden" aria-hidden="true"><strong></strong><span></span></div>`;
    const svg=$('svg',chart),tooltip=$('.chart-tooltip',chart),guide=$('.chart-hover-guide',chart),hoverDot=$('.chart-hover-dot',chart);let pinnedIndex=null;
    const showAt=index=>{
      index=Math.max(0,Math.min(series.length-1,index));const item=series[index],xx=x(index),yy=y(item.seconds),rect=svg.getBoundingClientRect();
      guide.setAttribute('x1',xx);guide.setAttribute('x2',xx);guide.classList.remove('hidden');hoverDot.setAttribute('cx',xx);hoverDot.setAttribute('cy',yy);hoverDot.classList.remove('hidden');
      $('strong',tooltip).textContent=formatDate(item.day,{weekday:'short',month:'short',day:'numeric',year:'numeric'});$('span',tooltip).textContent=item.seconds?fmtSeconds(item.seconds):'No reading';tooltip.classList.remove('hidden');
      const cssX=(xx/width)*rect.width,cssY=(yy/height)*rect.height;tooltip.style.left=`${Math.max(70,Math.min(rect.width-70,cssX))}px`;tooltip.style.top=`${Math.max(20,cssY-8)}px`;
    };
    const hide=()=>{if(pinnedIndex!==null)return;tooltip.classList.add('hidden');guide.classList.add('hidden');hoverDot.classList.add('hidden')};
    svg.addEventListener('pointermove',event=>{if(pinnedIndex!==null)return;const rect=svg.getBoundingClientRect(),px=(event.clientX-rect.left)*(width/Math.max(1,rect.width)),ratio=(px-left)/Math.max(1,plotW),index=Math.round(Math.max(0,Math.min(1,ratio))*(series.length-1));showAt(index)});
    svg.addEventListener('pointerleave',hide);
    svg.addEventListener('click',event=>{const rect=svg.getBoundingClientRect(),px=(event.clientX-rect.left)*(width/Math.max(1,rect.width)),ratio=(px-left)/Math.max(1,plotW),index=Math.round(Math.max(0,Math.min(1,ratio))*(series.length-1));if(pinnedIndex===index){pinnedIndex=null;hide()}else{pinnedIndex=index;showAt(index)}});
    svg.addEventListener('focusin',event=>{const dot=event.target.closest?.('[data-chart-index]');if(dot){pinnedIndex=Number(dot.dataset.chartIndex);showAt(pinnedIndex)}});
    svg.addEventListener('focusout',()=>{pinnedIndex=null;hide()});
    chart.setAttribute('aria-label',`Daily reading time from ${formatDate(range.from)} to ${formatDate(range.to)}. Hover or tap the chart to inspect a day. ${fmtSeconds(total)} across ${readingDays} reading days.`);
  }
  const allTime=Number(dashboard.all_time_reading_seconds||0),sessionAll=Number(dashboard.session_seconds||0),gap=Math.abs(allTime-sessionAll);
  let caption=`Daily session history for ${rangeDescription(range)}. Hover or tap the graph to inspect individual days.`;
  if(gap>=60)caption+=` The all-time Reading time card uses KOReader’s per-book total (${fmtSeconds(allTime)}), while dated session rows add up to ${fmtSeconds(sessionAll)} across all dates; this is why the figures can differ.`;
  else caption+=' The Reading time card is all-time; this graph is limited to the selected dates.';
  $('#trendCaption').textContent=caption;
}

function presetRange(key){const days=RANGE_DAYS[key];if(!days)return null;const to=new Date();to.setHours(12,0,0,0);const from=new Date(to);from.setDate(from.getDate()-(days-1));return {from:localDateKey(from),to:localDateKey(to)}}
async function applyDashboardRange(key,range){
  if(!range)return;state.rangeKey=key;
  const params=new URLSearchParams({from:range.from,to:range.to});
  try{state.dashboard=await api(`/api/dashboard?${params}`);render()}catch(e){toast(e.message)}
}

let coverPoll=null;
async function refresh(){
  const dashboardUrl=state.dashboard?.range?`/api/dashboard?${new URLSearchParams({from:state.dashboard.range.from,to:state.dashboard.range.to})}`:'/api/dashboard';
  const [books,dashboard]=await Promise.all([api('/api/books'),api(dashboardUrl)]);
  state.books=books.books;state.dashboard=dashboard;render();
  if(coverPoll){clearTimeout(coverPoll);coverPoll=null}
  if(state.books.some(b=>b.cover_status==='pending'))coverPoll=setTimeout(()=>refresh().catch(()=>{}),5000);
}

function monthAnchor(value=new Date()){const d=value instanceof Date?new Date(value):parseLocalDateKey(value)||new Date();return new Date(d.getFullYear(),d.getMonth(),1,12,0,0,0)}
function calendarMonthRange(value){const first=monthAnchor(value),last=new Date(first.getFullYear(),first.getMonth()+1,0,12,0,0,0);return {from:localDateKey(first),to:localDateKey(last)}}
function calendarLevel(seconds,active){return heatLevel(seconds,active)}
function renderCalendarDetail(dayKey){
  const detail=$('#calendarDetail'),data=state.calendar,day=(data?.days||[]).find(x=>x.day===dayKey);state.calendarSelectedDay=dayKey;
  const dateInput=$('#calendarDateInput');if(dateInput)dateInput.value=dayKey;
  $$('.calendar-day').forEach(el=>el.classList.toggle('selected',el.dataset.day===dayKey));
  const date=formatDate(dayKey,{weekday:'long',month:'long',day:'numeric',year:'numeric'});
  if(!day){detail.innerHTML=`<p class="eyebrow">${esc(date)}</p><h3>No reading logged.</h3><p class="muted">There are no dated KOReader sessions for this day.</p>`;return}
  const books=(day.books||[]).map(book=>`<button type="button" class="calendar-book-row" data-calendar-book-id="${esc(book.id)}"><span class="calendar-book-cover">${book.cover_path?`<img src="${esc(coverImageSrc(book))}" alt="">`:`<b>${esc((book.title||'?').slice(0,1))}</b>`}</span><span class="calendar-book-copy"><strong>${esc(book.title)}</strong><small>${esc(book.authors||'Unknown author')}</small></span><span class="calendar-book-time">${fmtSeconds(book.seconds)}</span></button>`).join('');
  detail.innerHTML=`<p class="eyebrow">${esc(date)}</p><div class="calendar-detail-summary"><div><span>Reading time</span><strong>${fmtSeconds(day.seconds)}</strong></div><div><span>Books</span><strong>${day.books.length}</strong></div></div><div class="calendar-book-list">${books}</div>`;
}
function renderCalendar(){
  const data=state.calendar;if(!data)return;const range=data.range,from=parseLocalDateKey(range.from),to=parseLocalDateKey(range.to);if(!from||!to)return;
  $('#calendarMonthTitle').textContent=from.toLocaleDateString(undefined,{month:'long',year:'numeric'});
  const total=(data.days||[]).reduce((sum,day)=>sum+Number(day.seconds||0),0),readingDays=(data.days||[]).filter(day=>Number(day.seconds||0)>0).length;
  $('#calendarMonthSummary').textContent=readingDays?`${readingDays} reading day${readingDays===1?'':'s'} · ${fmtSeconds(total)}`:'No reading sessions this month';
  const by=new Map((data.days||[]).map(day=>[day.day,day])),active=(data.days||[]).map(day=>Number(day.seconds||0)).filter(Boolean);
  const gridStart=new Date(from);gridStart.setDate(gridStart.getDate()-gridStart.getDay());const gridEnd=new Date(to);gridEnd.setDate(gridEnd.getDate()+(6-gridEnd.getDay()));
  const today=localDateKey(new Date());let html='';
  for(const d=new Date(gridStart);d<=gridEnd;d.setDate(d.getDate()+1)){
    const key=localDateKey(d),item=by.get(key),outside=d.getMonth()!==from.getMonth(),seconds=Number(item?.seconds||0),level=calendarLevel(seconds,active),books=item?.books?.length||0;
    const label=`${formatDate(key,{weekday:'long',month:'long',day:'numeric',year:'numeric'})}${seconds?`, ${fmtSeconds(seconds)}, ${books} book${books===1?'':'s'}`:', no reading logged'}`;
    html+=`<button type="button" class="calendar-day ${outside?'outside':''} ${seconds?'has-reading l'+level:''} ${key===today?'today':''}" data-day="${key}" aria-label="${esc(label)}"><span class="calendar-day-number">${d.getDate()}</span>${seconds?`<strong class="calendar-day-time">${fmtCompactSeconds(seconds)}</strong><span class="calendar-day-books">${books} book${books===1?'':'s'}</span>`:'<span class="calendar-day-empty">·</span>'}</button>`;
  }
  const grid=$('#calendarGrid');grid.innerHTML=html;grid.setAttribute('aria-label',`Reading calendar for ${from.toLocaleDateString(undefined,{month:'long',year:'numeric'})}`);
  let selected=state.calendarSelectedDay;if(!selected||selected<range.from||selected>range.to)selected=(data.days||[]).find(day=>day.day===today)?.day||(data.days||[])[0]?.day||range.from;
  renderCalendarDetail(selected);
}
async function loadCalendar(value=state.calendarMonth||new Date(),selectDay=null){
  const month=monthAnchor(value),range=calendarMonthRange(month);state.calendarMonth=month;if(selectDay)state.calendarSelectedDay=selectDay;
  $('#calendarGrid').innerHTML='<div class="calendar-loading muted">Loading reading days…</div>';
  try{state.calendar=await api(`/api/calendar?${new URLSearchParams(range)}`);renderCalendar()}catch(e){toast(e.message);$('#calendarGrid').innerHTML='<div class="calendar-loading muted">Could not load this month.</div>'}
}
function moveCalendarMonth(delta){const base=state.calendarMonth||monthAnchor();const next=new Date(base.getFullYear(),base.getMonth()+delta,1,12,0,0,0);state.calendarSelectedDay=null;loadCalendar(next)}
function jumpToCalendarDate(dayKey){const date=parseLocalDateKey(dayKey);if(!date)return toast('Choose a valid date.');loadCalendar(date,dayKey)}

function setView(name){
  $$('.view').forEach(v=>v.classList.remove('active'));
  $$('.nav-item').forEach(v=>v.classList.toggle('active',v.dataset.view===name));
  const target=$(`#${name}View`);if(target)target.classList.add('active');
  $('#pageTitle').textContent=name==='home'?'Good to see you.':name==='library'?'Your library.':name==='calendar'?'Your calendar.':name==='devices'?'Your devices.':name==='status'?'kovi status.':'Book details.';
  if(name==='home'&&state.dashboard?.range)requestAnimationFrame(()=>{renderHeatmap(state.dashboard.days||[],state.dashboard.range);renderLineChart(state.dashboard.days||[],state.dashboard.range,state.dashboard)});
  if(name==='calendar')loadCalendar();
  if(name==='devices')loadDevices();
  if(name==='status')loadStatus();
}
function switchView(name,{push=true}={}){setView(name);if(push&&VIEW_PATHS[name]&&location.pathname!==VIEW_PATHS[name])history.pushState({view:name},'',VIEW_PATHS[name]);window.scrollTo(0,0)}

async function openBook(id,{push=true}={}){
  try{
    const b=await api(`/api/books/${encodeURIComponent(id)}`);if(state.coverChooserBookId&&state.coverChooserBookId!==b.id)state.coverChooserBookId=null;state.currentBook=b;renderBookPage(b);setView('book');
    if(push&&location.pathname!==`/books/${encodeURIComponent(id)}`)history.pushState({bookId:id},'',`/books/${encodeURIComponent(id)}`);
    window.scrollTo(0,0);
  }catch(error){toast(error.message);switchView('library',{push})}
}
function annotationMarkup(a){
  const text=a.text||'',note=a.note||'',location=[a.chapter,a.pageno?`page ${a.pageno}`:a.page?`page ${a.page}`:''].filter(Boolean).join(' · ');
  return `<article class="annotation-card"><div class="annotation-top"><span class="annotation-kind">${a.annotation_type==='note'?'Note':'Highlight'}</span>${a.annotation_datetime?`<time>${esc(a.annotation_datetime)}</time>`:''}</div>${text?`<blockquote>${esc(text)}</blockquote>`:''}${note?`<p class="annotation-note">${esc(note)}</p>`:''}${location?`<p class="annotation-location">${esc(location)}</p>`:''}</article>`;
}
let bookCoverPoll=null;
function stopBookCoverPoll(){if(bookCoverPoll){clearTimeout(bookCoverPoll);bookCoverPoll=null}}
function coverSourceLabel(source){return ({'koreader-embedded':'KOReader embedded','manual-upload':'Manual upload',openlibrary:'Open Library',googlebooks:'Google Books','openlibrary-via-googlebooks':'Open Library via Google Books','googlebooks-via-calibre-id':'Google Books via Calibre',calibre:'Calibre'}[source]||source||'No cover')}
function coverJobLabel(job){if(!job)return '';if(job.state==='queued')return 'Queued for online lookup…';if(job.state==='running')return 'Looking for an online cover…';if(job.state==='error')return `Lookup failed${job.last_error?`: ${job.last_error}`:''}`;if(job.state==='done'&&job.result_status==='none-kept')return 'No better cover found — kept the existing cover.';if(job.state==='done'&&job.result_status==='matched')return `Online cover updated${job.result_source?` via ${coverSourceLabel(job.result_source)}`:''}.`;return ''}
function coverOption(c,{history=false}={}){const selected=history&&Number(c.selected)===1;return `<article class="cover-option ${selected?'selected':''}"><div class="cover option-cover"><img src="${esc(c.path)}" alt="${history?'Previous':'Candidate'} cover" loading="lazy"></div><div class="cover-option-copy"><strong>${esc(history?coverSourceLabel(c.source):(c.title||coverSourceLabel(c.source)))}</strong><small>${esc(history?(c.strategy||new Date(c.created_at).toLocaleString()):([c.authors,coverSourceLabel(c.source),Number(c.score||0)?`${Math.round(Number(c.score)*100)}% match`:null].filter(Boolean).join(' · ')))}</small></div>${selected?'<span class="status-badge">Current</span>':`<button type="button" class="secondary-action" ${history?`data-cover-history="${esc(c.id)}"`:`data-cover-candidate="${esc(c.id)}"`}>Use this</button>`}</article>`}
async function pollBookCoverJob(bookId,attempt=0){
  stopBookCoverPoll();
  try{
    const b=await api(`/api/books/${encodeURIComponent(bookId)}`);state.currentBook=b;renderBookPage(b);
    if(b.cover_job&&['queued','running'].includes(b.cover_job.state)&&attempt<90){bookCoverPoll=setTimeout(()=>pollBookCoverJob(bookId,attempt+1),1000);return}
    await refresh();
  }catch{if(attempt<20)bookCoverPoll=setTimeout(()=>pollBookCoverJob(bookId,attempt+1),1500)}
}
function renderBookPage(b){
  const p=progress(b),read=bookIsRead(b),annotations=b.annotations||[];let highlights='';
  if(annotations.length)highlights=`<div class="annotation-list">${annotations.map(annotationMarkup).join('')}</div>`;
  else if(Number(b.highlights||0)>0)highlights=`<article class="panel annotation-empty"><strong>${Number(b.highlights)} highlight${Number(b.highlights)===1?'':'s'} counted by KOReader</strong><p class="muted">The statistics database stores only the count. Sync the kovi plugin to import the actual highlight text from KOReader’s book sidecars.</p></article>`;
  else highlights='<article class="panel annotation-empty"><p class="muted">No highlights have been synced for this book.</p></article>';
  const jobText=coverJobLabel(b.cover_job),jobBusy=b.cover_job&&['queued','running'].includes(b.cover_job.state);
  const candidates=b.cover_candidates||[],history=b.cover_history||[],showCoverChoices=state.coverChooserBookId===b.id;
  const statusLabel=read?'Read':b.read_override!=null&&Number(b.read_override)===0?'Unread':p>0?'Reading':'Unread';
  const statusDetail=b.read_override!=null?`Manually marked ${Number(b.read_override)?'read':'unread'} in kovi.`:b.read_source==='koreader'?'Marked read by KOReader.':b.read_source==='progress'?'Completed from document progress.':'Completion is tracked separately from document progress.';
  const readControl=`<section class="reading-status"><div><span class="status-badge read-state ${read?'complete':''}">${statusLabel}</span><p>${esc(statusDetail)}</p></div><div class="reading-status-actions"><button class="secondary-action" id="toggleBookRead" type="button">Mark as ${read?'unread':'read'}</button>${b.read_override!=null?'<button class="text-button" id="clearBookRead" type="button">Use synced status</button>':''}</div></section>`;
  const coverManager=`<section class="book-cover-manager"><div class="section-heading compact"><div><p class="eyebrow">Cover manager</p><h3>Choose the edition you want to see</h3></div><span class="muted">${esc(coverSourceLabel(b.cover_source))}</span></div>${jobText?`<div class="cover-job ${b.cover_job?.state==='error'?'error':''}">${jobBusy?'<span class="job-spinner" aria-hidden="true"></span>':''}${esc(jobText)}</div>`:''}<div class="cover-manager-actions"><button class="secondary-action" id="findCoverCandidates" type="button">Find alternatives</button></div>${showCoverChoices&&candidates.length?`<div class="cover-choice-section"><h4>Online candidates</h4><div class="cover-option-grid">${candidates.map(c=>coverOption(c)).join('')}</div></div>`:''}${showCoverChoices&&history.length>1?`<div class="cover-choice-section"><h4>Cover history</h4><div class="cover-option-grid history">${history.map(c=>coverOption(c,{history:true})).join('')}</div></div>`:''}</section>`;
  $('#bookPage').innerHTML=`<article class="book-page"><aside><div class="cover book-page-cover">${coverMarkup(b)}</div><div class="cover-actions"><button class="secondary-action full" id="retryBookCover" ${jobBusy?'disabled':''}>${jobBusy?'Looking online…':'Find online replacement'}</button><button class="secondary-action full" id="uploadBookCover">Upload cover</button><input id="manualCoverInput" class="visually-hidden" type="file" accept="image/jpeg,image/png,image/webp,image/gif"></div></aside><div class="book-page-content"><p class="eyebrow">Book</p><h2>${esc(b.title)}</h2><p class="book-byline">${esc(b.authors||'Unknown author')}${b.series?' · '+esc(b.series):''}</p>${readControl}<div class="book-meta"><div><span>Document progress</span><strong>${p}%</strong></div><div><span>Reading time</span><strong>${fmtSeconds(b.total_read_time)}</strong></div><div><span>Highlights</span><strong>${Number(b.highlights||0)}</strong></div><div><span>Pages</span><strong>${Number(b.pages||0)}</strong></div><div><span>Language</span><strong>${esc(b.language||'—')}</strong></div><div><span>Cover</span><strong>${esc(coverSourceLabel(b.cover_source))}</strong></div></div>${coverManager}<section class="book-highlights"><div class="section-heading compact"><div><p class="eyebrow">Highlights</p><h3>Passages worth keeping</h3></div><span class="muted">${annotations.length?`${annotations.length} synced`:''}</span></div>${highlights}</section></div></article>`;
  const setRead=async value=>{try{await api(`/api/books/${encodeURIComponent(b.id)}/read`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({read:value})});toast(value===null?'Using synced reading status.':value?'Book marked as read.':'Book marked as unread.');await refresh();await openBook(b.id,{push:false})}catch(e){toast(e.message)}};
  $('#toggleBookRead')?.addEventListener('click',()=>setRead(!read));
  $('#clearBookRead')?.addEventListener('click',()=>setRead(null));
  $('#retryBookCover')?.addEventListener('click',async()=>{try{state.coverChooserBookId=null;await api(`/api/books/${encodeURIComponent(b.id)}/cover/retry`,{method:'POST'});toast('Online cover lookup queued.');pollBookCoverJob(b.id)}catch(e){toast(e.message)}});
  $('#findCoverCandidates')?.addEventListener('click',async e=>{const button=e.currentTarget;button.disabled=true;button.textContent='Searching catalogues…';try{const d=await api(`/api/books/${encodeURIComponent(b.id)}/cover/candidates`,{method:'POST'});state.coverChooserBookId=b.id;toast(d.candidates?.length?`Found ${d.candidates.length} cover option${d.candidates.length===1?'':'s'}.`:'No useful alternatives found.');await openBook(b.id,{push:false})}catch(error){toast(error.message);button.disabled=false;button.textContent='Find alternatives'}});
  $$('[data-cover-candidate]').forEach(button=>button.addEventListener('click',async()=>{try{await api(`/api/books/${encodeURIComponent(b.id)}/cover/candidates/${encodeURIComponent(button.dataset.coverCandidate)}`,{method:'PUT'});state.coverChooserBookId=null;toast('Cover selected.');await refresh();await openBook(b.id,{push:false})}catch(error){toast(error.message)}}));
  $$('[data-cover-history]').forEach(button=>button.addEventListener('click',async()=>{try{await api(`/api/books/${encodeURIComponent(b.id)}/cover/history/${encodeURIComponent(button.dataset.coverHistory)}`,{method:'PUT'});state.coverChooserBookId=null;toast('Previous cover restored.');await refresh();await openBook(b.id,{push:false})}catch(error){toast(error.message)}}));
  const coverInput=$('#manualCoverInput');
  $('#uploadBookCover')?.addEventListener('click',()=>coverInput?.click());
  coverInput?.addEventListener('change',async()=>{
    const file=coverInput.files?.[0];if(!file)return;
    if(file.size>4*1024*1024){coverInput.value='';return toast('Cover images must be 4 MB or smaller.')}
    try{await api(`/api/books/${encodeURIComponent(b.id)}/cover`,{method:'PUT',headers:{'Content-Type':file.type||'application/octet-stream','X-Kovi-Filename':file.name},body:file});state.coverChooserBookId=null;stopBookCoverPoll();toast('Cover uploaded.');await refresh();await openBook(b.id,{push:false})}catch(e){toast(e.message)}finally{coverInput.value=''}
  });
}

function routeFromLocation(){
  const book=/^\/books\/([^/]+)$/.exec(location.pathname);if(book)return openBook(decodeURIComponent(book[1]),{push:false});
  if(location.pathname==='/library')return switchView('library',{push:false});
  if(location.pathname==='/calendar')return switchView('calendar',{push:false});
  if(location.pathname==='/devices')return switchView('devices',{push:false});
  if(location.pathname==='/status')return switchView('status',{push:false});
  return switchView('home',{push:false});
}

$$('[data-view]').forEach(b=>b.addEventListener('click',()=>switchView(b.dataset.view)));
$$('[data-view-jump]').forEach(b=>b.addEventListener('click',()=>switchView(b.dataset.viewJump)));
$('[data-route-view]')?.addEventListener('click',e=>{e.preventDefault();switchView(e.currentTarget.dataset.routeView)});
$('#bookBack').addEventListener('click',()=>switchView('library'));
$('#calendarPrev').addEventListener('click',()=>moveCalendarMonth(-1));$('#calendarNext').addEventListener('click',()=>moveCalendarMonth(1));$('#calendarToday').addEventListener('click',()=>{state.calendarSelectedDay=localDateKey(new Date());loadCalendar(new Date(),state.calendarSelectedDay)});
$('#calendarDateForm').addEventListener('submit',e=>{e.preventDefault();const day=$('#calendarDateInput').value;if(!day)return toast('Choose a date to jump to.');jumpToCalendarDate(day)});
window.addEventListener('popstate',routeFromLocation);
let chartResizeTimer=null;window.addEventListener('resize',()=>{clearTimeout(chartResizeTimer);chartResizeTimer=setTimeout(()=>{if(state.dashboard?.range&&state.books.length&&$('#homeView').classList.contains('active')){renderHeatmap(state.dashboard.days||[],state.dashboard.range);renderLineChart(state.dashboard.days||[],state.dashboard.range,state.dashboard)}},120)});
document.addEventListener('click',e=>{
  const day=e.target.closest('.calendar-day');if(day){const key=day.dataset.day;if(state.calendar?.range&&(key<state.calendar.range.from||key>state.calendar.range.to))loadCalendar(parseLocalDateKey(key),key);else renderCalendarDetail(key);return}
  const calendarBook=e.target.closest('[data-calendar-book-id]');if(calendarBook){openBook(calendarBook.dataset.calendarBookId);return}
  const card=e.target.closest('.book-card');if(!card||!card.dataset.bookId)return;e.preventDefault();openBook(card.dataset.bookId)
});

$$('.range-button').forEach(button=>button.addEventListener('click',()=>{
  const key=button.dataset.range;
  if(key==='custom'){
    state.rangeKey='custom';$('#customRange').classList.remove('hidden');renderRangeUi(state.dashboard?.range||presetRange('year'));$('#customFrom').focus();return;
  }
  $('#customRange').classList.add('hidden');applyDashboardRange(key,presetRange(key));
}));
$('#customRange').addEventListener('submit',e=>{
  e.preventDefault();const from=$('#customFrom').value,to=$('#customTo').value;
  if(!from||!to)return toast('Choose both custom dates.');
  if(from>to)return toast('The start date must be before the end date.');
  applyDashboardRange('custom',{from,to});
});

const importDialog=$('#importDialog'),fileInput=$('#fileInput');
function openImport(){importDialog.showModal();$('#importResult').classList.add('hidden');$('#importProgress').classList.add('hidden')}
$('#importButton').addEventListener('click',openImport);$$('[data-open-import]').forEach(b=>b.addEventListener('click',openImport));fileInput.addEventListener('change',()=>fileInput.files[0]&&uploadFile(fileInput.files[0]));
const dz=$('#dropZone');['dragenter','dragover'].forEach(e=>dz.addEventListener(e,x=>{x.preventDefault();dz.classList.add('drag')}));['dragleave','drop'].forEach(e=>dz.addEventListener(e,x=>{x.preventDefault();dz.classList.remove('drag')}));dz.addEventListener('drop',e=>{const f=e.dataTransfer.files[0];if(f)uploadFile(f)});
async function ensureCsrf(force=false){if(state.csrf&&!force)return state.csrf;const session=await api('/api/session',{},false);state.csrf=session.csrf;return state.csrf}
async function uploadFile(file){
  const p=$('#importProgress'),bar=$('#progressBar'),txt=$('#progressText'),result=$('#importResult');p.classList.remove('hidden');result.classList.add('hidden');bar.style.width='8%';txt.textContent=`Preparing ${file.name}…`;
  const send=async(csrf,retried=false)=>{txt.textContent=`Uploading ${file.name}…`;const xhr=new XMLHttpRequest();xhr.open('PUT','/api/import/sqlite');xhr.setRequestHeader('Content-Type','application/vnd.sqlite3');xhr.setRequestHeader('X-Kovi-Filename',file.name);xhr.setRequestHeader('X-Kovi-CSRF',csrf);xhr.upload.onprogress=e=>{if(e.lengthComputable)bar.style.width=`${Math.max(8,Math.round(e.loaded/e.total*82))}%`};xhr.onload=async()=>{bar.style.width='100%';let data={};try{data=JSON.parse(xhr.responseText)}catch{};if(xhr.status===403&&!retried&&data.error==='Missing browser request token.'){try{bar.style.width='8%';const fresh=await ensureCsrf(true);return send(fresh,true)}catch(error){txt.textContent='Upload failed';result.classList.remove('hidden');result.textContent=error.message||'Could not refresh the browser session.';return}}if(xhr.status>=200&&xhr.status<300){txt.textContent='Import complete';result.classList.remove('hidden');result.innerHTML=`<strong>${esc(data.message||'Import complete.')}</strong><br>${data.booksSeen||0} books found · ${data.newBooks||0} new${data.excludedBooks?` · ${data.excludedBooks} KOReader manual excluded`:''}<br>${data.sessionsSeen||0} reading rows · ${data.newSessions||0} new${data.newBooks?'<br><span class="muted">Covers are being matched automatically.</span>':''}`;await refresh();setTimeout(refresh,3000)}else{txt.textContent='Import failed';result.classList.remove('hidden');result.textContent=data.error||'Upload failed.'}};xhr.onerror=()=>{txt.textContent='Upload failed';result.classList.remove('hidden');result.textContent='Could not reach kovi.'};xhr.send(file)};
  try{const csrf=await ensureCsrf(true);await send(csrf)}catch(error){txt.textContent='Upload failed';result.classList.remove('hidden');result.textContent=error.message||'Could not prepare the upload.'}
}

$('#bookSearch').addEventListener('input',e=>{state.libraryQuery=e.target.value;renderLibrary()});
$('#bookSort').addEventListener('change',e=>{state.librarySort=LIBRARY_SORTS.includes(e.target.value)?e.target.value:'recent';localStorage.setItem('kovi-library-sort',state.librarySort);renderLibrary()});
$('#bookFilter').addEventListener('change',e=>{state.libraryFilter=LIBRARY_FILTERS.includes(e.target.value)?e.target.value:'all';localStorage.setItem('kovi-library-filter',state.libraryFilter);renderLibrary()});
const pairOriginHint=$('#pairOriginHint');if(pairOriginHint){const h=location.hostname;pairOriginHint.textContent=(h==='localhost'||h==='127.0.0.1'||h==='0.0.0.0')?'You opened kovi locally, so use this computer’s LAN IP instead (for example http://192.168.1.23:3000).':`This page is at ${location.origin}; if your KOReader can reach that hostname/address, use it.`}
const pairDialog=$('#pairDialog');
function stopPairPoll(){if(state.pairPoll){clearTimeout(state.pairPoll);state.pairPoll=null}}
async function pollPairing(requestId){
  try{
    const status=await api(`/api/pairing-codes/${encodeURIComponent(requestId)}`);
    if(status.status==='paired'){stopPairPoll();$('#pairStatusText').textContent='Paired successfully.';await loadDevices();pairDialog.close();toast(`Paired ${status.device?.name||status.device?.model||'KOReader'} successfully.`);return}
    if(status.status==='expired'){stopPairPoll();$('#pairStatusText').textContent='This code expired. Generate another one.';return}
    state.pairPoll=setTimeout(()=>pollPairing(requestId),1500);
  }catch{state.pairPoll=setTimeout(()=>pollPairing(requestId),2500)}
}
$('#pairButton').addEventListener('click',()=>{stopPairPoll();pairDialog.showModal();$('#pairCodeBox').classList.add('hidden')});
pairDialog.addEventListener('close',stopPairPoll);
$('#generatePair').addEventListener('click',async()=>{try{stopPairPoll();const d=await api('/api/pairing-codes',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({label:$('#pairLabel').value})});$('#pairCode').textContent=d.code;$('#pairExpiry').textContent='Expires in 10 minutes · one use only';$('#pairStatusText').textContent='Waiting for your KOReader…';$('#pairCodeBox').classList.remove('hidden');pollPairing(d.requestId)}catch(e){toast(e.message)}});
async function loadDevices(){try{const d=await api('/api/devices');$('#deviceList').innerHTML=d.devices.map(x=>`<div class="device-row"><div class="device-id"><span class="device-icon">▤</span><div><div class="device-title-line"><strong>${esc(x.name||x.model||'KOReader')}</strong>${x.needs_update&&!x.revoked_at?'<span class="status-badge warning">Plugin update needed</span>':''}</div><div class="muted">${esc(x.model||x.id)} · plugin ${esc(x.plugin_version||'unknown')} · ${x.last_seen_at?'last synced '+new Date(x.last_seen_at).toLocaleString():'paired, not synced yet'}${x.revoked_at?' · revoked':''}</div>${x.needs_update&&!x.revoked_at?`<div class="device-warning">${x.supports_cover_sync?'':'Embedded covers and ISBN enrichment require plugin '+esc(x.min_cover_plugin_version)+'. '}${x.supports_incremental_sync?'':'Incremental statistics and annotation sync require plugin '+esc(x.min_incremental_plugin_version)+'. '}${x.plugin_version&&x.plugin_version!==x.latest_plugin_version?'Update to the current plugin for the latest sync improvements.':''} <a href="/kovi-plugin.zip">Download current plugin ${esc(x.latest_plugin_version)}</a>.</div>`:''}</div></div>${x.revoked_at?'':`<button class="danger" data-revoke="${esc(x.id)}">Revoke</button>`}</div>`).join('')||'<article class="panel"><p class="muted">No KOReader devices paired yet.</p></article>';$$('[data-revoke]').forEach(b=>b.addEventListener('click',async()=>{await api(`/api/devices/${encodeURIComponent(b.dataset.revoke)}/revoke`,{method:'POST'});toast('Device access revoked.');loadDevices()}))}catch(e){toast(e.message)}}

const fmtBytes=value=>{let n=Math.max(0,Number(value||0));const units=['B','KB','MB','GB'];let i=0;while(n>=1024&&i<units.length-1){n/=1024;i++}return `${n.toFixed(i?1:0)} ${units[i]}`};
function renderStatus(){
  const d=state.status;if(!d)return;const lib=d.library||{},storage=d.storage||{};
  $('#statusMetrics').innerHTML=[['Books',Number(lib.books||0).toLocaleString(),'in the local library'],['Sessions',Number(lib.sessions||0).toLocaleString(),'stored reading events'],['Highlights',Number(lib.annotations||0).toLocaleString(),'synced highlight/note records'],['Storage',fmtBytes(storage.total_bytes),'database + cover cache'],['Time zone',esc(d.time_zone||'UTC'),'dashboard and calendar dates']].map(x=>`<article class="metric"><span>${x[0]}</span><strong>${x[1]}</strong><small>${x[2]}</small></article>`).join('');
  $('#statusSyncs').innerHTML=(d.recentSyncs||[]).slice(0,3).map(x=>`<div class="status-row"><div><strong>${esc(x.device_name||x.device_model||'KOReader')}</strong><small>${new Date(x.created_at).toLocaleString()} · ${esc(x.mode)} sync · cursor ${Number(x.cursor_after||0).toLocaleString()}</small></div><span>${Number(x.new_sessions||0)} new / ${Number(x.sessions_seen||0)} sent<br><small>${Number(x.annotation_sets||0)} changed annotation book${Number(x.annotation_sets||0)===1?'':'s'}</small></span></div>`).join('')||'<p class="muted">No plugin syncs recorded yet.</p>';
  $('#statusImports').innerHTML=(d.recentImports||[]).slice(0,3).map(x=>`<div class="status-row"><div><strong>${esc(x.filename||x.kind||'Import')}</strong><small>${new Date(x.created_at).toLocaleString()} · ${fmtBytes(x.file_size)}</small></div><span>${Number(x.new_books||0)} new books<br><small>${Number(x.new_sessions||0)} new sessions${x.warnings?.length?` · ${x.warnings.length} warning${x.warnings.length===1?'':'s'}`:''}</small></span></div>`).join('')||'<p class="muted">No manual imports recorded yet.</p>';
}
async function loadStatus({feedback=false}={}){
  const button=$('#refreshStatus');const original=button?.textContent||'Refresh';
  if(button){button.disabled=true;button.textContent='Refreshing…'}
  try{
    state.status=await api(`/api/status?fresh=${Date.now()}`,{cache:'no-store'});renderStatus();
    if(feedback)toast(`Status refreshed at ${new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'})}.`);
  }catch(e){toast(e.message)}
  finally{if(button){button.disabled=false;button.textContent=original}}
}
$('#refreshStatus')?.addEventListener('click',()=>loadStatus({feedback:true}));

$('#retryCovers').addEventListener('click',async()=>{try{const d=await api('/api/covers/retry',{method:'POST'});toast(d.queued?`${d.queued} cover${d.queued===1?'':'s'} queued.`:'No missing covers to retry.');state.books.forEach(b=>{if(b.cover_status==='none'||b.cover_status==='error')b.cover_status='pending'});coverPoll=setTimeout(()=>refresh().catch(()=>{}),3000)}catch(e){toast(e.message)}});
function setTheme(dark){document.documentElement.classList.toggle('dark',dark);localStorage.setItem('kovi-theme',dark?'dark':'light');const meta=$('#themeColor');if(meta)meta.setAttribute('content',dark?'#0c1320':'#f6f3ec');const button=$('#themeButton');button.textContent=dark?'☀':'◐';button.setAttribute('aria-label',dark?'Switch to light theme':'Switch to dark theme');button.setAttribute('aria-pressed',String(dark))}
const savedTheme=localStorage.getItem('kovi-theme');setTheme(savedTheme==='dark'||(!savedTheme&&matchMedia('(prefers-color-scheme: dark)').matches));
$('#themeButton').addEventListener('click',()=>setTheme(!document.documentElement.classList.contains('dark')));

api('/api/session').then(s=>{state.csrf=s.csrf;return refresh()}).then(routeFromLocation).catch(e=>toast(e.message));
