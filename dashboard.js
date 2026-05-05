/* ═══════════════════════════════════════════════════════════════
   STRAVA DASHBOARD  ·  dashboard.js
   Loads strava_full_data.csv via d3.csv() — no hardcoded data.

   MATH NOTES
   ──────────
   distance_km  = CSV "distance" (metres) ÷ 1000
   moving_time_s= "H:MM:SS" string → total seconds
   pace (min/km) = moving_time_s ÷ 60 ÷ distance_km
   speed (km/h)  = avg_speed (m/s from CSV) × 3.6
   elevation     = "total_elevation_gain" in metres (direct)

   Outliers are the literal max/min across the filtered set —
   no statistical model, just direct comparisons so the user
   always sees real records from their own data.
═══════════════════════════════════════════════════════════════ */

// ── TYPE METADATA ─────────────────────────────────────────────────────────────
const TYPES = {
  Run:            { label:'Run',           emoji:'🏃',  color:'#e8390e', mode:'pace'  },
  Ride:           { label:'Ride',          emoji:'🚴',  color:'#0080e8', mode:'speed' },
  Hike:           { label:'Hike',          emoji:'🥾',  color:'#22a84a', mode:'pace'  },
  Swim:           { label:'Swim',          emoji:'🏊',  color:'#6c3be8', mode:'pace'  },
  WeightTraining: { label:'Weights',       emoji:'🏋️',  color:'#e89400', mode:'none'  },
  Yoga:           { label:'Yoga',          emoji:'🧘',  color:'#e83b8a', mode:'none'  },
  AlpineSki:      { label:'Ski',           emoji:'⛷️',  color:'#00c0e8', mode:'speed' },
  RockClimbing:   { label:'Climb',         emoji:'🧗',  color:'#c47c0e', mode:'none'  },
  Walk:           { label:'Walk',          emoji:'🚶',  color:'#50aa28', mode:'pace'  },
};

function meta(t)  { return TYPES[t] || { label:t, emoji:'🏅', color:'#888', mode:'none' }; }
function color(t) { return meta(t).color; }

// ── STATE ─────────────────────────────────────────────────────────────────────
let RAW          = [];   // parsed rows from CSV
let selType      = 'Run';
let selYear      = 'all';
let elevMin      = 0;
let elevMax      = 600;
let brushRange   = null; // [monthStr, monthStr] or null
let compareTypes = [];   // additional types overlaid on charts
let brushOn      = true;
let goalPaceVal  = null; // draggable goal line (in paceVal units)

// ── HELPERS ───────────────────────────────────────────────────────────────────
function hhmmss(str) {
  // "H:MM:SS" or "M:SS" → seconds
  if (!str) return 0;
  const p = str.split(':').map(Number);
  if (p.length === 3) return p[0]*3600 + p[1]*60 + p[2];
  if (p.length === 2) return p[0]*60  + p[1];
  return 0;
}
function fmtPace(secPerKm) {
  const m = Math.floor(secPerKm/60), s = Math.round(secPerKm%60);
  return `${m}:${String(s).padStart(2,'0')}`;
}
function fmtTime(s) {
  const h = Math.floor(s/3600), m = Math.floor((s%3600)/60);
  return h ? `${h}h ${m}m` : `${m}m`;
}
function fmtKm(v) { return v.toFixed(1)+' km'; }

// ── FILTERING ─────────────────────────────────────────────────────────────────
function applyFilters(typeOverride) {
  const t = typeOverride || selType;
  return RAW.filter(a => {
    if (a.type !== t) return false;
    if (selYear !== 'all' && a.year !== +selYear) return false;
    if (a.elevation < elevMin || a.elevation > elevMax) return false;
    if (brushRange) {
      if (a.month < brushRange[0] || a.month > brushRange[1]) return false;
    }
    return true;
  });
}

// ── CSS VAR ACCENT ────────────────────────────────────────────────────────────
function applyAccent(t) {
  const c = color(t);
  const r = parseInt(c.slice(1,3),16), g = parseInt(c.slice(3,5),16), b = parseInt(c.slice(5,7),16);
  document.documentElement.style.setProperty('--accent',    c);
  document.documentElement.style.setProperty('--accent10', `rgba(${r},${g},${b},.10)`);
  document.documentElement.style.setProperty('--accent25', `rgba(${r},${g},${b},.25)`);
}

// ── TOOLTIP ───────────────────────────────────────────────────────────────────
const tooltip = document.getElementById('tooltip');
function tip(e, date, val, sub) {
  tooltip.classList.add('show');
  document.getElementById('ttDate').textContent = date||'';
  document.getElementById('ttVal' ).textContent = val ||'';
  document.getElementById('ttSub' ).textContent = sub ||'';
  tooltip.style.left = (e.clientX+16)+'px';
  tooltip.style.top  = (e.clientY-12)+'px';
}
function tipMove(e) {
  tooltip.style.left = (e.clientX+16)+'px';
  tooltip.style.top  = (e.clientY-12)+'px';
}
function tipHide() { tooltip.classList.remove('show'); }

// ── CSV LOAD & PARSE ──────────────────────────────────────────────────────────
function loadCSV() {
  d3.csv('strava_full_data.csv').then(rows => {
    RAW = rows.flatMap(r => {
      const distKm   = +r.distance / 1000;
      const movingS  = hhmmss(r.moving_time);
      const dateStr  = (r.start_date_local||'').slice(0,10);
      if (!dateStr || !distKm && r.type==='Run') return [];
      const year   = +dateStr.slice(0,4);
      const month  = dateStr.slice(0,7);
      const pace   = distKm>0 && movingS>0 ? movingS/60/distKm : null;
      const speed  = +(r.average_speed||0)*3.6; // km/h
      return [{
        date:      dateStr,
        year,
        month,
        type:      r.type,
        dist:      +distKm.toFixed(3),
        movingS,
        elapsedS:  hhmmss(r.elapsed_time),
        elevation: +(r.total_elevation_gain||0),
        elevHigh:  +(r.elev_high||0),
        speed,           // km/h
        avgHR:     r.average_heartrate ? +r.average_heartrate : null,
        kudos:     +(r.kudos_count||0),
        // pace only valid if reasonable (2–30 min/km for runs; skip outlier GPS errors)
        pace:      pace && pace>1.5 && pace<35 ? +pace.toFixed(3) : null,
      }];
    });
    boot();
  }).catch(err => {
    document.getElementById('loader').innerHTML = `
      <div style="max-width:420px;text-align:center;padding:32px">
        <div style="font-size:2rem;margin-bottom:12px">⚠️</div>
        <p style="font-family:'JetBrains Mono',monospace;font-size:11px;color:#c00;line-height:1.7">
          Could not load <strong>strava_full_data.csv</strong><br><br>
          Make sure <code>index.html</code>, <code>style.css</code>,
          <code>dashboard.js</code>, and <code>strava_full_data.csv</code>
          are all in the <em>same folder</em> and you're serving via a
          local server:<br><br>
          <code>python3 -m http.server 8080</code>
        </p>
        <p style="font-family:'JetBrains Mono',monospace;font-size:9px;color:#888;margin-top:16px">${err.message}</p>
      </div>`;
  });
}

// ── BOOT ──────────────────────────────────────────────────────────────────────
function boot() {
  // Determine best default type (most records)
  const counts = {};
  RAW.forEach(a => { counts[a.type] = (counts[a.type]||0)+1; });
  selType = Object.entries(counts).sort((a,b)=>b[1]-a[1])[0]?.[0] || 'Run';

  applyAccent(selType);
  buildSidebar(counts);
  buildYearPills();
  buildComparePills(counts);
  wireElevSliders();
  wireBrushControls();
  wireDrillClose();

  const loader = document.getElementById('loader');
  loader.classList.add('fade-out');
  const app = document.getElementById('app');
  app.classList.remove('app-hidden');
  setTimeout(() => { app.classList.add('visible'); loader.style.display='none'; }, 350);

  render();
  window.addEventListener('resize', render);
}

// ── SIDEBAR ───────────────────────────────────────────────────────────────────
function buildSidebar(counts) {
  const nav   = document.getElementById('sidebar');
  const order = ['Run','Ride','Hike','Swim','WeightTraining','Yoga','AlpineSki','RockClimbing','Walk'];
  const types = [...order, ...Object.keys(counts).filter(t=>!order.includes(t))].filter(t=>counts[t]);

  types.forEach(t => {
    const m   = meta(t);
    const btn = document.createElement('button');
    btn.className   = `act-btn${t===selType?' is-active':''}`;
    btn.dataset.type = t;
    btn.style.setProperty('--accent', m.color);
    btn.innerHTML   = `
      <span class="act-emoji">${m.emoji}</span>
      <span class="act-label">${m.label}</span>
      <span class="act-count">${counts[t]}</span>`;
    btn.addEventListener('click', () => {
      selType    = t;
      goalPaceVal= null;
      applyAccent(t);
      nav.querySelectorAll('.act-btn').forEach(b => {
        b.classList.toggle('is-active', b.dataset.type===t);
        b.style.setProperty('--accent', meta(b.dataset.type).color);
      });
      render();
    });
    nav.appendChild(btn);
  });
}

// ── YEAR PILLS ────────────────────────────────────────────────────────────────
function buildYearPills() {
  const years = ['all', ...[...new Set(RAW.map(a=>a.year))].sort()];
  const row   = document.getElementById('yearPills');
  years.forEach(y => {
    const b = document.createElement('button');
    b.className   = `pill${y==='all'?' on':''}`;
    b.textContent = y==='all' ? 'ALL' : y;
    b.addEventListener('click', () => {
      selYear    = String(y);
      brushRange = null;
      document.getElementById('brushClear').classList.add('ctrl-hidden');
      row.querySelectorAll('.pill').forEach(p=>p.classList.toggle('on', p.textContent===b.textContent));
      render();
    });
    row.appendChild(b);
  });
}

// ── COMPARE PILLS ─────────────────────────────────────────────────────────────
function buildComparePills(counts) {
  const row   = document.getElementById('comparePills');
  const order = ['Run','Ride','Hike','Swim'];
  const types = order.filter(t=>counts[t]);
  types.forEach(t => {
    const m = meta(t);
    const b = document.createElement('button');
    b.className      = 'pill compare-pill';
    b.dataset.type   = t;
    b.innerHTML      = `${m.emoji} ${m.label}`;
    b.style.setProperty('--cmp-color', m.color);
    b.addEventListener('click', () => {
      if (t===selType) return; // can't compare against self
      const idx = compareTypes.indexOf(t);
      if (idx===-1) { compareTypes.push(t); b.classList.add('on'); b.style.background=m.color; b.style.borderColor=m.color; }
      else { compareTypes.splice(idx,1); b.classList.remove('on'); b.style.background=''; b.style.borderColor=''; }
      render();
    });
    row.appendChild(b);
  });
}

// ── ELEVATION SLIDERS ─────────────────────────────────────────────────────────
function wireElevSliders() {
  const minIn  = document.getElementById('elevMin');
  const maxIn  = document.getElementById('elevMax');
  const minLbl = document.getElementById('elevMinLabel');
  const maxLbl = document.getElementById('elevMaxLabel');
  minIn.addEventListener('input', () => {
    elevMin = +minIn.value;
    minLbl.textContent = elevMin + ' m';
    render();
  });
  maxIn.addEventListener('input', () => {
    elevMax = +maxIn.value;
    maxLbl.textContent = elevMax>=600 ? '600+ m' : elevMax+' m';
    render();
  });
}

// ── BRUSH CONTROLS ────────────────────────────────────────────────────────────
function wireBrushControls() {
  const btn   = document.getElementById('brushBtn');
  const clear = document.getElementById('brushClear');
  btn.addEventListener('click', () => {
    brushOn = !brushOn;
    btn.classList.toggle('on', brushOn);
    btn.textContent = brushOn ? 'ON' : 'OFF';
    if (!brushOn) { brushRange=null; clear.classList.add('ctrl-hidden'); render(); }
  });
  clear.addEventListener('click', () => {
    brushRange = null;
    clear.classList.add('ctrl-hidden');
    render();
  });
}

// ── DRILL CLOSE ───────────────────────────────────────────────────────────────
function wireDrillClose() {
  document.getElementById('drillClose').addEventListener('click', () => {
    document.getElementById('drillOverlay').classList.add('drill-hidden');
  });
}
function openDrill(month, acts) {
  const ov = document.getElementById('drillOverlay');
  ov.classList.remove('drill-hidden');
  document.getElementById('drillTitle').textContent =
    new Date(month+'-02').toLocaleString('default',{month:'long',year:'numeric'}).toUpperCase();
  document.getElementById('drillMeta').textContent  =
    `${acts.length} activities · ${acts.reduce((s,a)=>s+a.dist,0).toFixed(1)} km`;
  renderDrillChart(acts);
}

// ── HEADER KPIs ───────────────────────────────────────────────────────────────
function renderKpis(acts) {
  const totalDist = acts.reduce((s,a)=>s+a.dist,0);
  const totalTime = acts.reduce((s,a)=>s+a.movingS,0);
  const totalElev = acts.reduce((s,a)=>s+a.elevation,0);
  document.getElementById('headerKpis').innerHTML = `
    <div class="kpi"><div class="kpi-val">${acts.length}</div><div class="kpi-lbl">Activities</div></div>
    <div class="kpi"><div class="kpi-val">${totalDist.toFixed(0)}</div><div class="kpi-lbl">km total</div></div>
    <div class="kpi"><div class="kpi-val">${fmtTime(totalTime)}</div><div class="kpi-lbl">Moving time</div></div>
    <div class="kpi"><div class="kpi-val">${(totalElev/1000).toFixed(1)}</div><div class="kpi-lbl">km climbed</div></div>`;
}

// ═══════════════════════════════════════════════════════════════
//  CHART 1 — DISTANCE OVER TIME  (bar chart + brush + compare)
//  Math: group activities by month → sum distance_km per month.
//  Bar colour = activity accent; max bar is full opacity,
//  others 60 %; min bar uses a blue tint so it stands out.
// ═══════════════════════════════════════════════════════════════
function renderDistChart(acts) {
  const wrap = document.getElementById('cwDist');
  const W = wrap.clientWidth, H = wrap.clientHeight;
  if (W<10||H<10) return;
  const mg = {top:8,right:10,bottom:24,left:42};

  d3.select('#svgDist').selectAll('*').remove();
  const svg = d3.select('#svgDist').attr('width',W).attr('height',H);

  // Monthly aggregation helper
  function byMonth(data) {
    const map = {};
    data.forEach(a => {
      if (!map[a.month]) map[a.month] = {month:a.month, dist:0, count:0, acts:[]};
      map[a.month].dist  += a.dist;
      map[a.month].count++;
      map[a.month].acts.push(a);
    });
    return Object.values(map).sort((a,b)=>a.month.localeCompare(b.month));
  }

  const primary = byMonth(acts);
  const compData = compareTypes.map(t => ({ type:t, months: byMonth(applyFilters(t)) }));

  document.getElementById('distMeta').textContent =
    primary.length ? `${acts.reduce((s,a)=>s+a.dist,0).toFixed(0)} km` : '';

  if (!primary.length) {
    svg.append('text').attr('x',W/2).attr('y',H/2).attr('text-anchor','middle')
       .attr('fill','#bbb').attr('font-size','11px').text('No activities match filters');
    return;
  }

  // Build unified month domain (primary + compare types)
  const allMonths = [...new Set([
    ...primary.map(d=>d.month),
    ...compData.flatMap(c=>c.months.map(d=>d.month))
  ])].sort();

  const allDists = [...primary.map(d=>d.dist), ...compData.flatMap(c=>c.months.map(d=>d.dist))];

  const numTypes   = 1 + compData.length;
  const x          = d3.scaleBand().domain(allMonths).range([mg.left,W-mg.right]).padding(numTypes>1?.10:.18);
  const subBW      = x.bandwidth()/numTypes;
  const y          = d3.scaleLinear().domain([0, d3.max(allDists)*1.15||10]).range([H-mg.bottom,mg.top]);

  // Grid lines
  svg.append('g').selectAll('line').data(y.ticks(4)).join('line')
    .attr('class','grid-line')
    .attr('x1',mg.left).attr('x2',W-mg.right)
    .attr('y1',d=>y(d)).attr('y2',d=>y(d));

  // Primary max/min for visual emphasis
  const maxDist = d3.max(primary,d=>d.dist);
  const minDist = d3.min(primary,d=>d.dist);

  // Draw primary bars
  svg.selectAll('rect.bar-p').data(primary).join('rect').attr('class','bar-p')
    .attr('x',       d=>x(d.month))
    .attr('y',       d=>y(d.dist))
    .attr('width',   subBW)
    .attr('height',  d=>Math.max(0,y(0)-y(d.dist)))
    .attr('rx', 2)
    .attr('fill',    d=> d.dist===minDist ? '#0080e8' : color(selType))
    .attr('opacity', d=>(d.dist===maxDist||d.dist===minDist) ? 1 : 0.62)
    .style('cursor','pointer')
    .on('mouseover',(e,d)=>tip(e,d.month,`${d.dist.toFixed(1)} km`,`${d.count} ${selType.toLowerCase()}s`))
    .on('mousemove', tipMove)
    .on('mouseleave',tipHide)
    .on('click',(e,d)=>openDrill(d.month,d.acts));

  // Compare bars
  compData.forEach((cd,ci) => {
    const cMaxDist = d3.max(cd.months,d=>d.dist)||1;
    svg.selectAll(`rect.bar-c${ci}`).data(cd.months).join('rect').attr('class',`bar-c${ci}`)
      .attr('x',      d=>x(d.month)+(ci+1)*subBW)
      .attr('y',      d=>y(d.dist))
      .attr('width',  subBW)
      .attr('height', d=>Math.max(0,y(0)-y(d.dist)))
      .attr('rx', 2)
      .attr('fill',   color(cd.type))
      .attr('opacity',d=>d.dist===cMaxDist?1:0.55)
      .on('mouseover',(e,d)=>tip(e,d.month,`${d.dist.toFixed(1)} km`,`${d.count} ${cd.type.toLowerCase()}s`))
      .on('mousemove', tipMove)
      .on('mouseleave',tipHide);
  });

  // Year-label x-axis
  const yearTicks = allMonths.filter(m=>m.endsWith('-01'));
  svg.append('g').attr('class','axis')
    .attr('transform',`translate(0,${H-mg.bottom})`)
    .call(d3.axisBottom(x).tickValues(yearTicks).tickFormat(d=>d.slice(0,4)).tickSize(0))
    .call(g=>g.select('.domain').remove());

  // Y axis
  svg.append('g').attr('class','axis')
    .attr('transform',`translate(${mg.left},0)`)
    .call(d3.axisLeft(y).ticks(4).tickFormat(d=>d+'km').tickSize(0))
    .call(g=>g.select('.domain').remove());

  // ── BRUSH ─────────────────────────────────────────────────────────────────
  // User drags a horizontal selection over the bar chart.
  // On brush end we map the pixel range to month strings and store
  // them in brushRange, which applyFilters() uses.
  if (brushOn) {
    const brush = d3.brushX()
      .extent([[mg.left,mg.top],[W-mg.right,H-mg.bottom]])
      .on('end', ({selection}) => {
        if (!selection) return;
        const [px0, px1] = selection;
        const inRange = allMonths.filter(mo => {
          const bx = x(mo);
          return bx+x.bandwidth()>=px0 && bx<=px1;
        });
        if (inRange.length) {
          brushRange = [inRange[0], inRange[inRange.length-1]];
          document.getElementById('brushClear').classList.remove('ctrl-hidden');
          document.getElementById('brushRangeLabel').textContent = `${brushRange[0]} → ${brushRange[1]}`;
          render();
        }
      });

    const bGroup = svg.append('g').attr('class','brush').call(brush);

    // Re-apply brush selection visually if range already set
    if (brushRange) {
      const x0 = x(brushRange[0]) ?? mg.left;
      const x1 = (x(brushRange[1]) ?? W-mg.right) + x.bandwidth();
      bGroup.call(brush.move, [x0, x1]);
    }
  }

  if (!brushRange) document.getElementById('brushRangeLabel').textContent = '';
}

// ═══════════════════════════════════════════════════════════════
//  CHART 2 — PACE / SPEED  (line + area + draggable goal line)
//
//  PACE (run/hike/swim/walk):
//    paceVal = moving_time_s ÷ 60 ÷ distance_km  (min/km)
//    Lower = faster, so y-axis is inverted visually:
//    the best (lowest) pace appears at the TOP.
//
//  SPEED (ride/ski):
//    paceVal = average_speed × 3.6  (m/s → km/h)
//    Higher = faster → y-axis is NOT inverted.
//
//  Goal line:
//    Initialised to the mean pace of the visible set.
//    User drags it; we count how many activities beat the goal
//    and display that fraction live.
// ═══════════════════════════════════════════════════════════════
function renderPaceChart(acts) {
  const wrap = document.getElementById('cwPace');
  const W = wrap.clientWidth, H = wrap.clientHeight;
  if (W<10||H<10) return;
  const mg = {top:12,right:28,bottom:24,left:46};

  d3.select('#svgPace').selectAll('*').remove();
  const svg = d3.select('#svgPace').attr('width',W).attr('height',H);

  const m       = meta(selType);
  const isSpeed = m.mode==='speed';
  const isNone  = m.mode==='none';

  // Legend
  const legendEl = document.getElementById('paceLegend');
  legendEl.innerHTML = '';
  function addLeg(c,label,dashed) {
    const d = document.createElement('div');
    d.className = 'leg';
    d.innerHTML = dashed
      ? `<svg width="16" height="6"><line x1="0" y1="3" x2="16" y2="3" stroke="${c}" stroke-width="1.5" stroke-dasharray="4,2"/></svg>${label}`
      : `<div class="leg-swatch" style="background:${c}"></div>${label}`;
    legendEl.appendChild(d);
  }
  addLeg(color(selType), isSpeed?'Speed (km/h)':'Pace (min/km)');
  addLeg('#22a84a','Avg',true);
  compareTypes.forEach(t=>addLeg(color(t),(meta(t).label||t)+' (cmp)',true));
  const goalLeg = document.createElement('div');
  goalLeg.className='leg';
  goalLeg.style.marginLeft='auto';
  goalLeg.innerHTML=`<span style="font-size:8px;color:var(--muted)">↕ drag goal line</span>`;
  legendEl.appendChild(goalLeg);

  // Update title
  document.getElementById('paceTitle').textContent = isSpeed ? 'SPEED OVER TIME' : 'PACE OVER TIME';

  if (isNone) {
    svg.append('text').attr('x',W/2).attr('y',H/2).attr('text-anchor','middle')
       .attr('fill','#bbb').attr('font-size','11px').text('No pace / speed data for this activity type');
    return;
  }

  // Build pace data series
  function paceDataFor(data) {
    return data
      .filter(a=>a.dist>0 && a.movingS>60)
      .map(a=>({ ...a, pv: isSpeed ? a.speed : a.movingS/60/a.dist }))
      .filter(a=> isSpeed ? (a.pv>2&&a.pv<120) : (a.pv>1.5&&a.pv<30))
      .sort((a,b)=>a.date.localeCompare(b.date));
  }

  const pd       = paceDataFor(acts);
  const cmpSeries= compareTypes
    .map(t=>({ type:t, data:paceDataFor(applyFilters(t)) }))
    .filter(c=>(meta(c.type).mode!=='none'));

  if (!pd.length) {
    svg.append('text').attr('x',W/2).attr('y',H/2).attr('text-anchor','middle')
       .attr('fill','#bbb').attr('font-size','11px').text('No data in this range');
    return;
  }

  const allPV  = [...pd.map(d=>d.pv),...cmpSeries.flatMap(c=>c.data.map(d=>d.pv))];
  const pvMin  = d3.min(allPV)*0.93;
  const pvMax  = d3.max(allPV)*1.07;
  const pvMean = d3.mean(pd,d=>d.pv);

  // For pace: lower is better → put low values at top (invert y domain).
  // For speed: higher is better → normal.
  const yDom = isSpeed ? [pvMin, pvMax] : [pvMax, pvMin];

  const x   = d3.scalePoint().domain(pd.map((_,i)=>i)).range([mg.left,W-mg.right]).padding(0.5);
  const y   = d3.scaleLinear().domain(yDom).range([H-mg.bottom,mg.top]);

  // Grid
  svg.append('g').selectAll('line').data(y.ticks(4)).join('line')
    .attr('class','grid-line')
    .attr('x1',mg.left).attr('x2',W-mg.right)
    .attr('y1',d=>y(d)).attr('y2',d=>y(d));

  // Draw a series (line + area)
  function drawSeries(data, col, opacity, dashed) {
    // data must already be sorted by date and have .pv
    // Use its own x-scale if it's a compare series (different N)
    const xS = d3.scalePoint().domain(data.map((_,i)=>i)).range([mg.left,W-mg.right]).padding(.5);
    const lineGen = d3.line().x((_,i)=>xS(i)).y(d=>y(d.pv)).curve(d3.curveCatmullRom);
    const areaGen = d3.area().x((_,i)=>xS(i)).y0(H-mg.bottom).y1(d=>y(d.pv)).curve(d3.curveCatmullRom);

    const gid = 'g'+col.replace(/[^a-z0-9]/gi,'');
    const gr  = svg.append('defs').append('linearGradient').attr('id',gid).attr('x1','0').attr('y1','0').attr('x2','0').attr('y2','1');
    gr.append('stop').attr('offset','0%').attr('stop-color',col).attr('stop-opacity',.18);
    gr.append('stop').attr('offset','100%').attr('stop-color',col).attr('stop-opacity',0);

    if (!dashed) svg.append('path').datum(data).attr('d',areaGen).attr('fill',`url(#${gid})`);
    svg.append('path').datum(data).attr('d',lineGen).attr('fill','none')
       .attr('stroke',col).attr('stroke-width',1.8).attr('opacity',opacity)
       .attr('stroke-dasharray', dashed?'5,3':null);
  }

  // Compare series first (behind primary)
  cmpSeries.forEach(c=>drawSeries(c.data, color(c.type), .5, true));
  // Primary
  drawSeries(pd, color(selType), .85, false);

  // Avg line
  svg.append('line').attr('class','grid-line')
    .attr('x1',mg.left).attr('x2',W-mg.right).attr('y1',y(pvMean)).attr('y2',y(pvMean))
    .attr('stroke','#22a84a').attr('stroke-width',1.2).attr('stroke-dasharray','5,3').attr('opacity',.7);
  svg.append('text').attr('x',W-mg.right+3).attr('y',y(pvMean)+3)
    .attr('fill','#22a84a').attr('font-size','8px').text('avg');

  // Min / max markers
  const maxPV = d3.max(pd,d=>d.pv), maxAct = pd.find(d=>d.pv===maxPV);
  const minPV = d3.min(pd,d=>d.pv), minAct = pd.find(d=>d.pv===minPV);
  const maxIdx= pd.indexOf(maxAct), minIdx= pd.indexOf(minAct);

  // For pace: max pv = SLOWEST (badge ▼), min pv = FASTEST (badge ▲)
  // For speed: max pv = FASTEST, min pv = SLOWEST
  const [fastIdx,fastAct,slowIdx,slowAct] = isSpeed
    ? [maxIdx,maxAct,minIdx,minAct]
    : [minIdx,minAct,maxIdx,maxAct];

  [[fastIdx,'#e8390e','▲'],[slowIdx,'#0080e8','▼']].forEach(([idx,col,sym])=>{
    if (idx<0) return;
    svg.append('circle').attr('cx',x(idx)).attr('cy',y(pd[idx].pv)).attr('r',5)
       .attr('fill',col).attr('stroke','#fff').attr('stroke-width',1.5);
    svg.append('text').attr('x',x(idx)).attr('y',y(pd[idx].pv)-8)
       .attr('text-anchor','middle').attr('fill',col).attr('font-size','8px').text(sym);
  });

  // Dots (hover layer)
  svg.selectAll('circle.dot').data(pd).join('circle').attr('class','dot')
    .attr('cx',(_,i)=>x(i)).attr('cy',d=>y(d.pv))
    .attr('r',3).attr('fill',color(selType)).attr('opacity',.4)
    .on('mouseover',(e,d)=>{
      const label = isSpeed ? `${d.pv.toFixed(1)} km/h` : `${fmtPace(d.pv*60)}/km`;
      tip(e, d.date, label, `${fmtKm(d.dist)} · ${fmtTime(d.movingS)}`);
    })
    .on('mousemove',tipMove).on('mouseleave',tipHide);

  // ── DRAGGABLE GOAL LINE ─────────────────────────────────────────────────────
  // goalPaceVal stores the current position (in paceVal units).
  // Drag uses d3.drag on an invisible fat rect over the line area.
  // On each drag we clamp to [pvMin,pvMax], recompute beat-count,
  // and redraw only the goal group — no full render() call needed.
  if (goalPaceVal===null) goalPaceVal = pvMean;
  goalPaceVal = Math.max(Math.min(goalPaceVal, pvMax), pvMin);

  const goalG = svg.append('g');

  function beatCount(gv) {
    // "beats goal" = faster
    return isSpeed
      ? pd.filter(a=>a.pv>=gv).length   // higher speed = beats
      : pd.filter(a=>a.pv<=gv).length;  // lower pace  = beats
  }

  function drawGoal(gv) {
    goalG.selectAll('*').remove();
    const gy = y(gv);
    goalG.append('line').attr('class','goal-line')
      .attr('x1',mg.left).attr('x2',W-mg.right).attr('y1',gy).attr('y2',gy);
    const labelStr = isSpeed ? `Goal: ${gv.toFixed(1)} km/h` : `Goal: ${fmtPace(gv*60)}/km`;
    goalG.append('text').attr('class','goal-label').attr('x',mg.left+4).attr('y',gy-4).text(labelStr);
    const bc = beatCount(gv);
    goalG.append('text').attr('class','goal-label').attr('text-anchor','end')
      .attr('x',W-mg.right-2).attr('y',gy-4).text(`${bc}/${pd.length} beat goal`);
    // Invisible drag target (wide hit area)
    goalG.append('rect')
      .attr('x',mg.left).attr('y',gy-10)
      .attr('width',W-mg.left-mg.right).attr('height',20)
      .attr('fill','transparent').style('cursor','ns-resize')
      .call(d3.drag().on('drag', ev => {
        goalPaceVal = Math.max(Math.min(y.invert(ev.y), pvMax), pvMin);
        drawGoal(goalPaceVal);
      }));
  }

  drawGoal(goalPaceVal);

  // Y axis
  svg.append('g').attr('class','axis').attr('transform',`translate(${mg.left},0)`)
    .call(d3.axisLeft(y).ticks(4).tickFormat(d=>{
      if (isSpeed) return d.toFixed(0)+'km/h';
      return `${Math.floor(d)}:${String(Math.round((d%1)*60)).padStart(2,'0')}`;
    }).tickSize(0))
    .call(g=>g.select('.domain').remove());
}

// ═══════════════════════════════════════════════════════════════
//  PANEL 3 — STATS / OUTLIERS / FREQUENCY
//
//  All outliers are simple max/min across the filtered set:
//    maxDist  = Math.max(...dists)          → longest activity
//    minDist  = Math.min(...dists)          → shortest
//    maxTime  = Math.max(...movingS values) → longest session
//    minTime  = Math.min(...movingS values) → quickest
//    maxElev  = Math.max(...elevation)      → most climbing
//    minPace  = Math.min(...valid paces)    → fastest pace
//    maxPace  = Math.max(...valid paces)    → slowest pace
//
//  Frequency bars: activity count per year, bars scale to peak.
// ═══════════════════════════════════════════════════════════════
function renderStats(acts) {
  const cont  = document.getElementById('statsContent');
  const c     = color(selType);

  if (!acts.length) {
    cont.innerHTML = '<div class="empty-state">No activities match filters</div>';
    return;
  }

  const dists  = acts.map(a=>a.dist).filter(d=>d>0);
  const times  = acts.map(a=>a.movingS).filter(t=>t>0);
  const elevs  = acts.map(a=>a.elevation);

  const maxD=Math.max(...dists), minD=Math.min(...dists), avgD=dists.reduce((a,b)=>a+b,0)/dists.length;
  const maxT=Math.max(...times), minT=Math.min(...times);
  const maxE=Math.max(...elevs);

  const maxDAct = acts.find(a=>a.dist===maxD);
  const minDAct = acts.find(a=>a.dist===minD);
  const maxTAct = acts.find(a=>a.movingS===maxT);
  const minTAct = acts.find(a=>a.movingS===minT);
  const maxEAct = acts.find(a=>a.elevation===maxE);

  const byYear = {};
  acts.forEach(a=>{ byYear[a.year]=(byYear[a.year]||0)+1; });
  const [peakYr,peakCnt] = Object.entries(byYear).sort((a,b)=>b[1]-a[1])[0]||['—',0];

  const hasPace = !['WeightTraining','Yoga','RockClimbing'].includes(selType);
  let fastAct=null, slowAct=null;
  if (hasPace) {
    const valid = acts.filter(a=>a.pace && a.pace>1.5 && a.pace<30);
    if (valid.length) {
      const minP=Math.min(...valid.map(a=>a.pace)), maxP=Math.max(...valid.map(a=>a.pace));
      fastAct = valid.find(a=>a.pace===minP);
      slowAct = valid.find(a=>a.pace===maxP);
    }
  }

  // Stat cards
  const cards = [
    { l:'Total',        v:acts.length,          s:'activities',   hi:false },
    { l:'Avg dist',     v:fmtKm(avgD),          s:'per activity', hi:false },
    { l:'Longest',      v:fmtKm(maxD),          s:maxDAct?.date||'', hi:true },
    { l:'Best year',    v:peakYr,                s:peakCnt+' acts',  hi:true },
  ];

  // Outlier tags
  const outs = [];
  if (maxDAct)  outs.push({icon:'📏',lbl:'Longest',   val:fmtKm(maxD),            date:maxDAct.date,  col:c});
  if (minDAct)  outs.push({icon:'📐',lbl:'Shortest',  val:fmtKm(minD),            date:minDAct.date,  col:'#0080e8'});
  if (maxTAct)  outs.push({icon:'⏱',lbl:'Max time',  val:fmtTime(maxT),          date:maxTAct.date,  col:'#22a84a'});
  if (minTAct)  outs.push({icon:'⚡',lbl:'Quickest',  val:fmtTime(minT),          date:minTAct.date,  col:'#e89400'});
  if (maxEAct && maxE>0) outs.push({icon:'⛰',lbl:'Most climb', val:maxE.toFixed(0)+' m', date:maxEAct.date, col:'#c47c0e'});
  if (fastAct)  outs.push({icon:'🚀',lbl:'Fastest',   val:fmtPace(fastAct.pace*60)+'/km', date:fastAct.date, col:c});
  if (slowAct)  outs.push({icon:'🐢',lbl:'Slowest',   val:fmtPace(slowAct.pace*60)+'/km', date:slowAct.date, col:'#aaa'});

  // Frequency bars
  const years    = [...new Set(acts.map(a=>a.year))].sort();
  const maxCnt   = Math.max(...Object.values(byYear));
  const BAR_MAX  = 56; // px

  cont.innerHTML = `
    <div class="stat-cards">
      ${cards.map(cd=>`
        <div class="stat-card${cd.hi?' hi':''}">
          <div class="sc-label">${cd.l}</div>
          <div class="sc-val">${cd.v}</div>
          <div class="sc-sub">${cd.s}</div>
        </div>`).join('')}
    </div>

    <div class="outlier-wrap">
      ${outs.map(o=>`
        <div class="outlier-tag">
          <span class="ot-icon">${o.icon}</span>
          <span class="ot-lbl">${o.lbl}:</span>
          <span class="ot-val">${o.val}</span>
          <span class="ot-date">${o.date}</span>
        </div>`).join('')}
    </div>

    <div class="freq-wrap">
      ${years.map(yr=>{
        const cnt = byYear[yr]||0;
        const pct = cnt/maxCnt;
        const barH= Math.max(3, pct*BAR_MAX);
        const op  = 0.30+pct*0.70;
        return `<div class="freq-col" title="${yr}: ${cnt} activities">
          <span class="freq-cnt">${cnt}</span>
          <div class="freq-bar" style="height:${barH}px;background:${c};opacity:${op}"></div>
          <span class="freq-lbl">${yr}</span>
        </div>`;
      }).join('')}
    </div>`;
}

// ═══════════════════════════════════════════════════════════════
//  DRILL CHART — individual activities within a clicked month
//  Simple bar chart: one bar per activity, x=date, y=distance.
//  Shows the granularity hidden by monthly aggregation.
// ═══════════════════════════════════════════════════════════════
function renderDrillChart(monthActs) {
  const wrap = document.getElementById('cwDrill');
  const W = wrap.clientWidth, H = wrap.clientHeight;
  if (W<10||H<10) return;
  const mg = {top:8,right:12,bottom:28,left:42};

  d3.select('#svgDrill').selectAll('*').remove();
  const svg = d3.select('#svgDrill').attr('width',W).attr('height',H);

  const data = monthActs.filter(a=>a.dist>0).sort((a,b)=>a.date.localeCompare(b.date));
  if (!data.length) return;

  const c  = color(selType);
  const x  = d3.scaleBand().domain(data.map(d=>d.date)).range([mg.left,W-mg.right]).padding(.3);
  const y  = d3.scaleLinear().domain([0,d3.max(data,d=>d.dist)*1.18]).range([H-mg.bottom,mg.top]);

  // Grid
  svg.append('g').selectAll('line').data(y.ticks(4)).join('line')
    .attr('class','grid-line')
    .attr('x1',mg.left).attr('x2',W-mg.right).attr('y1',d=>y(d)).attr('y2',d=>y(d));

  svg.selectAll('rect').data(data).join('rect')
    .attr('x',     d=>x(d.date))
    .attr('y',     d=>y(d.dist))
    .attr('width', x.bandwidth())
    .attr('height',d=>Math.max(0,y(0)-y(d.dist)))
    .attr('rx', 2)
    .attr('fill', c).attr('opacity',.72)
    .on('mouseover',(e,d)=>tip(e, d.date, fmtKm(d.dist), `${fmtTime(d.movingS)} · ${d.elevation.toFixed(0)} m elev`))
    .on('mousemove',tipMove).on('mouseleave',tipHide);

  svg.append('g').attr('class','axis')
    .attr('transform',`translate(0,${H-mg.bottom})`)
    .call(d3.axisBottom(x).tickFormat(d=>d.slice(8)).tickSize(0))
    .call(g=>g.select('.domain').remove());

  svg.append('g').attr('class','axis')
    .attr('transform',`translate(${mg.left},0)`)
    .call(d3.axisLeft(y).ticks(4).tickFormat(d=>d+'km').tickSize(0))
    .call(g=>g.select('.domain').remove());
}

// ── MASTER RENDER ─────────────────────────────────────────────────────────────
function render() {
  const acts = applyFilters();
  renderKpis(acts);
  renderDistChart(acts);
  renderPaceChart(acts);
  renderStats(acts);
}

// ── KICK OFF ──────────────────────────────────────────────────────────────────
loadCSV();
