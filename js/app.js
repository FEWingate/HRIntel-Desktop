const SEASON = 2026;
const BASE   = 'https://statsapi.mlb.com/api/v1';

// ── TEAM COLORS (primary color for each MLB team) ──────────────────────
const TEAM_COLORS = {
  'ARI':['#A71930','#E3D4AD'],'ATL':['#CE1141','#13274F'],'BAL':['#DF4601','#000000'],
  'BOS':['#BD3039','#0C2340'],'CHC':['#0E3386','#CC3433'],'CWS':['#27251F','#C4CED4'],
  'CIN':['#C6011F','#000000'],'CLE':['#00385D','#E31937'],'COL':['#333366','#C4CED4'],
  'DET':['#0C2340','#FA4616'],'HOU':['#002D62','#EB6E1F'],'KC':['#004687','#C09A5B'],
  'LAA':['#BA0021','#003263'],'LAD':['#005A9C','#EF3E42'],'MIA':['#00A3E0','#EF3340'],
  'MIL':['#12284B','#FFC52F'],'MIN':['#002B5C','#D31145'],'NYM':['#002D72','#FF5910'],
  'NYY':['#003087','#C4CED4'],'OAK':['#003831','#EFB21E'],'PHI':['#E81828','#002D72'],
  'PIT':['#27251F','#FDB827'],'SD':['#2F241D','#FFC425'],'SF':['#FD5A1E','#27251F'],
  'SEA':['#0C2C56','#005C5C'],'STL':['#C41E3A','#0C2340'],'TB':['#092C5C','#8FBCE6'],
  'TEX':['#003278','#C0111F'],'TOR':['#134A8E','#E8291C'],'WSH':['#AB0003','#14225A'],
  'ATH':['#003831','#EFB21E']
};
// ── TEAM COLOR HELPERS ────────────────────────────────────────────────
function teamColor(abbr) { return TEAM_COLORS[abbr]?.[0]||null; }
// ── HOT/COLD HR HITTERS ──────────────────────────────────────────────────────
async function buildHotColdData() {
  // ── STEP 1: Build candidate pool ─────────────────────────────────────────
  // Top 25 season HR leaders — always included (for both hot and cold)
  const top25Ids = new Set(hitters.map(h => h.id));
  const playerSet = new Map();

  hitters.forEach(h => {
    playerSet.set(h.id, { id: h.id, name: h.name, team: h.team, isTop25: true, seasonHR: h.hr });
  });

  // All roster players with 3+ season HR — these could be hidden hot streakers
  // Fetch all 30 team rosters directly so we don't depend on _teamRosters being populated.
  // _teamRosters only has teams from today's games; this guarantees full 30-team coverage.
  const ALL_TEAM_IDS = [
    {id:109,abbr:'ARI'},{id:144,abbr:'ATL'},{id:110,abbr:'BAL'},{id:111,abbr:'BOS'},
    {id:112,abbr:'CHC'},{id:145,abbr:'CWS'},{id:113,abbr:'CIN'},{id:114,abbr:'CLE'},
    {id:115,abbr:'COL'},{id:116,abbr:'DET'},{id:117,abbr:'HOU'},{id:118,abbr:'KC'},
    {id:108,abbr:'LAA'},{id:119,abbr:'LAD'},{id:146,abbr:'MIA'},{id:158,abbr:'MIL'},
    {id:142,abbr:'MIN'},{id:121,abbr:'NYM'},{id:147,abbr:'NYY'},{id:133,abbr:'ATH'},
    {id:143,abbr:'PHI'},{id:134,abbr:'PIT'},{id:135,abbr:'SD'}, {id:137,abbr:'SF'},
    {id:136,abbr:'SEA'},{id:138,abbr:'STL'},{id:139,abbr:'TB'}, {id:140,abbr:'TEX'},
    {id:141,abbr:'TOR'},{id:120,abbr:'WSH'}
  ];

  const rosterFetches = [];
  // Fetch all 30 rosters in parallel (batches of 6 to avoid hammering the API)
  const rosterBatch = 6;
  for (let i = 0; i < ALL_TEAM_IDS.length; i += rosterBatch) {
    const slice = ALL_TEAM_IDS.slice(i, i + rosterBatch);
    await Promise.all(slice.map(async ({ id, abbr }) => {
      try {
        const d = await fetchJSON(`${BASE}/teams/${id}/roster?rosterType=40Man&season=${SEASON}`);
        for (const p of (d.roster || [])) {
          const pid = p.person?.id;
          const name = p.person?.fullName;
          if (!pid || !name || top25Ids.has(pid)) continue;
          // de-duplicate across teams
          if (!rosterFetches.some(r => r.id === pid)) {
            rosterFetches.push({ id: pid, name, team: abbr });
          }
        }
      } catch {}
    }));
  }

  // Fetch season HR for roster players in batches to filter candidates
  const batchSize = 15;
  const seasonHRMap = {};
  for (let i = 0; i < rosterFetches.length; i += batchSize) {
    const batch = rosterFetches.slice(i, i + batchSize);
    await Promise.all(batch.map(async p => {
      try {
        const d = await fetchJSON(`${BASE}/people/${p.id}/stats?stats=season&season=${SEASON}&group=hitting&gameType=R`);
        const hr = d?.stats?.[0]?.splits?.[0]?.stat?.homeRuns || 0;
        seasonHRMap[p.id] = hr;
        // Only include roster players with 3+ season HR
        if (hr >= 3) {
          playerSet.set(p.id, { id: p.id, name: p.name, team: p.team, isTop25: false, seasonHR: hr });
        }
      } catch {}
    }));
  }

  // ── STEP 2: Fetch L10 game logs for all candidates ────────────────────────
  const ids = [...playerSet.keys()];
  const results = {};

  for (let i = 0; i < ids.length; i += batchSize) {
    const batch = ids.slice(i, i + batchSize);
    await Promise.all(batch.map(async id => {
      try {
        const d = await fetchJSON(`${BASE}/people/${id}/stats?stats=gameLog&season=${SEASON}&group=hitting&gameType=R&limit=10`);
        const splits = d?.stats?.[0]?.splits || [];
        // Sort newest-first — API sometimes returns oldest-first
        const sorted = [...splits].sort((a,b) => (b.date||'').localeCompare(a.date||''));
        const l10 = sorted.slice(0, 10);
        const l5  = sorted.slice(0, 5);
        const calcBA = (games) => {
          const ab = games.reduce((s,g) => s + (g.stat?.atBats||0), 0);
          const h  = games.reduce((s,g) => s + (g.stat?.hits||0), 0);
          return { ab, ba: ab > 0 ? h/ab : 0 };
        };
        const l5stats  = calcBA(l5);
        const l10stats = calcBA(l10);
        results[id] = {
          l5HR:  l5.reduce((s,g)  => s + (g.stat?.homeRuns||0), 0),
          l10HR: l10.reduce((s,g) => s + (g.stat?.homeRuns||0), 0),
          l5AB: l5stats.ab,  l5BA: l5stats.ba,
          l10AB: l10stats.ab, l10BA: l10stats.ba,
        };
      } catch { results[id] = { l5HR: 0, l10HR: 0, l5AB: 0, l5BA: 0, l10AB: 0, l10BA: 0 }; }
    }));
  }

  // ── STEP 3: Build final list ──────────────────────────────────────────────
  const list = [];
  for (const [id, p] of playerSet.entries()) {
    const r = results[id] || { l5HR: 0, l10HR: 0, l5AB: 0, l5BA: 0, l10AB: 0, l10BA: 0 };
    list.push({ ...p, ...r });
  }

  // HOT: L5 = 2+ HR (~1 per 7-8 AB, genuinely hot pace)
  //       L10 = 3+ HR (~1 per 10 AB, clearly hot)
  const hotL5  = list.filter(p => p.l5HR  >= 2).sort((a,b) => b.l5HR  - a.l5HR  || b.l10HR - a.l10HR || b.seasonHR - a.seasonHR);
  const hotL10 = list.filter(p => p.l10HR >= 3).sort((a,b) => b.l10HR - a.l10HR || b.l5HR  - a.l5HR  || b.seasonHR - a.seasonHR);

  // COLD: Top 25 only, 5+ season HR
  // L5 cold = 0 HR (small sample — only flag complete silence)
  // L10 cold = 0 or 1 HR (~30 AB with ≤1 HR is a real slump for a power hitter)
  const coldL5  = list.filter(p => p.isTop25 && p.l5HR  === 0 && p.seasonHR >= 5).sort((a,b) => b.seasonHR - a.seasonHR);
  const coldL10 = list.filter(p => p.isTop25 && p.l10HR <= 1 && p.seasonHR >= 5).sort((a,b) => b.seasonHR - a.seasonHR);

  _hotColdData = {
    L5:  { hot: hotL5,  cold: coldL5  },
    L10: { hot: hotL10, cold: coldL10 },
  };

  // Backfill L5/L10 HR counts onto hitters so Threat Alerts can display them
  for (const h of hitters) {
    const r = results[h.id];
    if (r) { h.l5HR = r.l5HR; h.l10HR = r.l10HR; }
  }
  // Re-render alerts now that hitters have L5/L10 data
  if (window._lastAlerts) renderAlerts(window._lastAlerts, true);

  renderHotCold();
}

function openHotColdModal() {
  const overlay = document.getElementById('hotcoldModalOverlay');
  if (overlay) overlay.classList.add('open');
  if (!_hotColdData) {
    buildHotColdData().catch(()=>{});
  } else {
    renderHotCold();
  }
}

function closeHotColdModal(e) {
  if (!e || e.target === document.getElementById('hotcoldModalOverlay')) {
    document.getElementById('hotcoldModalOverlay')?.classList.remove('open');
  }
}

function setHotColdWindow(w) {
  _hotColdWindow = w;
  document.getElementById('hotcold-l5')?.classList.toggle('active', w==='L5');
  document.getElementById('hotcold-l10')?.classList.toggle('active', w==='L10');
  renderHotCold();
}

function renderHotCold() {
  const el = document.getElementById('hotcold-list');
  if (!el) return;
  if (!_hotColdData) { el.innerHTML = '<div style="color:var(--text-dim);font-size:11px;text-align:center;padding:20px 0;">Loading...</div>'; return; }

  const { hot, cold } = _hotColdData[_hotColdWindow];
  const hrKey = _hotColdWindow === 'L5' ? 'l5HR' : 'l10HR';
  const abKey = _hotColdWindow === 'L5' ? 'l5AB' : 'l10AB';
  const baKey = _hotColdWindow === 'L5' ? 'l5BA' : 'l10BA';
  const gLabel = _hotColdWindow === 'L5' ? 'Last 5' : 'Last 10';

  let html = `<div style="font-family:var(--font-mono);font-size:9px;color:var(--text-dim);margin-bottom:12px;display:flex;justify-content:space-between;">
    <span>PLAYER</span><span style="margin-left:auto;margin-right:10px;">AB · BA</span><span style="width:40px;text-align:right;">HR</span>
  </div>`;

  // HOT section
  if (hot.length) {
    html += `<div class="hotcold-section-label" style="color:var(--accent-gold);">🔥 Hot — ${gLabel} Games</div>`;
    for (const p of hot.slice(0, 15)) {
      const tc  = teamTextColor(p.team) || '#e2e8f0';
      const ba  = p[baKey] > 0 ? p[baKey].toFixed(3).replace('0.','.') : '.000';
      const ab  = p[abKey] || 0;
      const safeName = (p.name||'').replace(/'/g,"\'");
      html += `<div class="hotcold-player" onclick="openPlayerModal(${p.id},'${safeName}','${p.team}')">
        <div class="hotcold-name">${p.name}${p.isTop25?'<span class="hotcold-badge" style="margin-left:5px;">T25</span>':''}</div>
        <div class="hotcold-team" style="color:${tc};">${p.team}</div>
        <div class="hotcold-stats">${ab} AB · ${ba} BA</div>
        <div class="hotcold-hr hot">${p[hrKey]} HR</div>
      </div>`;
    }
  }

  // COLD section
  if (cold.length) {
    html += `<div class="hotcold-section-label" style="color:#60a5fa;margin-top:16px;">🧊 Cold — ${gLabel} Games (Top 25 Only)</div>`;
    for (const p of cold.slice(0, 8)) {
      const tc  = teamTextColor(p.team) || '#e2e8f0';
      const ba  = p[baKey] > 0 ? p[baKey].toFixed(3).replace('0.','.') : '.000';
      const ab  = p[abKey] || 0;
      const safeName = (p.name||'').replace(/'/g,"\'");
      html += `<div class="hotcold-player" onclick="openPlayerModal(${p.id},'${safeName}','${p.team}')">
        <div class="hotcold-name">${p.name}<span class="hotcold-badge" style="margin-left:5px;">T25</span></div>
        <div class="hotcold-team" style="color:${tc};">${p.team}</div>
        <div class="hotcold-stats">${ab} AB · ${ba} BA</div>
        <div class="hotcold-hr cold">${p[hrKey]} HR</div>
      </div>`;
    }
  }

  if (!hot.length && !cold.length) html = '<div style="color:var(--text-dim);font-size:11px;text-align:center;padding:20px 0;">No data yet — check back once games are played</div>';
  el.innerHTML = html;
}

// Returns a lightened version of team color safe for text on dark backgrounds
function teamTextColor(abbr) {
  const raw = teamColor(abbr);
  if (!raw) return 'var(--text-dim)';
  // Parse hex and lighten significantly
  const hex = raw.replace('#','');
  if (hex.length !== 6) return raw;
  let r = parseInt(hex.slice(0,2),16);
  let g = parseInt(hex.slice(2,4),16);
  let b = parseInt(hex.slice(4,6),16);
  // Check perceived brightness — if too dark, lighten it
  const brightness = (r*299 + g*587 + b*114) / 1000;
  if (brightness < 100) {
    // Very dark color — lighten significantly
    r = Math.min(255, r + 130);
    g = Math.min(255, g + 130);
    b = Math.min(255, b + 130);
  } else if (brightness < 160) {
    // Medium dark — lighten moderately
    r = Math.min(255, r + 70);
    g = Math.min(255, g + 70);
    b = Math.min(255, b + 70);
  }
  return '#' + [r,g,b].map(v=>v.toString(16).padStart(2,'0')).join('');
}

function tickerTeamColor(abbr) {
  // Lightened team colors specifically for dark backgrounds
  const LIGHT = {
    'ARI':'#e05070','ATL':'#e84070','BAL':'#ff7733','BOS':'#e05060',
    'CHC':'#5588ee','CWS':'#aabbcc','CIN':'#e83030','CLE':'#4499cc',
    'COL':'#8888dd','DET':'#5588bb','HOU':'#5599ff','KC':'#6699cc',
    'LAA':'#e84060','LAD':'#4499dd','MIA':'#33bbee','MIL':'#ffcc44',
    'MIN':'#4477cc','NYM':'#4488ee','NYY':'#7799cc','OAK':'#44aa66',
    'PHI':'#ee4455','PIT':'#ffcc33','SD':'#bb9966','SF':'#ff7744',
    'SEA':'#4499aa','STL':'#e84455','TB':'#6699dd','TEX':'#5577cc',
    'TOR':'#5588ee','WSH':'#ee4444','ATH':'#44aa66'
  };
  return LIGHT[abbr] || '#9ca3af';
}

let hitters=[], hrPitchers=[], koPitchers=[], venues=[], todayGames=[];
const _gameHRCache = {}; // gamePk -> { events: [{name,team,playerId,inning,type}], ts: timestamp }
let _hotColdWindow = 'L5'; // current toggle state
let _hotColdData   = null; // cached { L5: [...], L10: [...] }
let noHRPitchersAL=[], noHRPitchersNL=[], noHRTeams=[], teamHRLeaderboard=[], teamKLeaderboard=[];

// ── UTILS ──────────────────────────────────────────────────────────
async function fetchJSON(url) {
  // Try direct first, fall back to CORS proxy if blocked (common when opening as local file)
  try {
    const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  } catch(e) {
    // Fallback: use a CORS proxy
    const proxy = 'https://corsproxy.io/?';
    const r2 = await fetch(proxy + encodeURIComponent(url));
    if (!r2.ok) throw new Error(`Proxy HTTP ${r2.status}`);
    return r2.json();
  }
}
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function formatTime(iso) {
  if (!iso) return 'TBD';
  return new Date(iso).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit',timeZoneName:'short'});
}

// ── THREATS TAB TOGGLE ──────────────────────────────────────────────
function switchThreatsTab(tab) {
  document.querySelectorAll('.threats-panel').forEach(p=>p.classList.remove('active'));
  document.getElementById('hrThreatsBtn').className='threats-tab-btn';
  document.getElementById('nohrThreatsBtn').className='threats-tab-btn';
  if (tab==='hr') {
    document.getElementById('hrThreatsPanel').classList.add('active');
    document.getElementById('hrThreatsBtn').classList.add('active-hr');
  } else {
    document.getElementById('nohrThreatsPanel').classList.add('active');
    document.getElementById('nohrThreatsBtn').classList.add('active-nohr');
  }
}

// ── FETCH NO HR DATA ────────────────────────────────────────────────
async function fetchNoHRPitchers() {
  await buildLeagueCache();
  // Fetch starters sorted by fewest HR allowed — get more so we can split by league
  const d = await fetchJSON(`${BASE}/stats?stats=season&group=pitching&season=${SEASON}&sortStat=homeRuns&order=asc&limit=100&sportId=1&gameType=R`);
  const splits = (d.stats?.[0]?.splits||[]).filter(s=>(s.stat?.gamesStarted||0) >= 3);
  const all = splits.map(s=>({
    id: s.player?.id, name: s.player?.fullName||'—',
    team: getTeamAbbr(s.team?.id, s.team?.abbreviation),
    teamId: s.team?.id, league: getLeague(s.team?.id),
    hr: s.stat?.homeRuns||0, gs: s.stat?.gamesStarted||0, hand: null
  }));
  const hands = await Promise.all(all.map(p=>fetchHandedness(p.id)));
  all.forEach((p,i)=>p.hand=hands[i]);
  const AL = all.filter(p=>p.league==='A').slice(0,20);
  const NL = all.filter(p=>p.league==='N').slice(0,20);
  return { AL, NL };
}

async function fetchNoHRTeams() {
  await buildLeagueCache();
  try {
    const d2 = await fetchJSON(`${BASE}/teams?sportId=1&season=${SEASON}`);
    const teamIds = (d2.teams||[]).filter(t=>t.sport?.id===1).map(t=>t.id);
    const teamStats = await Promise.all(teamIds.slice(0,30).map(async id=>{
      try {
        const ts = await fetchJSON(`${BASE}/teams/${id}/stats?stats=season&group=hitting&season=${SEASON}&sportId=1`);
        const stat = ts.stats?.[0]?.splits?.[0]?.stat;
        return { teamId: id, abbr: getTeamAbbr(id,'—'), hr: stat?.homeRuns||0 };
      } catch { return { teamId: id, abbr: getTeamAbbr(id,'—'), hr: 0 }; }
    }));
    return teamStats.sort((a,b)=>a.hr-b.hr).slice(0,10);
  } catch { return []; }
}

async function fetchTeamHRLeaderboard() {
  await buildLeagueCache();
  try {
    // Use the standing stats endpoint — returns all teams in one call
    const d = await fetchJSON(`${BASE}/standings?leagueId=103,104&season=${SEASON}&standingsTypes=regularSeason&hydrate=team`);
    // Fall back to hitting stats via the existing hitter stats but grouped by team
    const d2 = await fetchJSON(`${BASE}/stats?stats=season&group=hitting&season=${SEASON}&sportId=1&gameType=R&playerPool=ALL&limit=2000`);
    const splits = d2.stats?.[0]?.splits||[];
    // Aggregate by team
    const teamMap = {};
    for (const s of splits) {
      const id = s.team?.id;
      if (!id) continue;
      if (!teamMap[id]) {
        teamMap[id] = {
          teamId: id,
          name: s.team?.name||getTeamAbbr(id,'—'),
          abbr: getTeamAbbr(id, s.team?.abbreviation||'—'),
          league: getLeague(id),
          hr: 0
        };
      }
      teamMap[id].hr += (s.stat?.homeRuns||0);
    }
    const result = Object.values(teamMap).sort((a,b)=>b.hr-a.hr);
    if (result.length) return result;
    return [];
  } catch { return []; }
}

// ── TEAM STRIKEOUT LEADERBOARD (team pitching staff totals) ──────────
async function fetchTeamKLeaderboard() {
  await buildLeagueCache();
  try {
    // Single batched call across all pitchers, aggregated by team — same
    // pattern as fetchTeamHRLeaderboard, just grouped by pitching instead.
    const d2 = await fetchJSON(`${BASE}/stats?stats=season&group=pitching&season=${SEASON}&sportId=1&gameType=R&playerPool=ALL&limit=2000`);
    const splits = d2.stats?.[0]?.splits||[];
    const teamMap = {};
    for (const s of splits) {
      const id = s.team?.id;
      if (!id) continue;
      if (!teamMap[id]) {
        teamMap[id] = {
          teamId: id,
          name: s.team?.name||getTeamAbbr(id,'—'),
          abbr: getTeamAbbr(id, s.team?.abbreviation||'—'),
          league: getLeague(id),
          k: 0,
          games: 0,
          homeK: null,
          awayK: null,
          homeKpg: null,
          awayKpg: null
        };
      }
      teamMap[id].k += (s.stat?.strikeOuts||0);
      // gamesPlayed/gamesPitched is per-pitcher; take the team's max games played
      // as a season-length proxy so K/G reflects games, not innings.
      teamMap[id].games = Math.max(teamMap[id].games, s.stat?.gamesPlayed||s.stat?.gamesPitched||0);
    }
    const result = Object.values(teamMap);
    result.forEach(t => { t.kpg = t.games > 0 ? (t.k / t.games).toFixed(1) : '—'; });
    result.sort((a,b)=>b.k-a.k);
    if (!result.length) return [];

    // Fetch home/road K splits for all 30 teams in parallel
    const homeAway = await Promise.all(result.map(t => fetchTeamHomeAwayK(t.teamId)));
    result.forEach((t, i) => {
      const r = homeAway[i];
      t.homeK = r.homeK;
      t.awayK = r.awayK;
      t.homeKpg = (r.homeK !== null && r.homeGP) ? (r.homeK / r.homeGP).toFixed(1) : null;
      t.awayKpg = (r.awayK !== null && r.awayGP) ? (r.awayK / r.awayGP).toFixed(1) : null;
    });
    return result;
  } catch { return []; }
}

const teamHomeAwayKCache = {};
async function fetchTeamHomeAwayK(teamId) {
  if (!teamId) return { homeK: null, awayK: null, homeGP: null, awayGP: null };
  if (teamHomeAwayKCache[teamId]) return teamHomeAwayKCache[teamId];
  try {
    const url = `${BASE}/teams/${teamId}/stats?stats=statSplits&group=pitching&season=${SEASON}&sitCodes=h,a&sportId=1`;
    const sd = await fetchJSON(url);
    const splits = sd.stats?.[0]?.splits || [];
    let homeK = null, awayK = null, homeGP = null, awayGP = null;
    for (const s of splits) {
      const code = (s.split?.code || s.split?.description || '').toLowerCase();
      if (code === 'h' || /home/i.test(code)) { homeK = s.stat?.strikeOuts ?? null; homeGP = s.stat?.gamesPlayed ?? null; }
      if (code === 'a' || code === 'r' || /away/i.test(code) || /road/i.test(code)) { awayK = s.stat?.strikeOuts ?? null; awayGP = s.stat?.gamesPlayed ?? null; }
    }
    if (homeK === null && awayK === null && splits.length >= 2) {
      homeK  = splits[0]?.stat?.strikeOuts ?? null;
      homeGP = splits[0]?.stat?.gamesPlayed ?? null;
      awayK  = splits[1]?.stat?.strikeOuts ?? null;
      awayGP = splits[1]?.stat?.gamesPlayed ?? null;
    }
    const result = { homeK, awayK, homeGP, awayGP };
    // Only cache successful results — don't permanently cache a transient
    // failure or empty response (same lesson learned from the pitcher version).
    if (homeK !== null || awayK !== null) {
      teamHomeAwayKCache[teamId] = result;
    }
    return result;
  } catch { return { homeK: null, awayK: null, homeGP: null, awayGP: null }; }
}
function setProgress(pct, msg) {
  document.getElementById('loadingBar').style.width = pct+'%';
  document.getElementById('loadingStatus').textContent = msg;
}
function setStatus(cls, txt) {
  const el = document.getElementById('liveStatus');
  el.className = 'live-dot '+cls;
  el.textContent = txt;
}
const _landingShownAt = Date.now();
function hideLoading() {
  const ls = document.getElementById('loadingScreen');
  const elapsed = Date.now() - _landingShownAt;
  const minDisplay = 10000; // 10 seconds minimum landing page view
  const remaining = Math.max(0, minDisplay - elapsed);
  setTimeout(() => {
    ls.classList.add('hidden');
    setTimeout(() => ls.style.display = 'none', 650);
  }, remaining);
}

// Hand badge HTML
function handBadge(hand) {
  if (!hand) return '';
  const h = hand === 'L' ? 'L' : hand === 'S' ? 'S' : 'R';
  return `<span class="hand-badge ${h}">${h}</span>`;
}

// ── FETCH PLAYER HANDEDNESS ─────────────────────────────────────────
const handednessCache = {};
async function fetchHandedness(playerId) {
  if (!playerId) return null;
  if (handednessCache[playerId] !== undefined) return handednessCache[playerId];
  try {
    const d = await fetchJSON(`${BASE}/people/${playerId}`);
    const hand = d.people?.[0]?.pitchHand?.code || null;
    handednessCache[playerId] = hand;
    return hand;
  } catch { return null; }
}

const batHandCache = {};
async function fetchBatHand(playerId) {
  if (!playerId) return null;
  if (batHandCache[playerId] !== undefined) return batHandCache[playerId];
  try {
    const d = await fetchJSON(`${BASE}/people/${playerId}`);
    const hand = d.people?.[0]?.batSide?.code || null;
    batHandCache[playerId] = hand;
    return hand;
  } catch { return null; }
}

const platoonSplitsCache = {};
async function fetchPlatoonSplits(pitcherId) {
  if (!pitcherId) return { vsL: null, vsR: null };
  if (platoonSplitsCache[pitcherId]) return platoonSplitsCache[pitcherId];
  try {
    const url = `${BASE}/people/${pitcherId}/stats?stats=statSplits&group=pitching&season=${SEASON}&sitCodes=vl,vr&sportId=1`;
    const sd = await fetchJSON(url);
    const splits = sd.stats?.[0]?.splits || [];
    let vsL = null, vsR = null;
    for (const s of splits) {
      const code = s.split?.code || s.split?.description || '';
      if (code === 'vl' || code === 'vs Left' || /left/i.test(code))  vsL = s.stat?.homeRuns ?? null;
      if (code === 'vr' || code === 'vs Right' || /right/i.test(code)) vsR = s.stat?.homeRuns ?? null;
    }
    if (vsL === null && vsR === null && splits.length >= 2) {
      vsL = splits[0]?.stat?.homeRuns ?? null;
      vsR = splits[1]?.stat?.homeRuns ?? null;
    }
    const result = { vsL, vsR };
    platoonSplitsCache[pitcherId] = result;
    return result;
  } catch(e) {
    return { vsL: null, vsR: null };
  }
}

// ── HITTER PLATOON SPLITS (HRs vs LHP / RHP) ─────────────────────────
const hitterPlatoonCache = {};
async function fetchHitterPlatoonSplits(hitterId) {
  if (!hitterId) return { vsL: null, vsR: null };
  if (hitterPlatoonCache[hitterId]) return hitterPlatoonCache[hitterId];
  try {
    const url = `${BASE}/people/${hitterId}/stats?stats=statSplits&group=hitting&season=${SEASON}&sitCodes=vl,vr&sportId=1`;
    const sd = await fetchJSON(url);
    const splits = sd.stats?.[0]?.splits || [];
    let vsL = null, vsR = null;
    for (const s of splits) {
      const code = (s.split?.code || s.split?.description || '').toLowerCase();
      if (code === 'vl' || code === 'vs left'  || /left/i.test(code))  vsL = s.stat?.homeRuns ?? null;
      if (code === 'vr' || code === 'vs right' || /right/i.test(code)) vsR = s.stat?.homeRuns ?? null;
    }
    if (vsL === null && vsR === null && splits.length >= 2) {
      vsL = splits[0]?.stat?.homeRuns ?? null;
      vsR = splits[1]?.stat?.homeRuns ?? null;
    }
    const result = { vsL, vsR };
    hitterPlatoonCache[hitterId] = result;
    return result;
  } catch { return { vsL: null, vsR: null }; }
}

// ── PITCHER HOME/ROAD STRIKEOUT SPLITS ────────────────────────────────
const pitcherHomeAwayCache = {};
async function fetchPitcherHomeAwayK(pitcherId) {
  if (!pitcherId) return { homeK: null, awayK: null, homeGP: null, awayGP: null };
  if (pitcherHomeAwayCache[pitcherId]) return pitcherHomeAwayCache[pitcherId];
  try {
    const url = `${BASE}/people/${pitcherId}/stats?stats=statSplits&group=pitching&season=${SEASON}&sitCodes=h,a&sportId=1`;
    const sd = await fetchJSON(url);
    const splits = sd.stats?.[0]?.splits || [];
    if (window._debugHomeAway) console.log('HOME/AWAY K DEBUG for', pitcherId, JSON.stringify(splits));
    let homeK = null, awayK = null, homeGP = null, awayGP = null;
    for (const s of splits) {
      const code = (s.split?.code || s.split?.description || '').toLowerCase();
      if (code === 'h' || /home/i.test(code)) { homeK = s.stat?.strikeOuts ?? null; homeGP = s.stat?.gamesPlayed ?? null; }
      if (code === 'a' || code === 'r' || /away/i.test(code) || /road/i.test(code)) { awayK = s.stat?.strikeOuts ?? null; awayGP = s.stat?.gamesPlayed ?? null; }
    }
    if (homeK === null && awayK === null && splits.length >= 2) {
      homeK  = splits[0]?.stat?.strikeOuts ?? null;
      homeGP = splits[0]?.stat?.gamesPlayed ?? null;
      awayK  = splits[1]?.stat?.strikeOuts ?? null;
      awayGP = splits[1]?.stat?.gamesPlayed ?? null;
    }
    const result = { homeK, awayK, homeGP, awayGP };
    // Only cache results that actually contain data — never cache a null/empty
    // result, so a transient fetch failure or empty response can be retried
    // on the next click instead of permanently showing blank cards.
    if (homeK !== null || awayK !== null) {
      pitcherHomeAwayCache[pitcherId] = result;
    }
    return result;
  } catch(e) {
    if (window._debugHomeAway) console.log('HOME/AWAY K FETCH ERROR', pitcherId, e);
    return { homeK: null, awayK: null, homeGP: null, awayGP: null };
  }
}

// ── TEAM LEAGUE CACHE ────────────────────────────────────────────────
const teamLeagueCache = {}; // teamId (string) -> 'A' or 'N'
const teamAbbrCache   = {}; // teamId (string) -> abbreviation

async function buildLeagueCache() {
  if (Object.keys(teamLeagueCache).length > 0) return;
  try {
    const d = await fetchJSON(`${BASE}/teams?sportId=1&season=${SEASON}&sportIds=1`);
    for (const t of (d.teams||[])) {
      const key = String(t.id);
      const leagueName = t.league?.name||'';
      teamLeagueCache[key] = leagueName.includes('American') ? 'A' : leagueName.includes('National') ? 'N' : '?';
      teamAbbrCache[key]   = t.abbreviation||'—';
    }
  } catch(e) { console.warn('League cache failed', e); }
}

function getLeague(teamId) {
  return teamLeagueCache[String(teamId)] || '?';
}

function getTeamAbbr(teamId, fallback) {
  return teamAbbrCache[String(teamId)] || fallback || '—';
}

// ── FETCH STATS ─────────────────────────────────────────────────────
async function fetchHitters() {
  await buildLeagueCache();
  const d = await fetchJSON(`${BASE}/stats?stats=season&group=hitting&season=${SEASON}&sortStat=homeRuns&order=desc&limit=25&sportId=1`);
  const list = (d.stats?.[0]?.splits||[]).map(s=>({
    id:     s.player?.id,
    name:   s.player?.fullName||'—',
    team:   getTeamAbbr(s.team?.id, s.team?.abbreviation),
    teamId: s.team?.id,
    league: getLeague(s.team?.id),
    hr:     s.stat?.homeRuns||0,
    hand:   null,
    vsL:    null,
    vsR:    null
  }));
  const hands = await Promise.all(list.map(p=>fetchBatHand(p.id)));
  list.forEach((p,i)=>p.hand=hands[i]);
  // Fetch platoon splits for all 25 hitters in parallel
  const platoons = await Promise.all(list.map(p => fetchHitterPlatoonSplits(p.id)));
  list.forEach((p, i) => { p.vsL = platoons[i].vsL; p.vsR = platoons[i].vsR; });
  return list;
}

async function fetchHRPitchers() {
  await buildLeagueCache();
  const d = await fetchJSON(`${BASE}/stats?stats=season&group=pitching&season=${SEASON}&sortStat=homeRuns&order=desc&limit=25&sportId=1`);
  const list = (d.stats?.[0]?.splits||[]).map(s=>({
    id:     s.player?.id,
    name:   s.player?.fullName||'—',
    team:   getTeamAbbr(s.team?.id, s.team?.abbreviation),
    teamId: s.team?.id,
    league: getLeague(s.team?.id),
    hr:     s.stat?.homeRuns||0,
    hand:   null,
    vsL:    null,
    vsR:    null
  }));
  const hands = await Promise.all(list.map(p=>fetchHandedness(p.id)));
  list.forEach((p,i)=>p.hand=hands[i]);

  // Fetch platoon splits for all 25 pitchers in parallel (uses global fetchPlatoonSplits)
  const platoons = await Promise.all(list.map(p => fetchPlatoonSplits(p.id)));
  list.forEach((p, i) => { p.vsL = platoons[i].vsL; p.vsR = platoons[i].vsR; });

  return list;
}

async function fetchKOPitchers() {
  await buildLeagueCache();
  const d = await fetchJSON(`${BASE}/stats?stats=season&group=pitching&season=${SEASON}&sortStat=strikeOuts&order=desc&limit=25&sportId=1`);
  const list = (d.stats?.[0]?.splits||[]).map(s=>{
    const k       = s.stat?.strikeOuts||0;
    const games   = s.stat?.gamesPlayed||s.stat?.gamesPitched||0;
    const kpg     = games > 0 ? (k / games).toFixed(1) : '—';
    return {
      id:     s.player?.id,
      name:   s.player?.fullName||'—',
      team:   getTeamAbbr(s.team?.id, s.team?.abbreviation),
      teamId: s.team?.id,
      league: getLeague(s.team?.id),
      k,
      games,
      kpg,
      hand:   null,
      homeK:  null,
      awayK:  null,
      homeKpg: null,
      awayKpg: null
    };
  });
  const hands = await Promise.all(list.map(p=>fetchHandedness(p.id)));
  list.forEach((p,i)=>p.hand=hands[i]);
  // Fetch home/road K splits for all 25 strikeout pitchers in parallel
  const homeAway = await Promise.all(list.map(p => fetchPitcherHomeAwayK(p.id)));
  list.forEach((p, i) => {
    const r = homeAway[i];
    p.homeK = r.homeK;
    p.awayK = r.awayK;
    p.homeKpg = (r.homeK !== null && r.homeGP) ? (r.homeK / r.homeGP).toFixed(1) : null;
    p.awayKpg = (r.awayK !== null && r.awayGP) ? (r.awayK / r.awayGP).toFixed(1) : null;
  });
  return list;
}

async function fetchVenues() {
  // Step 1: Get all 30 MLB teams and their home venues
  const teamsData = await fetchJSON(`${BASE}/teams?sportId=1&season=${SEASON}&sportIds=1`);
  const teams = (teamsData.teams||[]).filter(t=>t.sport?.id===1);

  // Build map: teamId -> { venueName, venueId, abbr }
  const teamVenueMap = {};
  for (const t of teams) {
    if (t.venue?.id) {
      teamVenueMap[t.id] = { name: t.venue.name, venueId: t.venue.id, abbr: t.abbreviation||'—' };
    }
  }

  // Step 2: Fetch all completed games this season from the schedule
  const schedData = await fetchJSON(
    `${BASE}/schedule?sportId=1&season=${SEASON}&gameType=R&startDate=${SEASON}-03-01&endDate=${todayStr()}&hydrate=team,venue,teams`
  );

  // Collect gamePks of completed games with their venueId
  const completedGames = [];
  for (const dateEntry of (schedData.dates||[])) {
    for (const g of (dateEntry.games||[])) {
      const code = g.status?.statusCode||'';
      const state = g.status?.detailedState||'';
      const done = ['F','FT','FR'].includes(code) || state.startsWith('Final');
      if (done && g.venue?.id) {
        completedGames.push({ gamePk: g.gamePk, venueId: g.venue.id, venueName: g.venue.name, homeTeamId: g.teams?.home?.team?.id });
      }
    }
  }

  if (!completedGames.length) {
    // No completed games yet — return venues with 0 HRs
    return teams
      .filter(t=>t.venue?.name)
      .map(t=>({ venueId: t.venue.id, name: t.venue.name, team: t.abbreviation||'—', hr: 0 }))
      .sort((a,b)=>b.hr-a.hr);
  }

  // Step 3: Fetch box scores for all completed games in parallel (batched to avoid overload)
  const venueHRMap = {}; // venueId -> total HR count

  const BATCH = 10;
  for (let i = 0; i < completedGames.length; i += BATCH) {
    const batch = completedGames.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(async cg => {
      try {
        const box = await fetchJSON(`${BASE}/game/${cg.gamePk}/boxscore`);
        const awayHR = box.teams?.away?.teamStats?.batting?.homeRuns||0;
        const homeHR = box.teams?.home?.teamStats?.batting?.homeRuns||0;
        return { venueId: cg.venueId, venueName: cg.venueName, homeTeamId: cg.homeTeamId, totalHR: awayHR + homeHR };
      } catch { return { venueId: cg.venueId, venueName: cg.venueName, homeTeamId: cg.homeTeamId, totalHR: 0 }; }
    }));
    for (const r of results) {
      venueHRMap[r.venueId] = (venueHRMap[r.venueId]||0) + r.totalHR;
      // Store venue name while we're at it
      if (!venueHRMap[r.venueId+'_name']) venueHRMap[r.venueId+'_name'] = r.venueName;
      if (!venueHRMap[r.venueId+'_team']) {
        const t = teams.find(t=>t.id===r.homeTeamId);
        venueHRMap[r.venueId+'_team'] = t?.abbreviation||'—';
      }
    }
  }

  // Step 4: Build result for all 30 venues
  const result = teams
    .filter(t=>t.venue?.id && t.venue?.name)
    .map(t=>({
      venueId: t.venue.id,
      name: t.venue.name,
      team: t.abbreviation||'—',
      hr: venueHRMap[t.venue.id]||0
    }));

  return result.sort((a,b)=>b.hr-a.hr);
}

async function fetchTodayGames() {
  const d = await fetchJSON(`${BASE}/schedule?sportId=1&date=${todayStr()}&hydrate=probablePitcher,team,venue,lineups,linescore`);
  const games = ((d.dates||[])[0]?.games||[]);
  const list = games.map(g=>{
    const ls             = g.linescore||{};
    const statusCode     = g.status?.statusCode||'';
    const detailedState  = g.status?.detailedState||'';
    const abstractState  = g.status?.abstractGameState||'';
    const isLive         = ['I','MA','MC'].includes(statusCode)||detailedState==='In Progress';
    const isFinal        = ['F','FT','FR','O','UR','CR'].includes(statusCode)
                           || detailedState.startsWith('Final')
                           || abstractState === 'Final';
    const inningHalf     = ls.inningHalf||'';
    const inningOrd      = ls.currentInningOrdinal||'';
    const outs           = ls.outs ?? null;
    // Try linescore first, fall back to teams score
    const awayRuns       = ls.teams?.away?.runs ?? g.teams?.away?.score ?? null;
    const homeRuns       = ls.teams?.home?.runs ?? g.teams?.home?.score ?? null;
    return {
      gamePk: g.gamePk,
      time: formatTime(g.gameDate),
      gameDate: g.gameDate || null, // raw ISO string for cutoff comparison
      venue: g.venue?.name||'—', venueId: g.venue?.id,
      isLive, isFinal, inningHalf, inningOrd, outs,
      awayRuns, homeRuns, detailedState,
      away: {
        id: g.teams?.away?.team?.id,
        team: g.teams?.away?.team?.abbreviation||'—',
        name: g.teams?.away?.team?.name||'—',
        pitcherId: g.teams?.away?.probablePitcher?.id,
        pitcherName: g.teams?.away?.probablePitcher?.fullName||null,
        lineup: (g.lineups?.awayPlayers||g.teams?.away?.lineup||[]).map(p=>({ id: p.id||p.person?.id, name: p.fullName||p.name||p.person?.fullName||'' })).filter(p=>p.id&&p.name),
      },
      home: {
        id: g.teams?.home?.team?.id,
        team: g.teams?.home?.team?.abbreviation||'—',
        name: g.teams?.home?.team?.name||'—',
        pitcherId: g.teams?.home?.probablePitcher?.id,
        pitcherName: g.teams?.home?.probablePitcher?.fullName||null,
        lineup: (g.lineups?.homePlayers||g.teams?.home?.lineup||[]).map(p=>({ id: p.id||p.person?.id, name: p.fullName||p.name||p.person?.fullName||'' })).filter(p=>p.id&&p.name),
      },
    };
  });
  const pitcherIds = [...new Set(list.flatMap(g=>[g.away.pitcherId,g.home.pitcherId]).filter(Boolean))];
  await Promise.all(pitcherIds.map(id=>fetchHandedness(id)));

  // Build global player name map from all lineup data
  window._playerNameMap = window._playerNameMap || {};
  for (const g of list) {
    for (const p of [...(g.away?.lineup||[]), ...(g.home?.lineup||[])]) {
      if (p.id && p.name) window._playerNameMap[p.id] = p.name;
    }
  }
  return list;
}

// ── H2H ─────────────────────────────────────────────────────────────
// fetchH2H defined below in Matchups section with full caching and stat line

// ── TEAM HR LEADERS ──────────────────────────────────────────────────
async function fetchTeamHRLeaders(teamId) {
  if (!teamId) return [];
  try {
    const d = await fetchJSON(`${BASE}/stats?stats=season&group=hitting&season=${SEASON}&sortStat=homeRuns&order=desc&limit=3&sportId=1&teamId=${teamId}`);
    const splits = d.stats?.[0]?.splits||[];
    const list = splits.length
      ? splits.map(s=>({ id:s.player?.id, name:s.player?.fullName||'—', hr:s.stat?.homeRuns||0, vsL:null, vsR:null }))
      : (await fetchJSON(`${BASE}/stats?stats=season&group=hitting&season=${SEASON}&sortStat=homeRuns&order=desc&limit=3&sportId=1&teamId=${teamId}&gameType=R`))
          .stats?.[0]?.splits?.map(s=>({ id:s.player?.id, name:s.player?.fullName||'—', hr:s.stat?.homeRuns||0, vsL:null, vsR:null })) || [];
    // Fetch bat handedness and platoon splits in parallel
    await Promise.all([
      ...list.filter(p => p.id && !batHandCache[p.id]).map(p => fetchBatHand(p.id)),
      ...list.filter(p => p.id && !hitterPlatoonCache[p.id]).map(p =>
        fetchHitterPlatoonSplits(p.id).then(r => { p.vsL = r.vsL; p.vsR = r.vsR; })
      )
    ]);
    // Fill in splits for players already cached
    list.forEach(p => {
      if (p.id && hitterPlatoonCache[p.id]) {
        p.vsL = hitterPlatoonCache[p.id].vsL;
        p.vsR = hitterPlatoonCache[p.id].vsR;
      }
    });
    return list;
  } catch { return []; }
}

// ── ANALYZE MATCHUPS ─────────────────────────────────────────────────
function analyzeMatchups() {
  const hitterIds  = new Set(hitters.map(h=>h.id));
  const pitcherIds = new Set(hrPitchers.map(p=>p.id));
  // Use HR total of 10th venue as threshold — all venues tied with it qualify
  const top10MinHR = venues.length >= 10 ? venues[9].hr : 0;
  const top10Ids   = new Set(venues.filter(v => v.hr >= top10MinHR).map(v=>v.venueId));
  const hitterMap  = Object.fromEntries(hitters.map((h,i)=>[h.id,{...h,rank:i+1}]));
  const pitcherMap = Object.fromEntries(hrPitchers.map((p,i)=>[p.id,{...p,rank:i+1}]));

  const earlySeasonMode = hrPitchers.filter(p=>p.hr > 0).length < 15;

  const alerts = [];
  const seen = new Set();

  for (const game of todayGames) {
    if (game.isFinal || game.isLive) continue;

    const isTopVenue    = top10Ids.has(game.venueId);
    const venueData     = venues.find(v=>v.venueId===game.venueId);
    const venueRank     = venueData ? venues.indexOf(venueData)+1 : null;

    const pairs = [
      { lineupIds: (game.away.lineup||[]).map(p=>p.id||p), pitcherId: game.home.pitcherId, pitcherName: game.home.pitcherName, battingTeam: game.away.team },
      { lineupIds: (game.home.lineup||[]).map(p=>p.id||p), pitcherId: game.away.pitcherId, pitcherName: game.away.pitcherName, battingTeam: game.home.team },
    ];

    for (const pair of pairs) {
      const isTop25Pitcher = pair.pitcherId && pitcherIds.has(pair.pitcherId);
      const pitcher = pair.pitcherId
        ? (isTop25Pitcher ? pitcherMap[pair.pitcherId] : { id: pair.pitcherId, name: pair.pitcherName||'TBD', team: '—', hr: 0, rank: '—' })
        : null;

      // Get the batting team's lineup hitters who are in the Top 25
      const lineupHitters = (pair.lineupIds||[]).filter(id=>hitterIds.has(id)).map(id=>hitterMap[id]);

      // Fallback to probable hitters if lineup not posted — use hitterMap so rank is included
      const probableHitters = lineupHitters.length === 0
        ? hitters.filter(h=>h.team===pair.battingTeam).slice(0,2).map(h=>hitterMap[h.id]).filter(Boolean)
        : [];

      const allHitters = lineupHitters.length > 0 ? lineupHitters : probableHitters;
      const isProbable = lineupHitters.length === 0;

      for (const hitter of allHitters) {
        // Count how many categories are present
        const hasHitter  = true; // always true since we're iterating top 25 hitters
        const hasPitcher = isTop25Pitcher || earlySeasonMode;
        const hasVenue   = isTopVenue;

        const categoryCount = [hasHitter, hasPitcher && !!pitcher, hasVenue].filter(Boolean).length;

        // Need at least 2 categories for a double threat
        if (categoryCount < 2) continue;

        // Skip if pitcher not present and venue not top 10 — hitter alone isn't enough
        if (!hasPitcher && !hasVenue) continue;

        const threatType = (hasHitter && hasPitcher && hasVenue) ? 'triple' : 'double';

        // Build a key to deduplicate
        const key = `${game.gamePk}-${hitter.id}-${pair.pitcherId||'nop'}-${isProbable?'prob':''}`;
        if (seen.has(key)) continue;
        seen.add(key);

        alerts.push({
          type: threatType,
          game, hitter,
          pitcher: pitcher || { name: 'TBD', rank: '—', hr: 0 },
          venueData, venueRank,
          probable: isProbable,
          hasHitter, hasPitcher: isTop25Pitcher, hasVenue,
          earlyseason: !isTop25Pitcher && earlySeasonMode,
        });
      }

      // VENUE + PITCHER combo (no top 25 hitter in lineup yet)
      // Flag the game itself if both venue and pitcher are top category
      if (isTopVenue && isTop25Pitcher && pitcher && allHitters.length === 0) {
        const key = `${game.gamePk}-venue-pitcher-${pair.pitcherId}`;
        if (!seen.has(key)) {
          seen.add(key);
          alerts.push({
            type: 'double',
            game, hitter: null, pitcher,
            venueData, venueRank,
            probable: true,
            hasHitter: false, hasPitcher: true, hasVenue: true,
            venueOnly: true,
          });
        }
      }
    }
  }
  return alerts.sort((a,b)=>(b.type==='triple')-(a.type==='triple'));
}

// ── ANALYZE NO HR MATCHUPS ────────────────────────────────────────────
function analyzeNoHRMatchups() {
  // Bottom 10 venues by HR allowed
  const sortedVenues = venues.slice(); // already sorted desc, so reverse for bottom
  const bottom10VenueIds = new Set(sortedVenues.slice().reverse().slice(0,10).map(v=>v.venueId));
  const bottom10Venues   = sortedVenues.slice().reverse().slice(0,10);

  // Bottom 10 pitchers fewest HR allowed (AL + NL combined)
  const noHRPitcherIds = new Set([...noHRPitchersAL,...noHRPitchersNL].map(p=>p.id));
  const noHRPitcherMap = Object.fromEntries([...noHRPitchersAL,...noHRPitchersNL].map(p=>[p.id,p]));

  // Bottom 10 teams by HR — use noHRTeams which is already bottom 10 sorted asc
  const noHRTeamAbbrs = new Set(noHRTeams.map(t=>t.abbr));

  const alerts = [], seen = new Set();

  for (const game of todayGames) {
    if (game.isFinal || game.isLive) continue;

    const isBottomVenue   = bottom10VenueIds.has(game.venueId);
    const venueData       = bottom10Venues.find(v=>v.venueId===game.venueId);
    const venueBottomRank = venueData ? bottom10Venues.indexOf(venueData)+1 : null;

    const awayIsNoHRTeam  = noHRTeamAbbrs.has(game.away.team);
    const homeIsNoHRTeam  = noHRTeamAbbrs.has(game.home.team);
    const awayPitcherNoHR = game.away.pitcherId && noHRPitcherIds.has(game.away.pitcherId);
    const homePitcherNoHR = game.home.pitcherId && noHRPitcherIds.has(game.home.pitcherId);
    const bothPitchersNoHR = awayPitcherNoHR && homePitcherNoHR;

    // ── DOUBLE THREAT: Bottom 10 batting team + Bottom 10 venue ──
    // Check each team batting
    const battingPairs = [
      { battingTeam: game.away.team, isNoHRTeam: awayIsNoHRTeam },
      { battingTeam: game.home.team, isNoHRTeam: homeIsNoHRTeam },
    ];

    for (const pair of battingPairs) {
      if (!pair.isNoHRTeam || !isBottomVenue) continue;

      // Check if this is actually a triple (both pitchers bottom 10 too)
      const isTriple = bothPitchersNoHR;

      const key = `nohr-${game.gamePk}-${pair.battingTeam}-${isTriple?'triple':'double'}`;
      if (seen.has(key)) continue;
      seen.add(key);

      alerts.push({
        type: isTriple ? 'nohr-triple' : 'nohr-double',
        game,
        battingTeamAbbr: pair.battingTeam,
        venueData, venueBottomRank,
        isBottomVenue: true,
        isNoHRTeam: true,
        bothPitchersNoHR: isTriple,
        awayPitcher: { name: game.away.pitcherName||'TBD', id: game.away.pitcherId, isNoHR: awayPitcherNoHR, data: awayPitcherNoHR ? noHRPitcherMap[game.away.pitcherId] : null },
        homePitcher: { name: game.home.pitcherName||'TBD', id: game.home.pitcherId, isNoHR: homePitcherNoHR, data: homePitcherNoHR ? noHRPitcherMap[game.home.pitcherId] : null },
      });
    }
  }

  // Deduplicate — if both batting teams qualify in same game, show triple only once
  const gameKeys = new Set();
  return alerts
    .sort((a,b)=>(b.type==='nohr-triple')-(a.type==='nohr-triple'))
    .filter(a=>{
      const k = `${a.game.gamePk}-${a.type}`;
      if (gameKeys.has(k)) return false;
      gameKeys.add(k);
      return true;
    });
}

// ── RENDER NO HR ALERTS ───────────────────────────────────────────────
function renderNoHRAlerts(alerts) {
  const c = document.getElementById('nohrAlertsContainer');
  if (!alerts.length) {
    c.innerHTML = `<div class="no-alerts">✓ No NO HR threat matchups detected yet. Check back once lineups post.</div>`;
    return;
  }
  c.innerHTML = alerts.map(a=>{
    const cls = a.type==='nohr-triple' ? 'alert-nohr-triple' : 'alert-nohr-double';
    const awayH = a.awayPitcher?.id ? handednessCache[a.awayPitcher.id] : null;
    const homeH = a.homePitcher?.id ? handednessCache[a.homePitcher.id] : null;
    const awayBadge = awayH ? `<span class="hand-badge ${awayH}" style="font-size:11px;width:20px;height:20px;">${awayH}</span>` : '';
    const homeBadge = homeH ? `<span class="hand-badge ${homeH}" style="font-size:11px;width:20px;height:20px;">${homeH}</span>` : '';

    // Actual venue league rank — venues sorted desc so find index from top
    const venueLeagueRank = a.venueData ? venues.indexOf(venues.find(v => v.venueId === a.venueData.venueId)) + 1 : '?';
    const venueHRs        = a.venueData?.hr ?? 0;
    // Actual team league rank — teamHRLeaderboard sorted desc (most HRs first)
    const allTeamIdx      = teamHRLeaderboard.findIndex(t => t.abbr === a.battingTeamAbbr);
    const teamLeagueRank  = allTeamIdx >= 0 ? allTeamIdx + 1 : '?';
    const teamHRs         = noHRTeams.find(t => t.abbr === a.battingTeamAbbr)?.hr ?? 0;

    const venueTag  = `<span class="tag tag-nohr-venue">Venue HR Rank · #${venueLeagueRank} of 30 · ${venueHRs} HRs</span>`;
    const teamTag   = `<span class="tag tag-nohr-team">Team HR Rank · #${teamLeagueRank} of 30 · ${teamHRs} HRs</span>`;
    const pitchTag  = a.bothPitchersNoHR ? `<span class="tag tag-nohr-pitcher">Both Pitchers Low HR</span>` : '';
    const tripleTag = a.type==='nohr-triple' ? `<span class="tag" style="background:rgba(223,0,255,0.15);color:#df00ff;border:1px solid rgba(223,0,255,0.4);">🛡️ ALL 3 CATEGORIES</span>` : '';

    const pitcherLine = a.type==='nohr-triple'
      ? `<div style="font-family:'IBM Plex Mono',monospace;font-size:11px;color:#c77dff;margin-top:6px;">
          ${awayBadge} <span ${a.awayPitcher?.id?`onclick="openPlayerModal(${a.awayPitcher.id},'${(a.awayPitcher.name||'').replace(/'/g,"\\'")}','${a.game.away.team}')" style="cursor:pointer;text-decoration:underline dotted;text-underline-offset:2px;"`:''}>${a.awayPitcher?.name||'TBD'}</span>
          · ${homeBadge} <span ${a.homePitcher?.id?`onclick="openPlayerModal(${a.homePitcher.id},'${(a.homePitcher.name||'').replace(/'/g,"\\'")}','${a.game.home.team}')" style="cursor:pointer;text-decoration:underline dotted;text-underline-offset:2px;"`:''}>${a.homePitcher?.name||'TBD'}</span>
          — Both Low HR Starters
         </div>`
      : '';

    return `<div class="${cls}">
      <div class="alert-game">${a.game.away.team} @ ${a.game.home.team} · ${a.game.time} · <span onclick="openTeamModal('${a.game.home.team}','${(a.game.home?.name||a.game.home?.team||'').replace(/'/g,"\\'")}');" style="cursor:pointer;text-decoration:underline dotted;text-underline-offset:2px;">${a.game.venue}</span></div>
      <div class="alert-matchup">
        <span onclick="openTeamModal('${a.battingTeamAbbr}','${a.battingTeamAbbr}');" style="color:#c77dff;font-weight:600;cursor:pointer;text-decoration:underline dotted;text-underline-offset:2px;">${a.battingTeamAbbr}</span>
        <span class="vs">batting at</span>
        <span onclick="openTeamModal('${a.game.home.team}','${(a.game.home?.name||a.game.home?.team||'').replace(/'/g,"\\'")}');" style="color:#c77dff;cursor:pointer;text-decoration:underline dotted;text-underline-offset:2px;">${a.game.venue}</span>
      </div>
      ${pitcherLine}
      <div class="alert-tags" style="margin-top:8px;">${venueTag}${teamTag}${pitchTag}${tripleTag}</div>
    </div>`;
  }).join('');
}

// ── RENDER ALERTS ────────────────────────────────────────────────────
function renderAlerts(alerts, skipEnrich=false) {
  window._lastAlerts = alerts; // Store for AI Challenge pick generation
  const c = document.getElementById('alertsContainer');
  if (!alerts.length) {
    c.innerHTML = `<div class="no-alerts">✓ No threat matchups detected yet. Check back once lineups post (~3hrs before first pitch).</div>`;
    return;
  }
  // Capture today's threats for the tracker (only on initial render, not H2H re-render)
  if (!skipEnrich) trackerCaptureToday(alerts);
  c.innerHTML = alerts.map(a=>{
    const cls         = a.type==='triple' ? 'alert-triple' : 'alert-double';
    const pitcherHand = a.pitcher?.id ? handednessCache[a.pitcher.id] : null;
    const batterHand  = a.hitter?.id  ? batHandCache[a.hitter.id]    : null;
    const pBadge = pitcherHand ? `<span class="hand-badge ${pitcherHand}" style="font-size:11px;width:20px;height:20px;">${pitcherHand}</span>` : '';
    const bBadge = batterHand  ? `<span class="hand-badge ${batterHand}"  style="font-size:11px;width:20px;height:20px;">${batterHand}</span>`  : '';

    // Clickable helpers
    const clickHitter  = a.hitter?.id  ? `onclick="openPlayerModal(${a.hitter.id},'${(a.hitter.name||'').replace(/'/g,"\\'")}','${a.game.away.team}')" style="cursor:pointer;text-decoration:underline dotted;text-underline-offset:2px;"` : '';
    const clickPitcher = a.pitcher?.id ? `onclick="openPlayerModal(${a.pitcher.id},'${(a.pitcher.name||'').replace(/'/g,"\\'")}','${a.game.home.team}')" style="cursor:pointer;text-decoration:underline dotted;text-underline-offset:2px;"` : '';
    const clickVenue   = `onclick="openTeamModal('${a.game.home.team}','${(a.game.home?.name||a.game.home?.team||'').replace(/'/g,"\\'")}');" style="cursor:pointer;text-decoration:underline dotted;text-underline-offset:2px;"`;

    // Build matchup line
    let matchupLine = '';
    if (a.venueOnly) {
      matchupLine = `<div class="alert-matchup"><span class="pitcher" ${clickPitcher}>${a.pitcher?.name||'TBD'}</span> ${pBadge} <span class="vs">at</span> <span style="color:var(--accent-gold)" ${clickVenue}>${a.game.venue}</span></div>`;
    } else if (a.hitter && a.pitcher?.name !== 'TBD') {
      matchupLine = `<div class="alert-matchup">${bBadge}<span class="batter" ${clickHitter}>${a.hitter.name}</span><span class="vs">vs</span>${pBadge}<span class="pitcher" ${clickPitcher}>${a.pitcher.name}</span></div>`;
    } else if (a.hitter && !a.hasPitcher) {
      matchupLine = `<div class="alert-matchup">${bBadge}<span class="batter" ${clickHitter}>${a.hitter.name}</span> <span class="vs">at</span> <span style="color:var(--accent-gold)" ${clickVenue}>${a.game.venue}</span></div>`;
    } else {
      matchupLine = `<div class="alert-matchup">${bBadge}<span class="batter" ${clickHitter}>${a.hitter?.name||'—'}</span><span class="vs">vs</span>${pBadge}<span class="pitcher" ${clickPitcher}>${a.pitcher?.name||'TBD'}</span></div>`;
    }

    const hitterTag  = a.hitter  ? `<span class="tag tag-hr">HR Rank #${a.hitter.rank} · ${a.hitter.hr} HR</span>` : '';
    const recentHRTag = a.hitter && a.hitter.l5HR != null
      ? `<span class="tag" style="background:rgba(96,165,250,0.1);color:#60a5fa;border:1px solid rgba(96,165,250,0.25);font-family:'IBM Plex Mono',monospace;letter-spacing:0.03em;">L5: ${a.hitter.l5HR} HR &nbsp;|&nbsp; L10: ${a.hitter.l10HR} HR</span>`
      : '';
    const pitcherTag = a.hasPitcher && a.pitcher?.rank !== '—'
      ? `<span class="tag tag-pitcher">Pitcher Rank #${a.pitcher.rank} · ${a.pitcher.hr} HR allowed</span>`
      : a.earlyseason ? `<span class="tag tag-pitcher">Starting Pitcher · Early Season</span>` : '';
    const venueTag   = a.hasVenue ? `<span class="tag tag-venue">Top 10 Venue · #${a.venueRank} · ${a.venueData?.hr||0} HRs</span>` : '';
    const tripleTag  = a.type==='triple' ? `<span class="tag tag-rank">⚡ ALL 3 CATEGORIES</span>` : '';

    return `<div class="${cls}">
      <div class="alert-game">${a.game.away.team} @ ${a.game.home.team} · ${a.game.time} · <span ${clickVenue}>${a.game.venue}</span>${a.probable?' · (Probable – lineup TBD)':''}</div>
      ${matchupLine}
      ${a.type==='triple'?`<div class="alert-venue">📍 <span ${clickVenue}>${a.game.venue}</span> — #${a.venueRank} HR Venue · ${a.venueData?.hr||''} HRs this season</div>`:''}
      <div class="alert-tags">
        ${hitterTag}${recentHRTag}${pitcherTag}${venueTag}${tripleTag}
        <span class="tag tag-time">${a.game.time}</span>
      </div>
      ${a.h2h ? h2hStrip(a.h2h, a.pitcher?.name||'') : ''}
    </div>`;
  }).join('');

  // Async H2H enrichment — fetch in background then re-render cleanly
  if (!skipEnrich) enrichAlertsWithH2H(alerts);
}
function tiedRanks(list, valKey) {
  const ranks = [];
  let rank = 1;
  for (let i = 0; i < list.length; i++) {
    if (i > 0 && list[i][valKey] < list[i-1][valKey]) rank = i + 1;
    ranks.push(rank);
  }
  return ranks;
}

// ── FETCH HR EVENTS FOR A GAME ───────────────────────────────────────
async function fetchGameHREvents(gamePk) {
  // Return cached data if fresh (< 90s old)
  const cached = _gameHRCache[gamePk];
  if (cached && Date.now() - cached.ts < 90000) return cached.events;
  try {
    // Use boxscore to get HR counts per player, then play-by-play for inning details
    const box = await fetchJSON(`${BASE}/game/${gamePk}/boxscore`);
    const events = [];
    for (const side of ['away', 'home']) {
      const players = box?.teams?.[side]?.players || {};
      for (const [, pd] of Object.entries(players)) {
        const hrs = pd?.stats?.batting?.homeRuns || 0;
        if (hrs > 0) {
          const id   = pd?.person?.id;
          const name = pd?.person?.fullName || '—';
          events.push({ playerId: id, name, hrs, team: side });
        }
      }
    }
    // Now get play-by-play for inning + type details
    try {
      const pb = await fetchJSON(`${BASE}/game/${gamePk}/playByPlay`);
      const allPlays = pb?.allPlays || [];
      // Build a map of batter id -> HR play details
      const hrDetails = {};
      for (const play of allPlays) {
        if (play?.result?.eventType === 'home_run') {
          const batterId = play?.matchup?.batter?.id;
          const inning   = play?.about?.inning;
          const half     = play?.about?.halfInning === 'top' ? 'T' : 'B';
          const desc     = play?.result?.description || '';
          let type = 'Solo';
          if (desc.toLowerCase().includes('grand slam'))  type = 'Grand Slam';
          else if (desc.includes('3-run') || desc.includes('three-run')) type = '3-Run';
          else if (desc.includes('2-run') || desc.includes('two-run'))   type = '2-Run';
          if (!hrDetails[batterId]) hrDetails[batterId] = [];
          hrDetails[batterId].push({ inning: `${half}${inning}`, type });
        }
      }
      // Enrich events with inning/type from play-by-play
      const enriched = [];
      for (const e of events) {
        const details = hrDetails[e.playerId] || [];
        if (details.length > 0) {
          for (const d of details) {
            enriched.push({ ...e, inning: d.inning, type: d.type });
          }
        } else {
          // No play detail — just show the player hit a HR
          for (let i = 0; i < e.hrs; i++) {
            enriched.push({ ...e, inning: '—', type: 'HR' });
          }
        }
      }
      // Sort by inning
      enriched.sort((a, b) => {
        const aNum = parseInt(a.inning.slice(1)) || 0;
        const bNum = parseInt(b.inning.slice(1)) || 0;
        return aNum - bNum;
      });
      _gameHRCache[gamePk] = { events: enriched, ts: Date.now() };
      return enriched;
    } catch {
      // Play-by-play failed — return events without inning details
      const simple = events.map(e => ({ ...e, inning: '—', type: 'HR' }));
      _gameHRCache[gamePk] = { events: simple, ts: Date.now() };
      return simple;
    }
  } catch { return []; }
}

// ── RENDER HR HITTERS ────────────────────────────────────────────────
function renderHitters(alertIds) {
  const max = hitters[0]?.hr||1;
  const ranks = tiedRanks(hitters, 'hr');
  document.getElementById('hitters-body').innerHTML = hitters.map((p,i)=>{
    const isAlert  = alertIds?.has(p.id);
    const hBadge   = handBadge(p.hand);
    const tc       = teamColor(p.team);
    const rowStyle = tc ? `style="background:${tc}12;border-left:2px solid ${tc}55;"` : '';
    const safeName = (p.name||'').replace(/'/g, "\\'");
    const vsLCell = `<td class="stat-val" style="color:#60a5fa;font-size:11px;text-align:center;">${p.vsL !== null && p.vsL !== undefined ? p.vsL : '—'}</td>`;
    const vsRCell = `<td class="stat-val" style="color:var(--accent-red);font-size:11px;text-align:center;">${p.vsR !== null && p.vsR !== undefined ? p.vsR : '—'}</td>`;
    return `<tr class="${isAlert?'hl-blue':''}" ${isAlert?'':rowStyle}>
      <td class="rank">${ranks[i]}</td>
      <td style="width:20px;padding-right:4px;">${hBadge}</td>
      <td>
        <div class="player-name" onclick="openPlayerModal(${p.id},'${safeName}','${p.team}',${p.vsL??'null'},${p.vsR??'null'})" style="cursor:pointer;text-decoration:underline dotted;text-underline-offset:2px;">${p.name} <span class="name-team-tag">${p.team} (${p.league})</span>${isAlert?'<span class="alert-dot"></span>':''}</div>
      </td>
      <td class="stat-val blue">${p.hr}</td>
      ${vsLCell}${vsRCell}
      <td class="bar-cell"><div class="mini-bar"><div class="mini-bar-fill blue" style="width:${Math.round(p.hr/max*100)}%"></div></div></td>
    </tr>`;
  }).join('');
}

// ── RENDER PITCHER TABLE (with handedness) ───────────────────────────
function renderPitcherTable(tbodyId, list, color, valKey, alertIds) {
  const max = list[0]?.[valKey]||1;
  const ranks = tiedRanks(list, valKey);
  const todayPitcherIds = new Set(todayGames.flatMap(g => [g.away.pitcherId, g.home.pitcherId].filter(Boolean)));
  const koPitcherIds    = new Set((koPitchers||[]).map(p => p.id));
  const hrPitcherIds    = new Set((hrPitchers||[]).map(p => p.id));
  document.getElementById(tbodyId).innerHTML = list.map((p,i)=>{
    const isAlert    = alertIds?.has(p.id);
    const isToday    = todayPitcherIds.has(p.id);
    const isHRList   = valKey === 'hr';
    const isCross    = isHRList ? koPitcherIds.has(p.id) : hrPitcherIds.has(p.id);
    const hBadge     = handBadge(p.hand);
    const tc         = teamColor(p.team);
    const pulseClass = isToday ? (isHRList ? 'pitcher-today-hr' : 'pitcher-today-k') : '';
    const rowStyle   = (!isToday && !isAlert && tc) ? 'style="background:' + tc + '12;border-left:2px solid ' + tc + '55;"' : '';
    const todayColor = isHRList
      ? 'background:rgba(250,204,21,0.2);color:var(--accent-gold);border:1px solid rgba(250,204,21,0.4);'
      : 'background:rgba(56,189,248,0.2);color:var(--accent-blue);border:1px solid rgba(56,189,248,0.4);';
    const crossColor = isHRList
      ? 'background:rgba(56,189,248,0.15);color:var(--accent-blue);border:1px solid rgba(56,189,248,0.3);'
      : 'background:rgba(230,57,70,0.15);color:var(--accent-red);border:1px solid rgba(230,57,70,0.3);';
    const todayBadge = isToday
      ? '<span style="font-family:var(--font-mono);font-size:8px;font-weight:700;padding:1px 5px;border-radius:3px;margin-left:5px;letter-spacing:0.08em;' + todayColor + '">PITCHING TODAY</span>'
      : '';
    const crossBadge = isCross
      ? '<span style="font-family:var(--font-mono);font-size:8px;padding:1px 5px;border-radius:3px;margin-left:4px;' + crossColor + '">TOP 25 ' + (isHRList ? 'K' : 'HR') + '</span>'
      : '';
    const safeName = (p.name||'').replace(/'/g, "\\'");
    const vsLCell = isHRList
      ? `<td class="stat-val" style="color:var(--accent-blue);font-size:11px;text-align:center;">${p.vsL !== null && p.vsL !== undefined ? p.vsL : '—'}</td>`
      : '';
    const vsRCell = isHRList
      ? `<td class="stat-val" style="color:var(--accent-red);font-size:11px;text-align:center;">${p.vsR !== null && p.vsR !== undefined ? p.vsR : '—'}</td>`
      : '';
    return `<tr class="${isAlert?'hl-'+color:''} ${pulseClass}" ${(!isAlert&&!isToday)?rowStyle:''}>
      <td class="rank">${ranks[i]}</td>
      <td style="width:20px;padding-right:4px;">${hBadge}</td>
      <td><div class="player-name" onclick="openPlayerModal(${p.id},'${safeName}','${p.team}',${p.vsL??'null'},${p.vsR??'null'})" style="cursor:pointer;text-decoration:underline dotted;text-underline-offset:2px;">${p.name} <span class="name-team-tag">${p.team} (${p.league})</span>${isAlert?'<span class="alert-dot"></span>':''}${todayBadge}${crossBadge}</div></td>
      <td class="stat-val ${color}">${p[valKey]}</td>
      ${vsLCell}${vsRCell}
      <td class="bar-cell"><div class="mini-bar"><div class="mini-bar-fill ${color}" style="width:${Math.round(p[valKey]/max*100)}%"></div></div></td>
    </tr>`;
  }).join('');
}
// ── RENDER KO PITCHERS (with K/G) ────────────────────────────────────
function renderKOPitchers() {
  const max = koPitchers[0]?.k||1;
  const ranks = tiedRanks(koPitchers, 'k');
  const todayPitcherIds = new Set(todayGames.flatMap(g => [g.away.pitcherId, g.home.pitcherId].filter(Boolean)));
  const hrPitcherIds    = new Set((hrPitchers||[]).map(p => p.id));
  document.getElementById('ko-body').innerHTML = koPitchers.map((p,i)=>{
    const isToday  = todayPitcherIds.has(p.id);
    const isHRAlso = hrPitcherIds.has(p.id);
    const hBadge   = handBadge(p.hand);
    const tc       = teamColor(p.team);
    const pulseClass = isToday ? 'pitcher-today-k' : '';
    const rowStyle   = (!isToday && tc) ? 'style="background:' + tc + '12;border-left:2px solid ' + tc + '55;"' : '';
    const todayBadge = isToday
      ? '<span style="font-family:var(--font-mono);font-size:8px;font-weight:700;padding:1px 5px;border-radius:3px;margin-left:5px;background:rgba(56,189,248,0.2);color:var(--accent-blue);border:1px solid rgba(56,189,248,0.4);letter-spacing:0.08em;">PITCHING TODAY</span>'
      : '';
    const hrBadge = isHRAlso
      ? '<span style="font-family:var(--font-mono);font-size:8px;padding:1px 5px;border-radius:3px;margin-left:4px;background:rgba(230,57,70,0.15);color:var(--accent-red);border:1px solid rgba(230,57,70,0.3);">TOP 25 HR</span>'
      : '';
    const safeKoName = (p.name||'').replace(/'/g, "\\'");
    const homeKCell = `<td class="stat-val" style="color:#60a5fa;font-size:11px;text-align:center;">${p.homeK !== null && p.homeK !== undefined ? p.homeK + (p.homeKpg ? ' · '+p.homeKpg+'/G' : '') : '—'}</td>`;
    const awayKCell = `<td class="stat-val" style="color:var(--accent-red);font-size:11px;text-align:center;">${p.awayK !== null && p.awayK !== undefined ? p.awayK + (p.awayKpg ? ' · '+p.awayKpg+'/G' : '') : '—'}</td>`;
    return `<tr class="${pulseClass}" ${!isToday?rowStyle:''}>
      <td class="rank">${ranks[i]}</td>
      <td style="width:20px;padding-right:4px;">${hBadge}</td>
      <td><div class="player-name" onclick="openPlayerModal(${p.id},'${safeKoName}','${p.team}')" style="cursor:pointer;text-decoration:underline dotted;text-underline-offset:2px;">${p.name} <span class="name-team-tag">${p.team} (${p.league})</span>${todayBadge}${hrBadge}</div></td>
      <td class="stat-val" style="color:var(--text-mid);font-size:11px;">${p.games}</td>
      <td class="stat-val purple">${p.k}</td>
      <td class="stat-val" style="color:var(--text-mid);font-size:11px;">${p.kpg}</td>
      ${homeKCell}${awayKCell}
      <td class="bar-cell"><div class="mini-bar"><div class="mini-bar-fill purple" style="width:${Math.round(p.k/max*100)}%"></div></div></td>
    </tr>`;
  }).join('');
}

// ── RENDER ALL 30 VENUES (replaces Top 10 panel) ─────────────────────
function renderAllVenues(alertVenueIds) {
  const max = venues[0]?.hr||1;
  const ranks = tiedRanks(venues, 'hr');
  document.getElementById('all-venues-body').innerHTML = venues.map((v,i)=>{
    const isTop10    = i < 10;
    const isBottom10 = i >= 20;
    const isAlert    = alertVenueIds?.has(v.venueId);
    let rowClass = '';
    if (isTop10)    rowClass = 'hl-top-venue';
    if (isBottom10) rowClass = 'hl-bottom-venue';
    const star   = isTop10    ? ' <span style="color:var(--accent-gold);font-size:9px;">▲TOP</span>' : '';
    const bottom = isBottom10 ? ' <span style="color:var(--accent-purple);font-size:9px;">▼BOT</span>' : '';
    return `<tr class="${rowClass}">
      <td class="rank">${ranks[i]}</td>
      <td>
        <div class="player-name" onclick="openTeamModal('${v.team}','${v.name.replace(/'/g,"\\'")}');" style="cursor:pointer;text-decoration:underline dotted;text-underline-offset:2px;">${v.name}${star}${bottom}${isAlert?'<span class="alert-dot"></span>':''}</div>
        <span class="team-badge">${v.team}</span>
      </td>
      <td class="stat-val gold">${v.hr}</td>
      <td class="bar-cell"><div class="mini-bar"><div class="mini-bar-fill gold" style="width:${Math.round(v.hr/max*100)}%"></div></div></td>
    </tr>`;
  }).join('');
}

// ── RENDER ALL 30 STADIUMS ───────────────────────────────────────────
function renderAllStadiums() {
  const perCol = 10;
  const allRanks = tiedRanks(venues, 'hr');
  const cols = [venues.slice(0,perCol), venues.slice(perCol,perCol*2), venues.slice(perCol*2)];
  document.getElementById('stadiums-inner').innerHTML = cols.map((col, ci)=>`
    <div class="stadiums-col-wrap">
      <div class="col-header">${ci===0?'#1 – #10':ci===1?'#11 – #20':'#21 – #30'}</div>
      ${col.map((v,i)=>{
        const globalIdx = i + ci*perCol;
        const isTop10 = globalIdx < 10;
        return `<div class="venue-row ${isTop10?'top10':''}" onclick="openTeamModal('${v.team}','${v.name.replace(/'/g,"\\'")}');" style="cursor:pointer;">
          <span class="venue-rank-badge">${allRanks[globalIdx]}</span>
          <div class="venue-info">
            <div class="venue-name-text">${v.name} ${isTop10?'<span class="star-mark">⭐</span>':''}</div>
            <div class="venue-team-text">${v.team}</div>
          </div>
          <span class="venue-hr-val">${v.hr}</span>
        </div>`;
      }).join('')}
    </div>
  `).join('');
}

// ── RENDER TEAM HR LEADERBOARD ────────────────────────────────────────
function renderTeamHRLeaderboard() {
  const max = teamHRLeaderboard[0]?.hr||1;
  const ranks = tiedRanks(teamHRLeaderboard, 'hr');
  document.getElementById('team-hr-body').innerHTML = teamHRLeaderboard.map((t,i)=>{
    const tc = teamColor(t.abbr);
    const rowStyle = tc ? `style="background:${tc}12;border-left:2px solid ${tc}55;"` : '';
    return `<tr ${rowStyle}>
      <td class="rank">${ranks[i]}</td>
      <td>
        <div class="player-name" onclick="openTeamModal('${t.abbr}','${(t.name||'').replace(/'/g,"\\'")}');" style="cursor:pointer;text-decoration:underline dotted;text-underline-offset:2px;">${t.name} <span class="name-team-tag">${t.abbr} (${t.league})</span></div>
      </td>
      <td class="stat-val" style="color:var(--accent-green);">${t.hr}</td>
      <td class="bar-cell"><div class="mini-bar"><div class="mini-bar-fill" style="width:${Math.round(t.hr/max*100)}%;background:var(--accent-green);"></div></div></td>
    </tr>`;
  }).join('');
}

// ── RENDER TEAM STRIKEOUT LEADERBOARD (with K/G and Home/Road splits) ─
function renderTeamKLeaderboard() {
  const max = teamKLeaderboard[0]?.k||1;
  const ranks = tiedRanks(teamKLeaderboard, 'k');
  document.getElementById('team-k-body').innerHTML = teamKLeaderboard.map((t,i)=>{
    const tc = teamColor(t.abbr);
    const rowStyle = tc ? `style="background:${tc}12;border-left:2px solid ${tc}55;"` : '';
    const homeKCell = `<td class="stat-val" style="color:#60a5fa;font-size:11px;text-align:center;">${t.homeK !== null && t.homeK !== undefined ? t.homeK + (t.homeKpg ? ' · '+t.homeKpg+'/G' : '') : '—'}</td>`;
    const awayKCell = `<td class="stat-val" style="color:var(--accent-red);font-size:11px;text-align:center;">${t.awayK !== null && t.awayK !== undefined ? t.awayK + (t.awayKpg ? ' · '+t.awayKpg+'/G' : '') : '—'}</td>`;
    return `<tr ${rowStyle}>
      <td class="rank">${ranks[i]}</td>
      <td>
        <div class="player-name" onclick="openTeamModal('${t.abbr}','${(t.name||'').replace(/'/g,"\\'")}');" style="cursor:pointer;text-decoration:underline dotted;text-underline-offset:2px;">${t.name} <span class="name-team-tag">${t.abbr} (${t.league})</span></div>
      </td>
      <td class="stat-val purple">${t.k}</td>
      <td class="stat-val" style="color:var(--text-mid);font-size:11px;">${t.kpg}</td>
      ${homeKCell}${awayKCell}
      <td class="bar-cell"><div class="mini-bar"><div class="mini-bar-fill purple" style="width:${Math.round(t.k/max*100)}%"></div></div></td>
    </tr>`;
  }).join('');
}
function liveScoreHTML(game) {
  const awayTc = teamColor(game.away.team)||'transparent';
  const homeTc = teamColor(game.home.team)||'transparent';
  if (game.isLive && game.awayRuns !== null) {
    const halfSymbol = game.inningHalf === 'Top' ? '▲' : '▼';
    const awayWin = game.awayRuns > game.homeRuns;
    const homeWin = game.homeRuns > game.awayRuns;
    return `<div class="live-score is-live" style="margin:0 14px 0;">
      <div class="score-team" style="background:${awayTc}18;border-radius:6px;padding:4px 8px;">
        <span class="score-abbr">${game.away.team}</span>
        <span class="score-runs ${awayWin?'winning':''}">${game.awayRuns}</span>
      </div>
      <div class="score-middle">
        <span class="inning-badge live">${halfSymbol} ${game.inningOrd||''}</span>
        <span class="score-dash">LIVE</span>
        ${game.outs !== null && game.outs !== undefined ? `<span style="font-family:'IBM Plex Mono',monospace;font-size:9px;color:#ffffff;margin-left:4px;font-weight:500;">${game.outs} out${game.outs !== 1 ? 's' : ''}</span>` : ''}
      </div>
      <div class="score-team" style="background:${homeTc}18;border-radius:6px;padding:4px 8px;">
        <span class="score-runs ${homeWin?'winning':''}">${game.homeRuns}</span>
        <span class="score-abbr">${game.home.team}</span>
      </div>
    </div>`;
  } else if (game.isFinal) {
    const awayWin = (game.awayRuns??0) > (game.homeRuns??0);
    const homeWin = (game.homeRuns??0) > (game.awayRuns??0);
    const awayScore = game.awayRuns !== null ? game.awayRuns : '—';
    const homeScore = game.homeRuns !== null ? game.homeRuns : '—';
    return `<div class="live-score is-final" style="margin:0 14px 0;">
      <div class="score-team" style="background:${awayTc}15;border-radius:6px;padding:4px 8px;">
        <span class="score-abbr">${game.away.team}</span>
        <span class="score-runs" style="color:${awayWin?'var(--accent-red)':'var(--text-mid)'};">${awayScore}</span>
      </div>
      <div class="score-middle">
        <span class="inning-badge final">FINAL</span>
      </div>
      <div class="score-team" style="background:${homeTc}15;border-radius:6px;padding:4px 8px;">
        <span class="score-runs" style="color:${homeWin?'var(--accent-red)':'var(--text-mid)'};">${homeScore}</span>
        <span class="score-abbr">${game.home.team}</span>
      </div>
    </div>`;
  } else {
    return `<div class="live-score" style="margin:0 14px 0;justify-content:center;">
      <span class="inning-badge scheduled">🕐 ${game.time}</span>
    </div>`;
  }
}

// ── RENDER GAME SLATE ────────────────────────────────────────────────
async function renderGames(alerts, noHRAlerts) {
  const container = document.getElementById('gamesContainer');
  const hitterIds  = new Set(hitters.map(h=>h.id));
  const hitterMap  = Object.fromEntries(hitters.map((h,i)=>[h.id,{...h,rank:i+1}]));
  const pitcherIds = new Set(hrPitchers.map(p=>p.id));
  const top10MinHR = venues.length >= 10 ? venues[9].hr : 0;
  const top10Ids   = new Set(venues.filter(v => v.hr >= top10MinHR).map(v=>v.venueId));

  if (!todayGames.length) {
    container.innerHTML = `<div style="font-family:'IBM Plex Mono',monospace;font-size:12px;color:var(--text-dim);padding:20px 0;">No games scheduled today or schedule not yet available.</div>`;
    return;
  }

  const threatMap = {};
  for (const a of alerts) {
    const pk = a.game.gamePk;
    if (a.type==='triple') threatMap[pk]='triple';
    else if (!threatMap[pk]) threatMap[pk]='double';
  }

  const noHRThreatMap = {};
  for (const a of (noHRAlerts||[])) {
    const pk = a.game.gamePk;
    if (a.type==='nohr-triple') noHRThreatMap[pk]='nohr-triple';
    else if (!noHRThreatMap[pk]) noHRThreatMap[pk]='nohr-double';
  }

  // Team HR leaders in parallel — each wrapped so one failure doesn't break others
  const leaderResults = await Promise.all(todayGames.map(async g=>{
    const [awayLeaders, homeLeaders] = await Promise.all([
      g.away.id ? fetchTeamHRLeaders(g.away.id).catch(()=>[]) : Promise.resolve([]),
      g.home.id ? fetchTeamHRLeaders(g.home.id).catch(()=>[]) : Promise.resolve([]),
    ]);
    return { gamePk: g.gamePk, awayLeaders, homeLeaders };
  }));
  const leaderMap = Object.fromEntries(leaderResults.map(r=>[r.gamePk,r]));

  // H2H for alerts (threat players)
  const h2hMap = {};
  for (const a of alerts) {
    if (!a.hitter?.id || !a.pitcher?.id) continue;
    const key = `${a.game.gamePk}-${a.hitter.id}-${a.pitcher.id}`;
    if (!h2hMap[key]) h2hMap[key] = fetchH2H(a.hitter.id, a.pitcher.id);
  }

  // ALSO fetch H2H for top 3 leaders on each team vs today's starter
  // This ensures all game cards show H2H even without threat alerts
  for (const game of todayGames) {
    const awayPitcherId = game.home.pitcherId;
    const homePitcherId = game.away.pitcherId;
    for (const [leaders, pitcherId] of [
      [leaderMap[game.gamePk]?.awayLeaders, awayPitcherId],
      [leaderMap[game.gamePk]?.homeLeaders, homePitcherId]
    ]) {
      if (!leaders || !pitcherId) continue;
      for (const p of leaders.slice(0, 3)) {
        if (!p?.id) continue;
        const key = `${game.gamePk}-${p.id}-${pitcherId}`;
        if (!h2hMap[key]) h2hMap[key] = fetchH2H(p.id, pitcherId);
      }
    }
  }

  const h2hKeys = Object.keys(h2hMap);
  const h2hVals = await Promise.all(Object.values(h2hMap));
  const h2h = Object.fromEntries(h2hKeys.map((k,i)=>[k,h2hVals[i]]));

  const gameAlertsMap = {};
  for (const a of alerts) {
    if (!a.game?.gamePk) continue;
    if (!gameAlertsMap[a.game.gamePk]) gameAlertsMap[a.game.gamePk] = [];
    gameAlertsMap[a.game.gamePk].push(a);
  }

  container.innerHTML = todayGames.map(game=>{
    // Safety guard — skip any game with missing team data
    if (!game || !game.away || !game.home) return '';
    try {

    const threat    = threatMap[game.gamePk];
    const leaders   = leaderMap[game.gamePk];
    const gAlerts   = gameAlertsMap[game.gamePk]||[];
    const isTop10V  = top10Ids.has(game.venueId);

    // Calculate HR Probability Score
    // Hide on NO HR threat games — score contradicts the purpose
    const isNoHRGame = !!noHRThreatMap[game.gamePk];
    const hrps = !isNoHRGame ? calcHRProbScore(game, hitterIds, hitterMap, pitcherIds, leaders?.awayLeaders, leaders?.homeLeaders) : null;

    // Enforce score floors/caps so threat badges and scores are always consistent
    if (hrps) {
      if (threat === 'triple')      { if (hrps.score < 8) hrps.score = 8; } // Triple = 8-10 minimum
      else if (threat === 'double') { if (hrps.score < 6) hrps.score = 6; } // Double = 6-7 minimum
      else                          { if (hrps.score > 4) hrps.score = 4; } // No threat = 1-4 max
    }

    const hrpsHTML = hrps ? `
      <div class="hrps-wrap">
        <div class="hrps-left">
          <div class="hrps-label-top">HR PROBABILITY</div>
          <div class="hrps-tier-text" style="color:${hrpsColor(hrps.score)};">${hrpsTier(hrps.score)}</div>
        </div>
        <div class="hrps-bar-wrap">
          <div class="hrps-bar"><div class="hrps-fill" style="width:${hrps.score*10}%;background:${hrpsColor(hrps.score)};"></div></div>
        </div>
        <div class="hrps-score-big" style="color:${hrpsColor(hrps.score)};">${hrps.score}<span class="hrps-denom">/10</span></div>
        <button class="hrps-info-btn" onclick="event.stopPropagation();showLegend(this)" title="How is this calculated?">ⓘ</button>
      </div>` : '';

    function leaderRows(arr, teamAbbr) {
      return (arr||[]).map(p=>{
        const isTop25 = hitterIds.has(p.id);
        const batHand = batHandCache[p.id];
        const vsLStr  = p.vsL !== null && p.vsL !== undefined ? p.vsL : '—';
        const vsRStr  = p.vsR !== null && p.vsR !== undefined ? p.vsR : '—';
        const splitBadge = `<span style="font-family:'IBM Plex Mono',monospace;font-size:9px;margin-left:6px;"><span style="color:#60a5fa;">vL:${vsLStr}</span> <span style="color:var(--text-dim);">|</span> <span style="color:var(--accent-red);">vR:${vsRStr}</span></span>`;
        return `<div class="hitter-row" onclick="event.stopPropagation();openPlayerModal(${p.id},'${(p.name||'').replace(/'/g,"\'")}','${teamAbbr}',${p.vsL??'null'},${p.vsR??'null'})" style="cursor:pointer;border-radius:4px;transition:background 0.15s;" onmouseover="this.style.background='rgba(255,255,255,0.05)'" onmouseout="this.style.background=''">
          <div class="hitter-row-name">
            ${batHand ? handBadge(batHand) : ''}
            ${p.name}${isTop25?`<span class="top25-badge">#${hitterMap[p.id]?.rank} TOP 25</span>`:''}${splitBadge}
          </div>
          <div class="hitter-row-hr">${p.hr} HR</div>
        </div>`;
      }).join('') || `<div style="font-family:'IBM Plex Mono',monospace;font-size:10px;color:var(--text-dim)">No data yet</div>`;
    }

    function pitcherLine(side) {
      if (!game[side]) return '';
      const pName = game[side].pitcherName;
      const pId   = game[side].pitcherId;
      const pTeam = game[side].team;
      const hand  = pId ? handednessCache[pId] : null;
      const isTop25HR = pId && pitcherIds.has(pId);
      const isTop25K  = pId && new Set((koPitchers||[]).map(p=>p.id)).has(pId);
      const label = side==='away' ? 'Away SP' : 'Home SP';
      const clickable = pId && pName;
      return `<div class="pitcher-line" ${clickable?`onclick="event.stopPropagation();openPlayerModal(${pId},'${(pName||'').replace(/'/g,"\\'")}','${pTeam}')" style="cursor:pointer;border-radius:4px;transition:background 0.15s;" onmouseover="this.style.background='rgba(255,255,255,0.05)'" onmouseout="this.style.background=''"`:''}>
        <div class="pitcher-line-left">
          ${hand ? handBadge(hand) : ''}
          <div class="pitcher-name-label">${label}: <span>${pName||'TBD'}</span></div>
        </div>
        <div class="pitcher-badges">
          ${isTop25HR?`<span class="top25-badge" style="background:rgba(230,57,70,0.15);color:var(--accent-red);border-color:rgba(230,57,70,0.3);">TOP 25 HR</span>`:''}
          ${isTop25K?`<span class="top25-badge" style="background:rgba(56,189,248,0.15);color:var(--accent-blue);border-color:rgba(56,189,248,0.3);">TOP 25 K</span>`:''}
        </div>
      </div>`;
    }

    // Build H2H rows — use alerts if available, fall back to top leaders vs starter
    const gameLeaders = leaderMap[game.gamePk];
    let h2hPairs = [];

    if (gAlerts.length > 0) {
      h2hPairs = gAlerts.slice(0,3).filter(a => a.hitter?.id && a.pitcher?.id).map(a => ({
        hitterId: a.hitter.id, hitterName: a.hitter.name, hitterTeam: game.away.team,
        pitcherId: a.pitcher.id, pitcherName: a.pitcher.name, pitcherTeam: game.home.team,
      }));
    } else {
      const awayPitcherId   = game.home.pitcherId;
      const awayPitcherName = game.home.pitcherName || 'TBD';
      const homePitcherId   = game.away.pitcherId;
      const homePitcherName = game.away.pitcherName || 'TBD';
      for (const p of (gameLeaders?.awayLeaders||[]).slice(0,2)) {
        if (p?.id && awayPitcherId) h2hPairs.push({ hitterId: p.id, hitterName: p.name, hitterTeam: game.away.team, pitcherId: awayPitcherId, pitcherName: awayPitcherName, pitcherTeam: game.home.team });
      }
      for (const p of (gameLeaders?.homeLeaders||[]).slice(0,2)) {
        if (p?.id && homePitcherId) h2hPairs.push({ hitterId: p.id, hitterName: p.name, hitterTeam: game.home.team, pitcherId: homePitcherId, pitcherName: homePitcherName, pitcherTeam: game.away.team });
      }
    }

    const h2hRows = h2hPairs.map(pair => {
      const key  = `${game.gamePk}-${pair.hitterId}-${pair.pitcherId}`;
      const stat = h2h[key];
      const hand = handednessCache[pair.pitcherId];
      const fmtAvg = stat ? (stat.avg > 0 ? stat.avg.toFixed(3).replace('0.','.') : '.000') : '';
      const fmtOps = stat ? (stat.ops > 0 ? stat.ops.toFixed(3).replace('0.','.') : '.000') : '';
      const statsStr = stat ? `${stat.ab} AB · ${stat.hr} HR · ${fmtAvg} BA · ${fmtOps} OPS` : 'No career data';
      return `<div class="h2h-row">
        <div class="h2h-names">
          <strong onclick="event.stopPropagation();openPlayerModal(${pair.hitterId},'${(pair.hitterName||'').replace(/'/g,"\'")}','${pair.hitterTeam}')" style="cursor:pointer;text-decoration:underline dotted;text-underline-offset:2px;">${pair.hitterName}</strong>
          vs ${hand?handBadge(hand):''}
          <strong onclick="event.stopPropagation();openPlayerModal(${pair.pitcherId},'${(pair.pitcherName||'').replace(/'/g,"\'")}','${pair.pitcherTeam}')" style="cursor:pointer;text-decoration:underline dotted;text-underline-offset:2px;">${pair.pitcherName}</strong>
        </div>
        <div class="h2h-stats">${statsStr}</div>
      </div>`;
    }).join('');


    const awayColor = teamColor(game.away.team) || '#4b5563';
    const homeColor = teamColor(game.home.team) || '#4b5563';
    const awayGlow  = awayColor + '40';
    const homeGlow  = homeColor + '40';

    return `<div class="game-card ${threat?threat+'-game':noHRThreatMap[game.gamePk]?noHRThreatMap[game.gamePk]+'-game':''}"
      style="--away-color:${awayColor};--home-color:${homeColor};--away-glow:${awayGlow};--home-glow:${homeGlow};"
      onclick="openGameModal(${game.gamePk})">
      <div class="game-card-header">
        <div class="card-top-bar"></div>
        <div class="card-header-inner">
          <div class="card-matchup-row">
            <div class="game-teams">
              <span class="away">${game.away.team}</span>
              <span class="at">@</span>
              <span class="home">${game.home.team}</span>
            </div>
            <span class="card-time-chip">${game.time}</span>
          </div>
          <div class="card-meta-row">
            <div class="game-meta" onclick="event.stopPropagation();openTeamModal('${game.home.team}','${(game.home.name||game.home.team).replace(/'/g,"\\'")}');return false;" style="cursor:pointer;" title="View ${game.home.name||game.home.team} info">
              📍 ${game.venue}${isTop10V?' ⭐':''}
            </div>
          </div>
          ${(threat || noHRThreatMap[game.gamePk]) ? `
          <div class="card-badge-row">
            ${threat?`<div class="threat-badge ${threat}">${threat==='triple'?'⚡ Triple Threat':'🔶 Double Threat'}</div>`:''}
            ${noHRThreatMap[game.gamePk]?`<div class="threat-badge ${noHRThreatMap[game.gamePk]}">${noHRThreatMap[game.gamePk]==='nohr-triple'?'⚡ No HR Triple':'🛡 No HR Double'}</div>`:''}
          </div>` : ''}
        </div>
      </div>
      ${hrpsHTML}
      ${liveScoreHTML(game)}
      <div class="game-card-body">
        <div class="team-section" style="--section-color:${teamTextColor(game.away.team)};">
          <div class="team-label">${game.away.team} — Top HR Hitters</div>
          ${leaderRows(leaders?.awayLeaders, game.away.team)}
        </div>
        <div class="team-section" style="--section-color:${teamTextColor(game.home.team)};">
          <div class="team-label">${game.home.team} — Top HR Hitters</div>
          ${leaderRows(leaders?.homeLeaders, game.home.team)}
        </div>
        <div class="pitcher-matchup">
          <div class="pitcher-matchup-label">⚾ Starting Pitchers</div>
          ${pitcherLine('away')}
          ${pitcherLine('home')}
        </div>
        ${h2hRows&&!game.isLive&&!game.isFinal?`<div class="h2h-section"><div class="h2h-label">⚔ Head-to-Head History</div>${h2hRows}</div>`:''}
        <div id="hr-ticker-${game.gamePk}" class="game-hr-ticker" style="display:none;"></div>
      </div>
    </div>`;
    } catch(e) {
      console.error('Game card render error for', game?.away?.team, '@', game?.home?.team, ':', e);
      // Render a minimal fallback card so the game isn't invisible
      return `<div class="game-card" style="padding:16px;opacity:0.6;">
        <div style="font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--text-dim);">
          ${game?.away?.team||'?'} @ ${game?.home?.team||'?'} · ${game?.time||''}
        </div>
        <div style="font-family:'IBM Plex Mono',monospace;font-size:10px;color:#e63946;margin-top:6px;">
          ⚠ Card render error — check console
        </div>
      </div>`;
    }
  }).join('');
}

// ── MAIN ─────────────────────────────────────────────────────────────
async function initDashboard() {
  document.getElementById('refreshBtn').disabled = true;
  setStatus('loading','LOADING');
  const now = new Date();
  try {
    document.getElementById('todayDate').textContent = now.toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric'});
  } catch(e) {}

  try {

  const noDataMsg = (label) => `<tr><td colspan="5" style="padding:16px 10px;font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--text-dim)">⏳ ${label} — data will appear once the season begins.</td></tr>`;

  setProgress(8,'FETCHING HITTER STATS...');
  try { hitters = await fetchHitters(); } catch(e) { hitters=[]; }

  setProgress(20,'FETCHING HR-ALLOWED PITCHERS...');
  try { hrPitchers = await fetchHRPitchers(); } catch(e) { hrPitchers=[]; }

  setProgress(32,'FETCHING STRIKEOUT LEADERS...');
  try { koPitchers = await fetchKOPitchers(); } catch(e) { koPitchers=[]; }

  setProgress(44,'CALCULATING VENUE TOTALS...');
  try { venues = await fetchVenues(); } catch(e) { venues=[]; }

  setProgress(52,'FETCHING TEAM HR TOTALS...');
  try { teamHRLeaderboard = await fetchTeamHRLeaderboard(); } catch(e) { teamHRLeaderboard=[]; }

  setProgress(54,'FETCHING TEAM STRIKEOUT TOTALS...');
  try { teamKLeaderboard = await fetchTeamKLeaderboard(); } catch(e) { teamKLeaderboard=[]; }

  setProgress(56,'LOADING TODAY\'S SCHEDULE...');
  try { todayGames = await fetchTodayGames(); } catch(e) { todayGames=[]; }

  setProgress(66,'FETCHING NO HR PITCHER DATA...');
  try {
    const noHRResult = await fetchNoHRPitchers();
    noHRPitchersAL = noHRResult.AL;
    noHRPitchersNL = noHRResult.NL;
  } catch(e) { noHRPitchersAL=[]; noHRPitchersNL=[]; }

  setProgress(74,'FETCHING LOW HR TEAM DATA...');
  try { noHRTeams = await fetchNoHRTeams(); } catch(e) { noHRTeams=[]; }

  setProgress(82,'ANALYZING MATCHUPS & RECENT HR TRENDS...');
  if (hitters.length && !_hotColdData) buildHotColdData().catch(()=>{});
  const alerts = analyzeMatchups();
  const noHRAlerts = analyzeNoHRMatchups();
  const alertHitterIds  = new Set(alerts.map(a=>a.hitter?.id).filter(Boolean));
  const alertPitcherIds = new Set(alerts.map(a=>a.pitcher?.id).filter(Boolean));
  const alertVenueIds   = new Set(alerts.filter(a=>a.type==='triple').map(a=>a.game.venueId));

  setProgress(88,'RENDERING LEADERBOARDS...');

  if (hitters.length) {
    renderHitters(alertHitterIds);
  }
  else document.getElementById('hitters-body').innerHTML = noDataMsg('Season stats loading');

  // Check challenge results on every data refresh (picks up Final games automatically)
  const _challengeData = challengeLoad();
  const _todayKey2 = challengeDateKey(new Date());
  const _hasPending = Object.keys(_challengeData).some(k => {
    const _day = _challengeData[k];
    return [...(_day.claudePicks||[]), ...(_day.userPicks||[])].some(p => p.result === 'pending' && p.gamePk);
  });
  if (_hasPending) {
    // Run in background — don't await so it doesn't block render
    (async () => {
      for (const dateKey of Object.keys(_challengeData).sort().reverse()) {
        const _day = _challengeData[dateKey];
        const _pending = [...(_day.claudePicks||[]), ...(_day.userPicks||[])].filter(p => p.result === 'pending' && p.gamePk);
        if (_pending.length > 0) await challengeCheckResults(dateKey);
      }
    })();
  }

  if (hrPitchers.length) renderPitcherTable('pitchers-body', hrPitchers, 'red', 'hr', alertPitcherIds);
  else document.getElementById('pitchers-body').innerHTML = noDataMsg('Season stats loading');

  if (koPitchers.length) renderKOPitchers();
  else document.getElementById('ko-body').innerHTML = noDataMsg('Season stats loading');

  if (venues.length) { renderAllVenues(alertVenueIds); }
  else {
    document.getElementById('all-venues-body').innerHTML = noDataMsg('Venue data loading');
  }

  if (teamHRLeaderboard.length) renderTeamHRLeaderboard();
  else document.getElementById('team-hr-body').innerHTML = noDataMsg('Team stats loading');

  if (teamKLeaderboard.length) renderTeamKLeaderboard();
  else document.getElementById('team-k-body').innerHTML = noDataMsg('Team strikeout stats loading');

  renderAlerts(alerts);
  renderNoHRAlerts(noHRAlerts);

  setProgress(94,'LOADING GAME CARDS...');

  // Pre-fetch weather for all games so HR score can use it
  await Promise.all(todayGames.filter(g=>!g.isLive&&!g.isFinal).map(async g=>{
    try { g._weather = await fetchWeather(g.venue); } catch(e) { g._weather = null; }
  }));

  await renderGames(alerts, noHRAlerts);
  // Load HR events for live and final games in background
  (async () => {
    const gamesToCheck = todayGames.filter(g => g.isLive || g.isFinal);
    for (const game of gamesToCheck) {
      try {
        const events = await fetchGameHREvents(game.gamePk);
        const el = document.getElementById(`hr-ticker-${game.gamePk}`);
        if (!el) continue;
        if (!events.length) { el.style.display = 'none'; continue; }
        const gameObj = todayGames.find(g => g.gamePk === game.gamePk);
        const awayTeam = gameObj?.away?.team || '';
        const homeTeam = gameObj?.home?.team || '';
        const items = events.map((e, i) => {
          const teamAbbr = e.team === 'away' ? awayTeam : homeTeam;
          const sep = i < events.length - 1 ? '<span class="game-hr-event-sep">·</span>' : '';
          return `<div class="game-hr-event">
            <span class="game-hr-event-name" onclick="event.stopPropagation();openPlayerModal(${e.playerId||0},'${(e.name||'').replace(/'/g,"\'")}','${teamAbbr}')">${e.name}</span>
            <span class="game-hr-event-detail">${teamAbbr} · ${e.type} · ${e.inning}</span>
            ${sep}
          </div>`;
        }).join('');
        // Duplicate items for seamless infinite scroll
        const needsScroll = events.length > 2;
        const innerItems  = needsScroll ? items + items : items;
        el.innerHTML = `<div class="game-hr-ticker-label">HRs This Game</div>
          <div class="game-hr-ticker-scroll">
            <div class="game-hr-ticker-inner" style="${!needsScroll ? 'animation:none;' : ''}">${innerItems}</div>
          </div>`;
        el.style.display = 'block';
      } catch(e) {}
    }
  })();

  setProgress(100,'DONE');

  const month = now.getMonth()+1;
  const note = document.getElementById('seasonNote');
  if (note && month<=4) {
    note.textContent = `ℹ️ Early season (${now.toLocaleString('default',{month:'long'})}): Leaderboards and stadium totals accumulate as games are played — check back daily!`;
    note.classList.add('visible');
  }

  document.getElementById('lastUpdated').textContent = `Updated ${now.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'})}`;
  document.getElementById('footerNote').textContent = `MLB STATS API (statsapi.mlb.com) · ${SEASON} Season · Refreshed ${now.toLocaleDateString()} ${now.toLocaleTimeString()}`;
  setStatus('','LIVE');
  hideLoading();
  document.getElementById('refreshBtn').disabled = false;

  // ── Sidebar + ticker — non-blocking, nothing here can crash the dashboard ──
  try { updateSidebarThreats(alerts, noHRAlerts); } catch(e) { console.warn('sidebar threats failed',e); }
  try { buildPlayerIndex(); } catch(e) { console.warn('player index failed',e); }
  try { buildRosterList(); } catch(e) { console.warn('roster list failed',e); }
  try {
    const hitterIds2  = new Set(hitters.map(h=>h.id));
    const hitterMap2  = Object.fromEntries(hitters.map((h,i)=>[h.id,{...h,rank:i+1}]));
    const pitcherIds2 = new Set(hrPitchers.map(p=>p.id));
    const gameScores2 = todayGames
      .filter(g=>!g.isLive&&!g.isFinal)
      .map(g=>{
        const hrps = calcHRProbScore(g, hitterIds2, hitterMap2, pitcherIds2, [], []);
        return { away:g.away.team, home:g.home.team, score:hrps?.score||null };
      });
    updateSidebarScoreRankings(gameScores2);
  } catch(e) { console.warn('score rankings failed',e); }

  // Ticker — non-blocking
  renderHRTicker();
  fetchTickerHRData().then(()=>{ renderHRTicker(); updateSidebarHRFeed(); }).catch(()=>{});

  // Pre-load ALL 30 team rosters in background so search works for every player
  prefetchAllRosters();

  } catch(e) {
    // Safety net — if anything crashes, still hide the loading screen
    console.error('initDashboard error:', e);
    setStatus('error','ERROR');
    hideLoading();
    document.getElementById('refreshBtn').disabled = false;
  }
}

// ── HR PROBABILITY SCORE ──────────────────────────────────────────────
function calcHRProbScore(game, hitterIds, hitterMap, pitcherIds, awayLeaders, homeLeaders) {
  if (game.isLive || game.isFinal) return null;

  let score = 0;
  const breakdown = [];

  // ── Factor 1: Power hitters (max 4pts) ──
  // Use team leaders data — lineup may not be posted yet
  const allLeaders = [...(awayLeaders||[]), ...(homeLeaders||[])];
  const top25InGame = allLeaders.filter(p => hitterIds.has(p.id));
  const rankedInGame = top25InGame.map(p => hitterMap[p.id]).filter(Boolean).sort((a,b)=>a.rank-b.rank);

  if (rankedInGame.length) {
    const bestRank = rankedInGame[0].rank;
    if (bestRank <= 5)       { score += 3; breakdown.push('⚾ Top 5 HR hitter (+3)'); }
    else if (bestRank <= 10) { score += 2; breakdown.push('⚾ Top 10 HR hitter (+2)'); }
    else                     { score += 1; breakdown.push('⚾ Top 25 HR hitter (+1)'); }
    if (rankedInGame.length >= 3)      { score += 1; breakdown.push('⚾ 3+ power hitters (+1)'); }
    else if (rankedInGame.length === 2) { score += 0.5; breakdown.push('⚾ 2 power hitters (+0.5)'); }
  }

  // ── Factor 2: HR-prone pitcher (max 2pts) ──
  const awayPitcherId = game.away.pitcherId;
  const homePitcherId = game.home.pitcherId;
  const pitcherRanks = [awayPitcherId, homePitcherId]
    .filter(id => id && pitcherIds.has(id))
    .map(id => hrPitchers.findIndex(p=>p.id===id)+1)
    .filter(r => r > 0);

  if (pitcherRanks.length) {
    const best = Math.min(...pitcherRanks);
    if (best <= 5)       { score += 2; breakdown.push('🥎 Top 5 HR pitcher (+2)'); }
    else if (best <= 10) { score += 1.5; breakdown.push('🥎 Top 10 HR pitcher (+1.5)'); }
    else                 { score += 1; breakdown.push('🥎 Top 25 HR pitcher (+1)'); }
  }

  // ── Factor 3: Venue HR rating (max 2pts) ──
  const venueIdx = venues.findIndex(v=>v.venueId===game.venueId);
  if (venueIdx !== -1) {
    if (venueIdx < 5)       { score += 2; breakdown.push('🏟️ Top 5 HR venue (+2)'); }
    else if (venueIdx < 10) { score += 1; breakdown.push('🏟️ Top 10 HR venue (+1)'); }
  }

  // ── Factor 4: Weather (max 2pts) ──
  const weather = game._weather;
  if (weather) {
    let wScore = 0;
    const tempNum = parseInt(weather.temp)||0;
    const windSpeedNum = parseInt(weather.wind)||0;
    const outDirs = ['N','NNE','NE','NNW','NW'];
    const isOut = outDirs.includes(weather.windDir||'');
    if (isOut) { wScore += 1; breakdown.push('🌬️ Wind blowing out (+1)'); }
    if (tempNum >= 75) { wScore += 0.5; breakdown.push('☀️ Warm temps (+0.5)'); }
    else if (tempNum >= 65) { wScore += 0.25; }
    if (isOut && windSpeedNum >= 12) { wScore += 0.5; breakdown.push('💨 Strong wind out (+0.5)'); }
    score += Math.min(wScore, 2);
  }

  // ── Factor 5: Handedness mismatch (max 1pt) ──
  let handBonus = 0;
  for (const [pitcherId, opposingLeaders] of [
    [awayPitcherId, homeLeaders||[]],
    [homePitcherId, awayLeaders||[]]
  ]) {
    if (!pitcherId) continue;
    const ph = handednessCache[pitcherId];
    if (!ph) continue;
    const count = opposingLeaders.filter(p=>{
      const bh = batHandCache[p.id];
      return bh && bh !== ph && bh !== 'S';
    }).length;
    if (count >= 2) { handBonus = 1; breakdown.push('🤚 Handedness advantage (+1)'); break; }
    else if (count === 1) handBonus = Math.max(handBonus, 0.5);
  }
  score += handBonus;

  return { score: Math.min(10, Math.max(1, Math.round(score))), breakdown };
}

function hrpsColor(score) {
  if (score <= 3) return '#6b7280';
  if (score <= 5) return 'var(--accent-blue)';
  if (score <= 7) return 'var(--accent-gold)';
  if (score <= 9) return 'var(--accent-orange)';
  return 'var(--accent-red)';
}

function hrpsTier(score) {
  if (score <= 3) return 'LOW';
  if (score <= 5) return 'BELOW AVG';
  if (score <= 7) return 'MODERATE';
  if (score <= 9) return 'HIGH';
  return 'MAX ⚡';
}

function showLegend(btn) {
  const legend = document.getElementById('hrpsLegend');
  const rect = btn.getBoundingClientRect();
  legend.style.top = (rect.bottom + window.scrollY + 8) + 'px';
  legend.style.left = Math.min(rect.left, window.innerWidth - 300) + 'px';
  legend.classList.add('open');
  setTimeout(()=>document.addEventListener('click', closeLegendOutside), 10);
}
function closeLegend() {
  document.getElementById('hrpsLegend').classList.remove('open');
  document.removeEventListener('click', closeLegendOutside);
}
function closeLegendOutside(e) {
  if (!document.getElementById('hrpsLegend').contains(e.target)) closeLegend();
}

// ── SIDEBAR ───────────────────────────────────────────────────────────
// ── TOP NAV ───────────────────────────────────────────────────────────
function switchTopNav(tab, btn) {
  // Hide all sections
  document.querySelectorAll('.top-nav-section').forEach(s => s.style.display = 'none');
  // Deactivate all nav buttons (top + mobile bottom)
  document.querySelectorAll('.top-nav-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.mobile-nav-btn').forEach(b => b.classList.remove('active'));
  // Show selected section
  const section = document.getElementById('section-' + tab);
  if (section) section.style.display = 'block';
  // Activate clicked button (top nav)
  if (btn) btn.classList.add('active');
  // Also activate matching top nav btn if called from mobile
  if (!btn) {
    document.querySelectorAll(`.top-nav-btn`).forEach(b => {
      if (b.getAttribute('onclick')?.includes(`'${tab}'`)) b.classList.add('active');
    });
  }
  // Always sync mobile bottom nav
  const mobileBtn = document.getElementById('mnav-' + tab);
  if (mobileBtn) mobileBtn.classList.add('active');

  // Mirror venue/pitching tables from existing rendered data if needed
  if (tab === 'venues') {
    const srcV = document.getElementById('all-venues-body');
    const dstV = document.getElementById('all-venues-body-v2');
    if (srcV && dstV && !dstV.children.length) dstV.innerHTML = srcV.innerHTML;
    const srcT = document.getElementById('team-hr-body');
    const dstT = document.getElementById('team-hr-body-v2');
    if (srcT && dstT && !dstT.children.length) dstT.innerHTML = srcT.innerHTML;
  }
  if (tab === 'pitching') {
    const srcP = document.getElementById('pitchers-body');
    const dstP = document.getElementById('pitchers-body-v2');
    if (srcP && dstP && !dstP.children.length) dstP.innerHTML = srcP.innerHTML;
    const srcK = document.getElementById('ko-body');
    const dstK = document.getElementById('ko-body-v2');
    if (srcK && dstK && !dstK.children.length) dstK.innerHTML = srcK.innerHTML;
    const srcTK = document.getElementById('team-k-body');
    const dstTK = document.getElementById('team-k-body-v2');
    if (srcTK && dstTK && !dstTK.children.length) dstTK.innerHTML = srcTK.innerHTML;
  }
}

// ── ROSTER ACCORDION ──────────────────────────────────────────────────
function toggleAccordion(id) {
  const body  = document.getElementById(id);
  const arrow = document.getElementById('arrow-' + id);
  const isOpen = body.classList.contains('open');
  body.classList.toggle('open', !isOpen);
  arrow.classList.toggle('open', !isOpen);
}

// ── ROSTER SEARCH ─────────────────────────────────────────────────────
function filterRoster(val) {
  const q = val.toLowerCase().trim();
  // Filter player rows in all accordion sections
  document.querySelectorAll('#teamModalRoster .roster-table tbody tr').forEach(row => {
    const name = row.querySelector('.roster-name')?.textContent?.toLowerCase() || '';
    const pos  = row.querySelector('.roster-pos')?.textContent?.toLowerCase() || '';
    row.style.display = (!q || name.includes(q) || pos.includes(q)) ? '' : 'none';
  });
  // Auto-expand sections that have matching players, collapse empty ones
  document.querySelectorAll('#teamModalRoster .accordion-section').forEach(section => {
    const body  = section.querySelector('.accordion-body');
    const arrow = section.querySelector('.accordion-arrow');
    const visibleRows = [...section.querySelectorAll('tbody tr')].filter(r => r.style.display !== 'none');
    if (q) {
      const hasMatches = visibleRows.length > 0;
      body.classList.toggle('open', hasMatches);
      arrow.classList.toggle('open', hasMatches);
    }
  });
}

// ── PLAYER MODAL ──────────────────────────────────────────────────────
const playerModalCache = {};

function closePlayerModal(e) {
  if (e && e.target !== document.getElementById('playerModalOverlay')) return;
  document.getElementById('playerModalOverlay').classList.remove('open');
}

async function openPlayerModal(playerId, name, teamAbbr, vsL, vsR) {
  if (!playerId) return;
  const tc = tickerTeamColor(teamAbbr||'');

  // Show modal immediately
  document.getElementById('playerModalName').textContent = name;
  document.getElementById('playerModalMeta').textContent = '—';
  document.getElementById('playerModalHeader').style.borderBottom = `2px solid ${tc}`;
  ['plAge','plHeight','plWeight','plBorn'].forEach(id => {
    document.getElementById(id).textContent = id === 'plAge' ? '🎂 —' : id === 'plHeight' ? '📏 —' : id === 'plWeight' ? '⚖️ —' : '📍 —';
  });
  document.getElementById('playerSeasonStats').innerHTML = `<div style="font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--text-dim);text-align:center;padding:16px 0;">Loading stats...</div>`;
  document.getElementById('playerCareerStats').innerHTML = `<div style="font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--text-dim);text-align:center;padding:16px 0;">Loading...</div>`;
  document.getElementById('playerModalOverlay').classList.add('open');

  if (playerModalCache[playerId]) {
    let curVsL = vsL, curVsR = vsR, curHomeAway = undefined;
    renderPlayerModal(playerModalCache[playerId], tc, curVsL, curVsR, curHomeAway);
    const pos = playerModalCache[playerId].bioData?.people?.[0]?.primaryPosition?.abbreviation;
    const isPit = pos === 'P' || pos === 'SP' || pos === 'RP' || pos === 'CP';
    if (isPit && vsL === undefined && vsR === undefined) {
      fetchPlatoonSplits(playerId).then(({ vsL: fetchedL, vsR: fetchedR }) => {
        curVsL = fetchedL; curVsR = fetchedR;
        renderPlayerModal(playerModalCache[playerId], tc, curVsL, curVsR, curHomeAway);
      });
    }
    if (isPit) {
      fetchPitcherHomeAwayK(playerId).then(homeAway => {
        curHomeAway = homeAway;
        renderPlayerModal(playerModalCache[playerId], tc, curVsL, curVsR, curHomeAway);
      });
    }
    return;
  }

  try {
    const [bioData, seasonHit, seasonPit, careerHit, careerPit, gameLogHit, gameLogPit] = await Promise.all([
      fetchJSON(`${BASE}/people/${playerId}`).catch(()=>null),
      fetchJSON(`${BASE}/people/${playerId}/stats?stats=season&season=${SEASON}&group=hitting`).catch(()=>null),
      fetchJSON(`${BASE}/people/${playerId}/stats?stats=season&season=${SEASON}&group=pitching`).catch(()=>null),
      fetchJSON(`${BASE}/people/${playerId}/stats?stats=career&group=hitting`).catch(()=>null),
      fetchJSON(`${BASE}/people/${playerId}/stats?stats=career&group=pitching`).catch(()=>null),
      fetchJSON(`${BASE}/people/${playerId}/stats?stats=gameLog&season=${SEASON}&group=hitting&gameType=R`).catch(()=>null),
      fetchJSON(`${BASE}/people/${playerId}/stats?stats=gameLog&season=${SEASON}&group=pitching&gameType=R`).catch(()=>null),
    ]);
    const data = { bioData, seasonHit, seasonPit, careerHit, careerPit, gameLogHit, gameLogPit };
    playerModalCache[playerId] = data;
    let curVsL = vsL, curVsR = vsR, curHomeAway = undefined;
    renderPlayerModal(data, tc, curVsL, curVsR, curHomeAway);
    // If vsL/vsR weren't pre-loaded (pitcher clicked from outside Top 25 table),
    // fetch splits now and re-render the season stats block if it's a pitcher.
    const pos = data.bioData?.people?.[0]?.primaryPosition?.abbreviation;
    const isPit = pos === 'P' || pos === 'SP' || pos === 'RP' || pos === 'CP';
    if (isPit && vsL === undefined && vsR === undefined) {
      fetchPlatoonSplits(playerId).then(({ vsL: fetchedL, vsR: fetchedR }) => {
        curVsL = fetchedL; curVsR = fetchedR;
        renderPlayerModal(data, tc, curVsL, curVsR, curHomeAway);
      });
    }
    if (isPit) {
      fetchPitcherHomeAwayK(playerId).then(homeAway => {
        curHomeAway = homeAway;
        renderPlayerModal(data, tc, curVsL, curVsR, curHomeAway);
      });
    }
  } catch(e) {
    console.warn('Player modal fetch failed:', e);
    document.getElementById('playerModalMeta').textContent = 'Failed to load player data';
  }
}

function renderPlayerModal({ bioData, seasonHit, seasonPit, careerHit, careerPit, gameLogHit, gameLogPit }, tc, vsL, vsR, homeAway) {
  const person = bioData?.people?.[0];
  if (!person) return;

  // Headshot
  const headshotUrl = `https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:67:current.png/w_213,q_auto:best/v1/people/${person.id}/headshot/67/current`;
  const img = document.getElementById('playerHeadshot');
  const fallback = document.getElementById('playerHeadshotFallback');
  img.style.display = 'block';
  fallback.style.display = 'none';
  img.src = headshotUrl;
  // Apply team color border to headshot
  document.querySelector('.player-headshot-wrap').style.borderColor = tc;

  // Bio
  document.getElementById('playerModalName').textContent = person.fullName || '—';
  const pos  = person.primaryPosition?.abbreviation || '—';
  const team = person.currentTeam?.name || '—';
  const hand = `Bats: ${person.batSide?.code||'—'} · Throws: ${person.pitchHand?.code||'—'}`;
  document.getElementById('playerModalMeta').textContent = `${pos} · ${team} · ${hand}`;

  // Quick stats
  document.getElementById('plAge').textContent    = `🎂 Age ${person.currentAge||'—'}`;
  document.getElementById('plHeight').textContent = `📏 ${person.height||'—'}`;
  document.getElementById('plWeight').textContent = `⚖️ ${person.weight ? person.weight+'lbs' : '—'}`;
  document.getElementById('plBorn').textContent   = `📍 ${person.birthCity||'—'}`;

  // Helper to build stat grid
  function statGrid(stats, isHitter) {
    if (!stats?.length) return `<div style="font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--text-dim);text-align:center;padding:8px 0;">No data available</div>`;
    const s = stats[0].stat;
    const cards = isHitter ? [
      {label:'AVG', val: s.avg||'.000'},
      {label:'HR',  val: s.homeRuns??'0', color: tc},
      {label:'RBI', val: s.rbi??'0'},
      {label:'OBP', val: s.obp||'.000'},
      {label:'SLG', val: s.slg||'.000'},
      {label:'OPS', val: s.ops||'.000'},
      {label:'H',   val: s.hits??'0'},
      {label:'AB',  val: s.atBats??'0'},
    ] : [
      {label:'ERA',  val: s.era||'0.00'},
      {label:'W',    val: s.wins??'0', color:'var(--accent-green)'},
      {label:'L',    val: s.losses??'0', color:'var(--accent-red)'},
      {label:'K',    val: s.strikeOuts??'0', color:'var(--accent-purple)'},
      {label:'IP',   val: s.inningsPitched||'0'},
      {label:'WHIP', val: s.whip||'0.00'},
      {label:'HR',   val: s.homeRuns??'0', color:tc},
      {label:'BB',   val: s.baseOnBalls??'0'},
    ];
    return `<div class="player-stats-grid">${cards.map(c=>`
      <div class="player-stat-card">
        <div class="ps-label">${c.label}</div>
        <div class="ps-val" style="${c.color?'color:'+c.color:''}">${c.val}</div>
      </div>`).join('')}</div>`;
  }

  const isPitcher = pos === 'P' || pos === 'SP' || pos === 'RP' || pos === 'CP';
  const seasonStats  = isPitcher ? seasonPit?.stats?.[0]?.splits  : seasonHit?.stats?.[0]?.splits;
  const careerStats  = isPitcher ? careerPit?.stats?.[0]?.splits  : careerHit?.stats?.[0]?.splits;

  let seasonHTML = statGrid(seasonStats, !isPitcher);
  if (isPitcher && (vsL !== null && vsL !== undefined || vsR !== null && vsR !== undefined)) {
    seasonHTML += `<div style="display:flex;gap:8px;margin-top:10px;">
      <div style="flex:1;background:rgba(56,189,248,0.08);border:1px solid rgba(56,189,248,0.25);border-radius:6px;padding:8px 0;text-align:center;">
        <div style="font-family:'IBM Plex Mono',monospace;font-size:9px;color:var(--text-dim);letter-spacing:0.08em;margin-bottom:4px;">HR VS L</div>
        <div style="font-family:'IBM Plex Mono',monospace;font-size:20px;font-weight:700;color:var(--accent-blue);">${vsL !== null && vsL !== undefined ? vsL : '—'}</div>
      </div>
      <div style="flex:1;background:rgba(230,57,70,0.08);border:1px solid rgba(230,57,70,0.25);border-radius:6px;padding:8px 0;text-align:center;">
        <div style="font-family:'IBM Plex Mono',monospace;font-size:9px;color:var(--text-dim);letter-spacing:0.08em;margin-bottom:4px;">HR VS R</div>
        <div style="font-family:'IBM Plex Mono',monospace;font-size:20px;font-weight:700;color:var(--accent-red);">${vsR !== null && vsR !== undefined ? vsR : '—'}</div>
      </div>
    </div>`;
  }
  if (isPitcher && homeAway && (homeAway.homeK !== null && homeAway.homeK !== undefined || homeAway.awayK !== null && homeAway.awayK !== undefined)) {
    const homeKpg = (homeAway.homeK !== null && homeAway.homeGP) ? (homeAway.homeK / homeAway.homeGP).toFixed(1) : null;
    const awayKpg = (homeAway.awayK !== null && homeAway.awayGP) ? (homeAway.awayK / homeAway.awayGP).toFixed(1) : null;
    seasonHTML += `<div style="display:flex;gap:8px;margin-top:8px;">
      <div style="flex:1;background:rgba(96,165,250,0.08);border:1px solid rgba(96,165,250,0.25);border-radius:6px;padding:8px 0;text-align:center;">
        <div style="font-family:'IBM Plex Mono',monospace;font-size:9px;color:var(--text-dim);letter-spacing:0.08em;margin-bottom:4px;">K HOME</div>
        <div style="font-family:'IBM Plex Mono',monospace;font-size:20px;font-weight:700;color:#60a5fa;">${homeAway.homeK !== null && homeAway.homeK !== undefined ? homeAway.homeK : '—'}</div>
        <div style="font-family:'IBM Plex Mono',monospace;font-size:9px;color:var(--text-dim);margin-top:2px;">${homeKpg ? homeKpg+'/G' : '—'}</div>
      </div>
      <div style="flex:1;background:rgba(230,57,70,0.08);border:1px solid rgba(230,57,70,0.25);border-radius:6px;padding:8px 0;text-align:center;">
        <div style="font-family:'IBM Plex Mono',monospace;font-size:9px;color:var(--text-dim);letter-spacing:0.08em;margin-bottom:4px;">K ROAD</div>
        <div style="font-family:'IBM Plex Mono',monospace;font-size:20px;font-weight:700;color:var(--accent-red);">${homeAway.awayK !== null && homeAway.awayK !== undefined ? homeAway.awayK : '—'}</div>
        <div style="font-family:'IBM Plex Mono',monospace;font-size:9px;color:var(--text-dim);margin-top:2px;">${awayKpg ? awayKpg+'/G' : '—'}</div>
      </div>
    </div>`;
  }
  document.getElementById('playerSeasonStats').innerHTML = seasonHTML;
  document.getElementById('playerCareerStats').innerHTML = statGrid(careerStats, !isPitcher);

  // Init game log
  const rawLog = isPitcher
    ? (gameLogPit?.stats?.[0]?.splits || gameLogPit?.stats?.find(s=>s.type?.displayName==='gameLog')?.splits || [])
    : (gameLogHit?.stats?.[0]?.splits || gameLogHit?.stats?.find(s=>s.type?.displayName==='gameLog')?.splits || []);
  window._gamelogData = rawLog || [];
  window._gamelogTc   = tc;
  window._gamelogView = 'last10';
  window._gamelogStat = 'avg';
  window._gamelogIsPitcher = isPitcher;

  // Update active toggle button styling with tc color
  document.querySelectorAll('.gamelog-view-btn').forEach(b => {
    b.style.setProperty('--gamelog-tc', tc);
  });
  document.querySelectorAll('.gamelog-stat-btn').forEach(b => {
    b.style.setProperty('--gamelog-tc', tc);
  });
  // Reset split mode to Season view on every open
  document.getElementById('playerModal').classList.remove('split-mode');
  document.getElementById('playerModalRight').style.display = 'none';
  window._gamelogView = 'season';

  // Reset toggle buttons — Season active by default
  document.querySelectorAll('.gamelog-view-btn').forEach(b => b.classList.remove('active'));
  document.querySelector('.gamelog-view-btn[onclick*="season"]').classList.add('active');

  // Reset stat selector — AVG active by default
  document.querySelectorAll('.gamelog-stat-btn').forEach(b => b.classList.remove('active'));
  document.querySelector('.gamelog-stat-btn:first-child').classList.add('active');
  window._gamelogStat = 'avg';

  if (isPitcher) {
    document.getElementById('playerRecentSection').style.display = 'none';
  } else {
    document.getElementById('playerRecentSection').style.display = '';
    // Don't auto-render — user clicks Last 5/10 to open the panel
  }
}

// ── SCHEDULE MODAL ────────────────────────────────────────────────────
let scheduleCurrentDate = new Date();
const scheduleCache = {};

function openScheduleModal() {
  scheduleCurrentDate = new Date(); // start on today
  document.getElementById('scheduleModalOverlay').classList.add('open');
  loadScheduleForDate(scheduleCurrentDate);
}

function closeScheduleModal(e) {
  if (e && e.target !== document.getElementById('scheduleModalOverlay')) return;
  document.getElementById('scheduleModalOverlay').classList.remove('open');
}

function navigateSchedule(dir) {
  const d = new Date(scheduleCurrentDate);
  d.setDate(d.getDate() + dir);
  // Don't allow going past today
  const today = new Date(); today.setHours(23,59,59,999);
  if (d > today) return;
  scheduleCurrentDate = d;
  loadScheduleForDate(d);
}

function navigateScheduleToToday() {
  scheduleCurrentDate = new Date();
  loadScheduleForDate(scheduleCurrentDate);
}

function formatScheduleDate(d) {
  return d.toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric', year:'numeric' });
}

function dateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,'0');
  const day = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}

async function loadScheduleForDate(d) {
  const key = dateKey(d);
  const el = document.getElementById('scheduleGamesBody');
  const today = new Date(); today.setHours(23,59,59,999);
  const isToday = dateKey(d) === dateKey(new Date());
  const isFuture = d > today;

  // Update header
  document.getElementById('scheduleModalDate').textContent = formatScheduleDate(d);

  // Disable next arrow if today
  const nextBtn = document.getElementById('schedNavNext');
  if (nextBtn) nextBtn.disabled = isToday;

  if (scheduleCache[key]) { renderScheduleGames(scheduleCache[key], isToday); return; }

  el.innerHTML = `<div style="font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--text-dim);text-align:center;padding:40px 0;">Loading games...</div>`;

  try {
    const dateStr = key;
    const data = await fetchJSON(`${BASE}/schedule?sportId=1&date=${dateStr}&hydrate=linescore,boxscore,probablePitcher,decisions,team`);
    scheduleCache[key] = data;
    renderScheduleGames(data, isToday);
  } catch(e) {
    el.innerHTML = `<div style="font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--text-dim);text-align:center;padding:40px 0;">Could not load games for this date.</div>`;
  }
}

function renderScheduleGames(data, isToday) {
  const el = document.getElementById('scheduleGamesBody');
  const games = data?.dates?.[0]?.games || [];

  if (!games.length) {
    el.innerHTML = `<div style="font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--text-dim);text-align:center;padding:40px 0;">No games scheduled for this date.</div>`;
    return;
  }

  const cards = games.map(g => {
    const status    = g.status?.detailedState || '';
    const isFinal   = status.includes('Final') || status.includes('Completed');
    const isLive    = g.status?.abstractGameState === 'Live';
    const isScheduled = !isFinal && !isLive;

    const away = g.teams?.away;
    const home = g.teams?.home;
    const awayName  = away?.team?.teamName || away?.team?.name || '—';
    const homeName  = home?.team?.teamName || home?.team?.name || '—';
    // abbreviation may not be in schedule hydration — derive from TEAM_COLORS keys by matching name
    const awayAbbr  = away?.team?.abbreviation || Object.keys(TEAM_COLORS).find(k => awayName.includes(k)) || away?.team?.id?.toString()?.slice(-3) || '—';
    const homeAbbr  = home?.team?.abbreviation || Object.keys(TEAM_COLORS).find(k => homeName.includes(k)) || home?.team?.id?.toString()?.slice(-3) || '—';
    const awayScore = away?.score ?? (isScheduled ? '' : '0');
    const homeScore = home?.score ?? (isScheduled ? '' : '0');
    const awayWon   = isFinal && Number(awayScore) > Number(homeScore);
    const homeWon   = isFinal && Number(homeScore) > Number(awayScore);

    // R H E
    const awayLine  = g.linescore?.teams?.away;
    const homeLine  = g.linescore?.teams?.home;
    const awayRHE   = isFinal ? `${awayLine?.runs??''}  ${awayLine?.hits??''}  ${awayLine?.errors??''}` : '';
    const homeRHE   = isFinal ? `${homeLine?.runs??''}  ${homeLine?.hits??''}  ${homeLine?.errors??''}` : '';

    // Pitchers
    const wp = g.decisions?.winner;
    const lp = g.decisions?.loser;
    const sv = g.decisions?.save;
    const wpLine = wp ? `W: ${wp.fullName}` : '';
    const lpLine = lp ? `L: ${lp.fullName}` : '';
    const svLine = sv ? `S: ${sv.fullName}` : '';

    // Time for scheduled games
    const gameTime = isScheduled ? (g.gameDate ? new Date(g.gameDate).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit',timeZoneName:'short'}) : '—') : '';

    const tc_away = tickerTeamColor(awayAbbr);
    const tc_home = tickerTeamColor(homeAbbr);

    const statusClass = isFinal ? 'final' : isLive ? 'live' : 'sched';
    const statusText  = isFinal ? 'FINAL' : isLive ? `● LIVE · ${g.linescore?.currentInningOrdinal||''}` : gameTime;

    const cardClass = isFinal ? 'sched-final' : isLive ? 'sched-live' : 'sched-sched';

    return `<div class="sched-card ${cardClass}" onclick="openScheduleGame(${g.gamePk})">
      <div class="sched-card-header">
        ${isScheduled
          ? `<span class="sched-time-chip">🕐 ${gameTime}</span>`
          : `<span class="sched-status ${statusClass}">${statusText}</span>`
        }
        <span class="sched-venue">📍 ${g.venue?.name||''}</span>
      </div>
      <div class="sched-card-body">
        <div class="sched-team-row">
          <div class="sched-team-bar" style="background:${tc_away};"></div>
          <span class="sched-team-abbr" style="color:${tc_away};">${awayAbbr}</span>
          <span class="sched-team-name" style="color:${tc_away};">${awayName}</span>
          ${isFinal ? `<span class="sched-rhe-header">R&nbsp;H&nbsp;E</span><span class="sched-rhe">${awayRHE}</span>` : ''}
          <span class="sched-score ${awayWon?'winner':'loser'}" style="color:${awayWon?tc_away:'var(--text-dim)'};">${awayScore}</span>
        </div>
        <div class="sched-team-row" style="margin-top:6px;">
          <div class="sched-team-bar" style="background:${tc_home};"></div>
          <span class="sched-team-abbr" style="color:${tc_home};">${homeAbbr}</span>
          <span class="sched-team-name" style="color:${tc_home};">${homeName}</span>
          ${isFinal ? `<span class="sched-rhe-header">R&nbsp;H&nbsp;E</span><span class="sched-rhe">${homeRHE}</span>` : ''}
          <span class="sched-score ${homeWon?'winner':'loser'}" style="color:${homeWon?tc_home:'var(--text-dim)'};">${homeScore}</span>
        </div>
      </div>
      ${(wpLine||lpLine) ? `<div class="sched-pitchers">
        ${wpLine ? `<span class="sched-pitcher">W <span>${wp.fullName}</span></span>` : ''}
        ${lpLine ? `<span class="sched-pitcher">L <span>${lp.fullName}</span></span>` : ''}
        ${svLine ? `<span class="sched-pitcher">S <span>${sv.fullName}</span></span>` : ''}
      </div>` : ''}
    </div>`;
  }).join('');

  el.innerHTML = `<div class="sched-grid">${cards}</div>`;
}
let standingsCache = null; // cleared on each session load

function switchMLBTab(tab) {
  document.querySelectorAll('.mlb-tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('mlbTabStandings').classList.toggle('active', tab === 'standings');
  document.getElementById('mlbTabTeams').classList.toggle('active', tab === 'teams');
  document.getElementById('mlbPanelStandings').style.display = tab === 'standings' ? 'block' : 'none';
  document.getElementById('mlbPanelTeams').style.display     = tab === 'teams'     ? 'block' : 'none';
  if (tab === 'standings') loadStandings();
}

async function loadStandings() {
  const el = document.getElementById('standingsBody');
  if (standingsCache) { renderStandings(standingsCache); return; }
  el.innerHTML = `<div style="padding:40px;text-align:center;font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--text-dim);">Loading standings...</div>`;
  try {
    const data = await fetchJSON(`${BASE}/standings?leagueId=103,104&season=${SEASON}&hydrate=team,division`);
    standingsCache = data;
    renderStandings(data);
  } catch(e) {
    el.innerHTML = `<div style="padding:40px;text-align:center;font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--text-dim);">Could not load standings</div>`;
  }
}

// Map team ID → abbr for standings
const STANDINGS_ABBR = {
  109:'ARI',144:'ATL',110:'BAL',111:'BOS',112:'CHC',145:'CWS',113:'CIN',114:'CLE',
  115:'COL',116:'DET',117:'HOU',118:'KC',108:'LAA',119:'LAD',146:'MIA',158:'MIL',
  142:'MIN',121:'NYM',147:'NYY',133:'ATH',143:'PHI',134:'PIT',135:'SD',137:'SF',
  136:'SEA',138:'STL',139:'TB',140:'TEX',141:'TOR',120:'WSH'
};

function renderStandings(data) {
  const el = document.getElementById('standingsBody');
  if (!data?.records?.length) {
    el.innerHTML = `<div style="padding:40px;text-align:center;font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--text-dim);">No standings data yet</div>`;
    return;
  }

  // AL division IDs: 200=West, 201=East, 202=Central
  // NL division IDs: 203=West, 204=East, 205=Central
  const al = data.records.filter(r => [200,201,202].includes(r.division?.id));
  const nl = data.records.filter(r => [203,204,205].includes(r.division?.id));

  // Division ID order map — East first, then Central, then West
  const DIV_ORDER = {
    201:0, 202:1, 200:2,  // AL East, AL Central, AL West
    204:3, 205:4, 203:5   // NL East, NL Central, NL West
  };

  function divisionRows(divRecord) {
    const divName = divRecord.division?.nameShort || divRecord.division?.name || '—';
    const rows = (divRecord.teamRecords || []).map((tr, i) => {
      const abbr = STANDINGS_ABBR[tr.team?.id] || '—';
      const tc   = tickerTeamColor(abbr);
      const gb   = tr.gamesBack === '-' ? '—' : (tr.gamesBack || '0');
      const homeRec = tr.records?.splitRecords?.find(s=>s.type==='home');
      const awayRec = tr.records?.splitRecords?.find(s=>s.type==='away');
      const homeStr = homeRec ? `${homeRec.wins}-${homeRec.losses}` : '—';
      const awayStr = awayRec ? `${awayRec.wins}-${awayRec.losses}` : '—';
      return `<tr onclick="openTeamModal('${abbr}','${(tr.team?.name||'').replace(/'/g,"\\'")}')">
        <td style="color:var(--text-dim);font-family:'IBM Plex Mono',monospace;font-size:11px;">${i+1}</td>
        <td>
          <span class="standings-abbr" style="color:${tc};border-color:${tc}44;">${abbr}</span>
        </td>
        <td class="standings-val bold" style="white-space:nowrap;">${tr.wins}-${tr.losses}</td>
        <td class="standings-val">${tr.winningPercentage||'—'}</td>
        <td class="standings-val">${gb}</td>
        <td class="standings-val">${homeStr}</td>
        <td class="standings-val">${awayStr}</td>
        <td class="standings-val">${tr.streak?.streakCode||'—'}</td>
      </tr>`;
    }).join('');
    return `<tr class="standings-div-header"><td colspan="8">${divName}</td></tr>${rows}`;
  }

  function leagueTable(records, leagueName, color) {
    const sorted = [...records].sort((a,b) => (DIV_ORDER[a.division?.id]??99) - (DIV_ORDER[b.division?.id]??99));
    return `
      <div style="padding:16px 20px;">
        <div style="font-family:'Bebas Neue',sans-serif;font-size:18px;letter-spacing:3px;color:${color};margin-bottom:12px;">${leagueName}</div>
        <table class="standings-table">
          <thead><tr>
            <th>#</th><th>Team</th>
            <th class="right">W-L</th><th class="right">PCT</th><th class="right">GB</th>
            <th class="right">Home</th><th class="right">Away</th><th class="right">Strk</th>
          </tr></thead>
          <tbody>${sorted.map(divisionRows).join('')}</tbody>
        </table>
      </div>`;
  }

  el.style.display = 'block';
  el.innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr;border-top:1px solid var(--border);">
      <div style="border-right:1px solid var(--border);">${leagueTable(al, 'American League', 'var(--accent-blue)')}</div>
      <div>${leagueTable(nl, 'National League', 'var(--accent-red)')}</div>
    </div>`;
}

async function openScheduleGame(gamePk) {
  // If today's game exists in our loaded data, use the full modal
  const todayGame = todayGames.find(g => g.gamePk === gamePk);
  if (todayGame) { openGameModal(gamePk); return; }

  // For past/other dates — find from schedule cache and inject temporarily
  let gameData = null;
  for (const cached of Object.values(scheduleCache)) {
    const found = cached?.dates?.[0]?.games?.find(g => g.gamePk === gamePk);
    if (found) { gameData = found; break; }
  }
  if (!gameData) return;

  const tempGame = {
    gamePk,
    away: {
      team: gameData.teams?.away?.team?.teamName || gameData.teams?.away?.team?.name || '—',
      id: gameData.teams?.away?.team?.id,
      pitcherName: gameData.decisions?.loser?.fullName || gameData.teams?.away?.probablePitcher?.fullName || '',
      pitcherId: null, lineup: []
    },
    home: {
      team: gameData.teams?.home?.team?.teamName || gameData.teams?.home?.team?.name || '—',
      id: gameData.teams?.home?.team?.id,
      pitcherName: gameData.decisions?.winner?.fullName || gameData.teams?.home?.probablePitcher?.fullName || '',
      pitcherId: null, lineup: []
    },
    venue: gameData.venue?.name || '—',
    venueId: gameData.venue?.id,
    time: 'FINAL',
    isLive: false,
    isFinal: true,
    awayScore: gameData.teams?.away?.score ?? 0,
    homeScore: gameData.teams?.home?.score ?? 0,
  };

  if (!todayGames.find(g => g.gamePk === gamePk)) todayGames.push(tempGame);
  openGameModal(gamePk);
}

function openMLBModal() {
  document.getElementById('mlbModalOverlay').classList.add('open');
  // Default to standings tab and load
  switchMLBTab('standings');
}
function closeMLBModal(e) {
  if (e && e.target !== document.getElementById('mlbModalOverlay')) return;
  document.getElementById('mlbModalOverlay').classList.remove('open');
}
function closeTeamModal(e) {
  if (e && e.target !== document.getElementById('teamModalOverlay')) return;
  document.getElementById('teamModalOverlay').classList.remove('open');
}

// Team ID lookup
const TEAM_ID_MAP = {
  'ARI':109,'ATL':144,'BAL':110,'BOS':111,'CHC':112,'CWS':145,'CIN':113,
  'CLE':114,'COL':115,'DET':116,'HOU':117,'KC':118,'LAA':108,'LAD':119,
  'MIA':146,'MIL':158,'MIN':142,'NYM':121,'NYY':147,'ATH':133,'PHI':143,
  'PIT':134,'SD':135,'SF':137,'SEA':136,'STL':138,'TB':139,'TEX':140,
  'TOR':141,'WSH':120
};

// Venue ID lookup (for dimensions)
const VENUE_ID_MAP = {
  'ARI':15,'ATL':4705,'BAL':2,'BOS':3,'CHC':17,'CWS':4,'CIN':2602,
  'CLE':5,'COL':19,'DET':2394,'HOU':2392,'KC':7,'LAA':1,'LAD':22,
  'MIA':4169,'MIL':32,'MIN':3312,'NYM':3289,'NYY':3313,'ATH':10,'PHI':2681,
  'PIT':31,'SD':2680,'SF':2395,'SEA':680,'STL':2889,'TB':12,'TEX':5325,
  'TOR':14,'WSH':3309
};

const teamModalCache = {}; // re-fetches fresh each session

async function openTeamModal(abbr, name) {
  document.getElementById('teamModalTitle').textContent = '⚾ ' + name;
  const tc = tickerTeamColor(abbr);
  document.getElementById('teamModalHeader').style.borderBottom = `2px solid ${tc}`;

  ['tmVenue','tmSurface','tmRoof','tmCapacity'].forEach(id => {
    document.getElementById(id).textContent = id === 'tmVenue' ? '🏟️ Loading...' :
      id === 'tmSurface' ? '🌿 —' : id === 'tmRoof' ? '☁️ —' : '👥 —';
  });
  ['dimLF','dimLC','dimCF','dimRC','dimRF','dimHR'].forEach(id => { document.getElementById(id).textContent = '—'; });
  document.getElementById('dimHRCard').style.display = 'none';
  document.getElementById('teamSeasonStats').innerHTML = `<div style="font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--text-dim);text-align:center;padding:12px 0;">Loading stats...</div>`;
  document.getElementById('teamLeaders').innerHTML     = `<div style="font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--text-dim);text-align:center;padding:12px 0;">Loading leaders...</div>`;
  document.getElementById('rosterSearch').value = '';
  document.getElementById('teamModalRoster').innerHTML = `<div style="font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--text-dim);padding:20px 0;text-align:center;">Loading roster...</div>`;
  document.getElementById('teamModalOverlay').classList.add('open');

  if (teamModalCache[abbr]) { renderTeamModal(abbr, teamModalCache[abbr]); return; }

  try {
    const teamId  = TEAM_ID_MAP[abbr];
    const venueId = VENUE_ID_MAP[abbr];

    const [venueData, rosterData, teamStatsData, standingsData, leadersHR, leadersHits, leadersAVG, leadersSO] = await Promise.all([
      venueId ? fetchJSON(`${BASE}/venues/${venueId}?hydrate=fieldInfo,location`).catch(()=>null) : null,
      teamId  ? fetchJSON(`${BASE}/teams/${teamId}/roster?rosterType=40Man&season=${SEASON}&hydrate=person`).catch(()=>({roster:[]})) : {roster:[]},
      teamId  ? fetchJSON(`${BASE}/teams/${teamId}/stats?stats=season&season=${SEASON}&group=hitting`).catch(()=>null) : null,
      teamId  ? fetchJSON(`${BASE}/standings?leagueId=103,104&season=${SEASON}&hydrate=team`).catch(()=>null) : null,
      teamId  ? fetchJSON(`${BASE}/teams/${teamId}/leaders?leaderCategories=homeRuns&season=${SEASON}&leaderGameTypes=R&limit=5`).catch(()=>null) : null,
      teamId  ? fetchJSON(`${BASE}/teams/${teamId}/leaders?leaderCategories=hits&season=${SEASON}&leaderGameTypes=R&limit=5`).catch(()=>null) : null,
      teamId  ? fetchJSON(`${BASE}/teams/${teamId}/leaders?leaderCategories=battingAverage&season=${SEASON}&leaderGameTypes=R&limit=5`).catch(()=>null) : null,
      teamId  ? fetchJSON(`${BASE}/teams/${teamId}/leaders?leaderCategories=strikeOuts&season=${SEASON}&leaderGameTypes=R&limit=5`).catch(()=>null) : null,
    ]);

    const data = { venueData, rosterData, teamStatsData, standingsData, leadersHR, leadersHits, leadersAVG, leadersSO };
    teamModalCache[abbr] = data;
    renderTeamModal(abbr, data);
  } catch(e) {
    console.warn('Team modal fetch failed:', e);
    document.getElementById('tmVenue').textContent = '🏟️ Data unavailable';
  }
}

function renderTeamModal(abbr, { venueData, rosterData, teamStatsData, standingsData, leadersHR, leadersHits, leadersAVG, leadersSO }) {
  const tc = tickerTeamColor(abbr);
  const teamId = TEAM_ID_MAP[abbr];
  const venue = venueData?.venues?.[0];

  // Venue info
  if (venue) {
    document.getElementById('tmVenue').textContent = '🏟️ ' + (venue.name || '—');
    const fi = venue.fieldInfo;
    if (fi) {
      document.getElementById('tmSurface').textContent  = '🌿 ' + (fi.turfType || 'Grass');
      document.getElementById('tmRoof').textContent     = '☁️ ' + (fi.roofType || 'Open');
      // Capacity can be in fieldInfo.capacity or venue.location.defaultCoordinates or venue.capacity
      const cap = fi.capacity || venue.capacity || venue.location?.capacity;
      document.getElementById('tmCapacity').textContent = '👥 ' + (cap ? Number(cap).toLocaleString() : '—');
      if (fi.leftLine)   { document.getElementById('dimLF').textContent = fi.leftLine + ' ft'; }
      if (fi.leftCenter) { document.getElementById('dimLC').textContent = fi.leftCenter + ' ft'; }
      if (fi.center)     { document.getElementById('dimCF').textContent = fi.center + ' ft'; }
      if (fi.rightCenter){ document.getElementById('dimRC').textContent = fi.rightCenter + ' ft'; }
      if (fi.rightLine)  { document.getElementById('dimRF').textContent = fi.rightLine + ' ft'; }
    }
  }

  // HR total from venues array
  const venueEntry = venues.find(v => v.venueId === VENUE_ID_MAP[abbr]);
  if (venueEntry) {
    const venueRank = venues.indexOf(venueEntry) + 1;
    document.getElementById('dimHR').textContent = `${venueEntry.hr} HR`;
    document.getElementById('dimHRRank').textContent = `(#${venueRank} of 30)`;
    document.getElementById('dimHRCard').style.display = 'block';
  }

  // ── TEAM SEASON STATS ──
  const statsEl = document.getElementById('teamSeasonStats');

  // Find W-L record from standings
  let wl = '—', homeRec = '—', awayRec = '—', pct = '—', gb = '—';
  if (standingsData?.records) {
    for (const div of standingsData.records) {
      const found = div.teamRecords?.find(r => r.team?.id === teamId);
      if (found) {
        wl      = `${found.wins}-${found.losses}`;
        pct     = found.winningPercentage || '—';
        gb      = found.gamesBack === '-' ? '—' : (found.gamesBack || '0');
        homeRec = found.records?.splitRecords?.find(s=>s.type==='home')  ? `${found.records.splitRecords.find(s=>s.type==='home').wins}-${found.records.splitRecords.find(s=>s.type==='home').losses}` : '—';
        awayRec = found.records?.splitRecords?.find(s=>s.type==='away')  ? `${found.records.splitRecords.find(s=>s.type==='away').wins}-${found.records.splitRecords.find(s=>s.type==='away').losses}` : '—';
        break;
      }
    }
  }

  // Team batting stats
  const splits = teamStatsData?.stats?.[0]?.splits;
  const s = splits?.length ? splits[0].stat : null;

  function statCard(label, val, color) {
    return `<div class="dim-card">
      <div class="dim-label">${label}</div>
      <div class="dim-val" style="${color?'color:'+color+';font-size:18px;':''}">${val}</div>
    </div>`;
  }

  statsEl.innerHTML = `
    <div style="margin-bottom:10px;">
      <div style="font-family:'IBM Plex Mono',monospace;font-size:9px;letter-spacing:2px;color:var(--text-dim);text-transform:uppercase;margin-bottom:8px;">Season Record</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        ${statCard('Overall', wl, tc)}
        ${statCard('Home', homeRec)}
        ${statCard('Away', awayRec)}
        ${statCard('PCT', pct)}
        ${statCard('GB', gb === '—' ? '—' : (gb === '0' ? '—' : gb))}
      </div>
    </div>
    <div>
      <div style="font-family:'IBM Plex Mono',monospace;font-size:9px;letter-spacing:2px;color:var(--text-dim);text-transform:uppercase;margin-bottom:8px;">Team Batting</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        ${statCard('AVG',  s?.avg||'—')}
        ${statCard('HR',   s?.homeRuns??'—', tc)}
        ${statCard('HITS', s?.hits??'—')}
        ${statCard('RBI',  s?.rbi??'—')}
        ${statCard('OBP',  s?.obp||'—')}
        ${statCard('SLG',  s?.slg||'—')}
        ${statCard('OPS',  s?.ops||'—')}
        ${statCard('SO',   s?.strikeOuts??'—', 'var(--accent-red)')}
        ${statCard('SB',   s?.stolenBases??'—', 'var(--accent-green)')}
        ${statCard('R',    s?.runs??'—')}
      </div>
    </div>`;

  // ── TEAM LEADERS ──
  const leadersEl = document.getElementById('teamLeaders');
  if (leadersEl) {
    function leaderRows(leaderData, valKey, color) {
      const leaders = leaderData?.teamLeaders?.[0]?.leaders || [];
      if (!leaders.length) return `<div style="font-family:'IBM Plex Mono',monospace;font-size:10px;color:var(--text-dim);padding:8px;">No data</div>`;
      return leaders.map((l, i) => {
        const pid  = l.person?.id;
        const name = l.person?.fullName || '—';
        const val  = l.value ?? '—';
        const firstName = name.split(' ')[0];
        const lastName  = name.split(' ').slice(1).join(' ');
        return `<div class="leaders-player-row" onclick="openPlayerModal(${pid},'${name.replace(/'/g,"\\'")}','${abbr}')">
          <span class="leaders-rank">${i+1}</span>
          <span class="leaders-name" title="${name}">${name}</span>
          <span class="leaders-val" style="${color?'color:'+color+';':''}">${val}</span>
        </div>`;
      }).join('');
    }

    function leaderCol(title, icon, leaderData, valKey, color, headerColor) {
      return `<div class="leaders-col">
        <div class="leaders-col-header" style="color:${headerColor||color||'var(--text)'};">
          <span>${icon} ${title}</span>
          <span class="leaders-col-stat" style="color:${color||'var(--text)'};">${valKey.toUpperCase()}</span>
        </div>
        ${leaderRows(leaderData, valKey, color)}
      </div>`;
    }

    leadersEl.innerHTML = `<div class="leaders-grid">
      ${leaderCol('Home Runs',   '💣', leadersHR,   'hr',  tc,                         tc)}
      ${leaderCol('Hits',        '⚾', leadersHits, 'hits', 'var(--accent-blue)',        'var(--accent-blue)')}
      ${leaderCol('Batting Avg', '📊', leadersAVG,  'avg',  'var(--accent-green)',       'var(--accent-green)')}
      ${leaderCol('Strikeouts',  '🔥', leadersSO,   'so',   'var(--accent-red)',         'var(--accent-red)')}
    </div>`;
  }

  // Roster — sort by position
  const posOrder = {TWP:-1,P:0,C:1,'1B':2,'2B':3,'3B':4,SS:5,LF:6,CF:7,RF:8,OF:9,DH:10};
  const roster = (rosterData?.roster || []).sort((a,b) =>
    (posOrder[a.position?.abbreviation]??99) - (posOrder[b.position?.abbreviation]??99)
  );

  if (!roster.length) {
    document.getElementById('teamModalRoster').innerHTML = `<div style="font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--text-dim);padding:20px 0;text-align:center;">No roster data available</div>`;
    return;
  }

  // Group by position category
  const twoWay  = roster.filter(p => p.position?.abbreviation === 'TWP');
  const pitchers = roster.filter(p => p.position?.abbreviation === 'P');
  const catchers = roster.filter(p => p.position?.abbreviation === 'C');
  const infield  = roster.filter(p => ['1B','2B','3B','SS'].includes(p.position?.abbreviation));
  const outfield = roster.filter(p => ['LF','CF','RF','OF'].includes(p.position?.abbreviation));
  const dh       = roster.filter(p => p.position?.abbreviation === 'DH');

  function playerRows(players) {
    return players.map(p => `
      <tr onclick="openPlayerModal(${p.person?.id},'${(p.person?.fullName||'').replace(/'/g,"\\'")}','${abbr}')" style="cursor:pointer;">
        <td class="roster-pos" style="color:${tc};">${p.position?.abbreviation||'—'}</td>
        <td class="roster-name">${p.person?.fullName||'—'}</td>
        <td class="roster-bats">${p.person?.batSide?.code||'—'} / ${p.person?.pitchHand?.code||'—'}</td>
        <td class="roster-num">#${p.jerseyNumber||'—'}</td>
      </tr>`).join('');
  }

  let sectionId = 0;
  function accordionSection(label, icon, players, startOpen) {
    if (!players.length) return '';
    const id = `acc-${abbr}-${sectionId++}`;
    const openClass = startOpen ? 'open' : '';
    return `
      <div class="accordion-section">
        <div class="accordion-header" onclick="toggleAccordion('${id}')">
          <span class="accordion-title" style="color:${tc};">${icon} ${label}</span>
          <span class="accordion-meta">
            <span>${players.length} players</span>
            <span class="accordion-arrow ${openClass}" id="arrow-${id}">▼</span>
          </span>
        </div>
        <div class="accordion-body ${openClass}" id="${id}">
          <table class="roster-table">
            <thead><tr>
              <th>POS</th><th>Player</th><th>B/T</th><th style="text-align:right;">#</th>
            </tr></thead>
            <tbody>${playerRows(players)}</tbody>
          </table>
        </div>
      </div>`;
  }

  document.getElementById('teamModalRoster').innerHTML = `
    <div class="roster-accordion">
      ${accordionSection('Two-Way Players', '⭐', twoWay, true)}
      ${accordionSection('Pitchers', '🥎', pitchers, false)}
      ${accordionSection('Catchers', '🧤', catchers, false)}
      ${accordionSection('Infield', '🏟️', infield, false)}
      ${accordionSection('Outfield', '⚾', outfield, false)}
      ${accordionSection('DH', '🎯', dh, false)}
    </div>`;
}

function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebarOverlay');
  sidebar.classList.toggle('open');
  overlay.classList.toggle('open');
}

function updateSidebarThreats(alerts, noHRAlerts) {
  const triples  = alerts.filter(a=>a.type==='triple').length;
  const doubles  = alerts.filter(a=>a.type==='double').length;
  const noHRTrip = (noHRAlerts||[]).filter(a=>a.type==='nohr-triple').length;
  const noHRDbl  = (noHRAlerts||[]).filter(a=>a.type==='nohr-double').length;
  const stc = document.getElementById('sidebarTripleCount');     if (stc) stc.textContent = triples;
  const sdc = document.getElementById('sidebarDoubleCount');     if (sdc) sdc.textContent = doubles;
  const sntc = document.getElementById('sidebarNoHRTripleCount'); if (sntc) sntc.textContent = noHRTrip;
  const sndc = document.getElementById('sidebarNoHRDoubleCount'); if (sndc) sndc.textContent = noHRDbl;
}

function updateSidebarScoreRankings(gameScores) {
  const el = document.getElementById('sidebarScoreRankings');
  if (!el) return;
  if (!gameScores || !gameScores.length) {
    el.innerHTML = `<div class="hr-feed-empty">No pregame scores yet</div>`; return;
  }
  el.innerHTML = gameScores
    .filter(g => g.score !== null)
    .sort((a,b) => b.score - a.score)
    .map(g => `
      <div class="score-rank-item">
        <div class="score-rank-matchup">${g.away} @ ${g.home}</div>
        <div class="score-rank-num" style="color:${hrpsColor(g.score)};">${g.score}</div>
      </div>`).join('');
}

function updateSidebarHRFeed() {
  const el = document.getElementById('sidebarHRFeed');
  const allHitters = [];
  for (const game of todayGames) {
    if (!game._tickerData) continue;
    for (const p of game._tickerData) {
      if (p.todayHR > 0) allHitters.push(p);
    }
  }
  if (!allHitters.length) {
    el.innerHTML = `<div class="hr-feed-empty">No HRs yet today</div>`; return;
  }
  el.innerHTML = allHitters.sort((a,b)=>b.todayHR-a.todayHR).map(p => {
    const tc = tickerTeamColor(p.team);
    return `<div class="hr-feed-item">
      <div class="hr-feed-name">${p.name} <span style="color:${tc};font-size:10px;font-weight:700;">${p.team}</span></div>
      <div class="hr-feed-meta">${p.todayHR} HR today · ${p.seasonHR} season</div>
    </div>`;
  }).join('');
}

// ── PLAYER SEARCH ─────────────────────────────────────────────────────
const TEAM_ID_TO_ABBR = {
  109:'ARI',144:'ATL',110:'BAL',111:'BOS',112:'CHC',145:'CWS',113:'CIN',114:'CLE',
  115:'COL',116:'DET',117:'HOU',118:'KC',108:'LAA',119:'LAD',146:'MIA',158:'MIL',
  142:'MIN',121:'NYM',147:'NYY',133:'ATH',143:'PHI',134:'PIT',135:'SD',137:'SF',
  136:'SEA',138:'STL',139:'TB',140:'TEX',141:'TOR',120:'WSH'
};

let allPlayers = [];
function buildPlayerIndex() {
  allPlayers = [];
  const seen = new Set();

  function addPlayer(id, name, team) {
    if (!id || !name || seen.has(id)) return;
    seen.add(id);
    allPlayers.push({ id, name, team: team || '—' });
  }

  // From leaderboards
  for (const p of hitters)    addPlayer(p.id, p.name, p.team);
  for (const p of hrPitchers) addPlayer(p.id, p.name, p.team);
  for (const p of koPitchers) addPlayer(p.id, p.name, p.team);

  // From roster cache (keyed by teamId number)
  for (const [key, roster] of Object.entries(rosterCache)) {
    const abbr = TEAM_ID_TO_ABBR[key] || key;
    for (const p of (roster || [])) {
      addPlayer(p.person?.id, p.person?.fullName, abbr);
    }
  }

  allPlayers.sort((a,b) => a.name.localeCompare(b.name));
}

// ── PRE-FETCH ALL ROSTERS FOR SEARCH ──────────────────────────────────
// Runs silently in background after dashboard loads
// Fetches all 30 rosters with a small delay between each to avoid hammering the API
async function prefetchAllRosters() {
  const TEAM_IDS = [
    {id:109,abbr:'ARI'},{id:144,abbr:'ATL'},{id:110,abbr:'BAL'},{id:111,abbr:'BOS'},
    {id:112,abbr:'CHC'},{id:145,abbr:'CWS'},{id:113,abbr:'CIN'},{id:114,abbr:'CLE'},
    {id:115,abbr:'COL'},{id:116,abbr:'DET'},{id:117,abbr:'HOU'},{id:118,abbr:'KC'},
    {id:108,abbr:'LAA'},{id:119,abbr:'LAD'},{id:146,abbr:'MIA'},{id:158,abbr:'MIL'},
    {id:142,abbr:'MIN'},{id:121,abbr:'NYM'},{id:147,abbr:'NYY'},{id:133,abbr:'ATH'},
    {id:143,abbr:'PHI'},{id:134,abbr:'PIT'},{id:135,abbr:'SD'}, {id:137,abbr:'SF'},
    {id:136,abbr:'SEA'},{id:138,abbr:'STL'},{id:139,abbr:'TB'}, {id:140,abbr:'TEX'},
    {id:141,abbr:'TOR'},{id:120,abbr:'WSH'}
  ];

  for (const team of TEAM_IDS) {
    if (rosterCache[team.id]) continue; // already loaded
    try {
      await new Promise(r => setTimeout(r, 200)); // small delay between calls
      const d = await fetchJSON(`${BASE}/teams/${team.id}/roster?rosterType=40Man&season=${SEASON}`);
      rosterCache[team.id] = d.roster || [];
      buildPlayerIndex(); // rebuild index as each roster comes in
    } catch(e) { /* silent fail — search just won't include this team */ }
  }
}

function handlePlayerSearch(val) {
  const el = document.getElementById('searchResults');
  if (!val || val.length < 2) { el.innerHTML = ''; return; }
  const q = val.toLowerCase();
  const matches = allPlayers.filter(p => p.name.toLowerCase().includes(q)).slice(0, 10);
  if (!matches.length) { el.innerHTML = `<div class="search-result-item" style="color:var(--text-dim);">No results found</div>`; return; }
  el.innerHTML = matches.map(p => {
    const tc = tickerTeamColor(p.team);
    return `<div class="search-result-item" onclick="openPlayerModal(${p.id},'${p.name.replace(/'/g,"\\'")}','${p.team}');document.getElementById('searchResults').innerHTML='';document.getElementById('sidebarSearch').value='';">
      <span style="flex:1;">${p.name}</span>
      <span style="font-family:'IBM Plex Mono',monospace;font-size:9px;font-weight:700;color:${tc};">${p.team}</span>
    </div>`;
  }).join('');
}

// ── TEAM ROSTERS ──────────────────────────────────────────────────────
const MLB_TEAMS = [
  {id:109,name:'Arizona Diamondbacks',abbr:'ARI'},{id:144,name:'Atlanta Braves',abbr:'ATL'},
  {id:110,name:'Baltimore Orioles',abbr:'BAL'},{id:111,name:'Boston Red Sox',abbr:'BOS'},
  {id:112,name:'Chicago Cubs',abbr:'CHC'},{id:145,name:'Chicago White Sox',abbr:'CWS'},
  {id:113,name:'Cincinnati Reds',abbr:'CIN'},{id:114,name:'Cleveland Guardians',abbr:'CLE'},
  {id:115,name:'Colorado Rockies',abbr:'COL'},{id:116,name:'Detroit Tigers',abbr:'DET'},
  {id:117,name:'Houston Astros',abbr:'HOU'},{id:118,name:'Kansas City Royals',abbr:'KC'},
  {id:108,name:'Los Angeles Angels',abbr:'LAA'},{id:119,name:'Los Angeles Dodgers',abbr:'LAD'},
  {id:146,name:'Miami Marlins',abbr:'MIA'},{id:158,name:'Milwaukee Brewers',abbr:'MIL'},
  {id:142,name:'Minnesota Twins',abbr:'MIN'},{id:121,name:'New York Mets',abbr:'NYM'},
  {id:147,name:'New York Yankees',abbr:'NYY'},{id:133,name:'Oakland Athletics',abbr:'ATH'},
  {id:143,name:'Philadelphia Phillies',abbr:'PHI'},{id:134,name:'Pittsburgh Pirates',abbr:'PIT'},
  {id:135,name:'San Diego Padres',abbr:'SD'},{id:137,name:'San Francisco Giants',abbr:'SF'},
  {id:136,name:'Seattle Mariners',abbr:'SEA'},{id:138,name:'St. Louis Cardinals',abbr:'STL'},
  {id:139,name:'Tampa Bay Rays',abbr:'TB'},{id:140,name:'Texas Rangers',abbr:'TEX'},
  {id:141,name:'Toronto Blue Jays',abbr:'TOR'},{id:120,name:'Washington Nationals',abbr:'WSH'}
];

function buildRosterList() {
  const el = document.getElementById('sidebarRosters');
  if (!el) return;
  el.innerHTML = MLB_TEAMS.map(team => {
    const tc = tickerTeamColor(team.abbr);
    return `<div class="team-roster-item" id="roster-btn-${team.id}" onclick="toggleRoster(${team.id},'${team.abbr}')">
      <span class="team-roster-abbr" style="color:${tc};border:1px solid ${tc}44;">${team.abbr}</span>
      <span class="team-roster-name">${team.name}</span>
      <span class="team-roster-arrow">›</span>
    </div>
    <div class="roster-players" id="roster-${team.id}"></div>`;
  }).join('');
}

const rosterCache = {};
async function toggleRoster(teamId, abbr) {
  const btn   = document.getElementById(`roster-btn-${teamId}`);
  const panel = document.getElementById(`roster-${teamId}`);
  const isOpen = panel.classList.contains('open');

  // Close all others
  document.querySelectorAll('.roster-players.open').forEach(el=>el.classList.remove('open'));
  document.querySelectorAll('.team-roster-item.open').forEach(el=>el.classList.remove('open'));

  if (isOpen) return;
  btn.classList.add('open');
  panel.classList.add('open');

  if (rosterCache[teamId]) { renderRoster(panel, rosterCache[teamId], abbr); return; }

  panel.innerHTML = `<div class="roster-loading">Loading roster...</div>`;
  try {
    const d = await fetchJSON(`${BASE}/teams/${teamId}/roster?rosterType=active&season=${SEASON}`);
    const posOrder = {P:0,C:1,'1B':2,'2B':3,'3B':4,SS:5,LF:6,CF:7,RF:8,DH:9,OF:10};
    const roster = (d.roster||[]).sort((a,b)=>(posOrder[a.position?.abbreviation]??99)-(posOrder[b.position?.abbreviation]??99));
    rosterCache[teamId] = roster;
    renderRoster(panel, roster, abbr);
  } catch(e) { panel.innerHTML = `<div class="roster-loading">Could not load roster</div>`; }
}

function renderRoster(panel, roster, abbr) {
  const tc = tickerTeamColor(abbr);
  panel.innerHTML = roster.map(p => `
    <div class="roster-player">
      <span class="roster-player-pos" style="color:${tc};">${p.position?.abbreviation||'—'}</span>
      <span style="flex:1;">${p.person?.fullName||'—'}</span>
      <span class="roster-player-num">#${p.jerseyNumber||'—'}</span>
    </div>`).join('') || `<div class="roster-loading">No roster data</div>`;
}

// ── HR TICKER ─────────────────────────────────────────────────────────
function renderHRTicker() {
  const track = document.getElementById('hrTickerTrack');
  const label = document.getElementById('hrTickerLabel');
  if (!track) return;

  // Check if any game has started today (live or final)
  const anyGameStarted = todayGames.some(g => g.isLive || g.isFinal);

  let items = [];

  if (anyGameStarted) {
    // Build today's HR performers from box scores
    // Pull from todayGames — each game has hitters with today HR data
    const todayHRMap = {}; // playerId -> { name, team, todayHR, seasonHR }

    for (const game of todayGames) {
      if (!game.isLive && !game.isFinal) continue;
      // Use the lineup data stored on the game if available
      if (game._tickerData) {
        for (const p of game._tickerData) {
          if (p.todayHR > 0) {
            if (!todayHRMap[p.id] || todayHRMap[p.id].todayHR < p.todayHR) {
              todayHRMap[p.id] = p;
            }
          }
        }
      }
    }

    const todayHitters = Object.values(todayHRMap).sort((a,b)=>b.todayHR-a.todayHR);

    if (todayHitters.length > 0) {
      label.innerHTML = `<span style="color:var(--accent-green);margin-right:6px;">● LIVE!</span> HR Leaders`;
      items = todayHitters.map(p => {
        const tc = tickerTeamColor(p.team);
        const tcLight = tc + "44";
        // seasonHR from boxscore already includes today's HR
        return `<span class="hr-ticker-item">
          <span class="ticker-name">${p.name}</span>
          <span class="ticker-today">${p.todayHR} HR (${p.seasonHR})</span>
          <span style="font-family:'IBM Plex Mono',monospace;font-size:10px;font-weight:700;color:${tc};border:1px solid ${tcLight};padding:1px 5px;border-radius:3px;">${p.team}</span>
        </span>`;
      });
    } else {
      // Games live but no HRs yet — show blank with message, no scrolling
      label.innerHTML = `<span style="color:var(--accent-green);margin-right:6px;">● LIVE!</span> HR Leaders`;
      track.innerHTML = `<span class="hr-ticker-item" style="color:var(--text-dim);font-family:'IBM Plex Mono',monospace;font-size:11px;">No home runs yet today — check back soon</span>`;
      track.style.animation = 'none';
      return;
    }
  } else {
    // Pre-game — show season HR leaders as filler
    label.textContent = 'HR Leaders';
    items = hitters.slice(0,15).map(p => {
      const tc = tickerTeamColor(p.team);
      const tcLight = tc + "44";
      return `<span class="hr-ticker-item">
        <span class="ticker-name">${p.name}</span>
        <span class="ticker-dot">·</span>
        <span class="ticker-season">${p.hr} HR</span>
        <span style="font-family:'IBM Plex Mono',monospace;font-size:10px;font-weight:700;color:${tc};border:1px solid ${tcLight};padding:1px 5px;border-radius:3px;">${p.team}</span>
      </span>`;
    });
  }

  if (!items.length) return;

  if (!items.length) return;

  // Kill any existing animation
  if (window._tickerAnimId) { cancelAnimationFrame(window._tickerAnimId); window._tickerAnimId = null; }
  track.style.animation = 'none';
  track.style.transform = 'translateX(0)';

  // Single set first so we can measure true width
  track.innerHTML = items.join('');

  if (items.length >= 2) {
    setTimeout(() => {
      // Temporarily lift overflow to get true scrollWidth
      const wrap = document.getElementById('hrTickerWrap');
      wrap.style.overflow = 'visible';
      const singleWidth = track.scrollWidth;
      wrap.style.overflow = '';

      if (singleWidth === 0) return;

      // Now double the items for seamless loop
      track.innerHTML = items.join('') + items.join('');

      const speed = 80; // pixels per second
      let pos = 0;
      let lastTime = null;

      function step(ts) {
        if (!lastTime) lastTime = ts;
        const delta = ts - lastTime;
        lastTime = ts;
        pos += speed * (delta / 1000);
        // Reset exactly at the end of the first set — jumps back silently
        if (pos >= singleWidth) pos -= singleWidth;
        track.style.transform = `translateX(-${pos}px)`;
        window._tickerAnimId = requestAnimationFrame(step);
      }

      window._tickerAnimId = requestAnimationFrame(step);
    }, 300);
  }
}

// ── TICKER TODAY HR DATA (called during live refresh) ─────────────────
async function fetchTickerHRData() {
  for (const game of todayGames) {
    if (!game.isLive && !game.isFinal) continue;
    if (game._tickerData) continue; // already fetched
    try {
      const box = await fetchJSON(`${BASE}/game/${game.gamePk}/boxscore`);
      const tickerPlayers = [];
      for (const side of ['away','home']) {
        const players = box.teams?.[side]?.players || {};
        for (const [,pd] of Object.entries(players)) {
          const todayHR = pd.stats?.batting?.homeRuns || 0;
          if (todayHR > 0) {
            const id   = pd.person?.id;
            const name = pd.person?.fullName || '—';
            const team = side === 'away' ? game.away.team : game.home.team;
            // Try season stats from boxscore first, then fall back to hitters array
            const seasonStatsHR = pd.seasonStats?.batting?.homeRuns ?? null;
            const hitterData    = hitters.find(h => h.id === id);
            const seasonHR      = seasonStatsHR !== null ? seasonStatsHR : (hitterData?.hr ?? todayHR);
            tickerPlayers.push({ id, name, team, todayHR, seasonHR });
          }
        }
      }
      game._tickerData = tickerPlayers;
    } catch { game._tickerData = []; }
  }
}
function closeModal(e) {
  if (e.target === document.getElementById('modalOverlay')) closeModalDirect();
}
function closeModalDirect() {
  document.getElementById('modalOverlay').classList.remove('open');
  document.body.style.overflow = '';
}

async function openGameModal(gamePk) {
  const game = todayGames.find(g=>g.gamePk===gamePk);
  if (!game) return;

  // Open modal immediately with loading state
  const overlay = document.getElementById('modalOverlay');
  document.getElementById('modalTitle').textContent = `${game.away.team} @ ${game.home.team}`;
  document.getElementById('modalSubtitle').innerHTML = `${game.time} · <span onclick="openTeamModal('${game.home.team}','${(game.home.name||game.home.team).replace(/'/g,"\\'")}');closeModalDirect();" style="cursor:pointer;text-decoration:underline dotted;text-underline-offset:3px;">${game.venue}</span>`;
  document.getElementById('modalBody').innerHTML = `<div class="modal-loading">⚾ LOADING GAME DATA...</div>`;
  overlay.classList.add('open');
  document.body.style.overflow = 'hidden';

  // Fetch all expanded data in parallel — each catches independently
  try {
    const [boxData, awayPitcherStats, homePitcherStats, awayRecentStarts, homeRecentStarts, weatherData, linescoreData] = await Promise.all([
      fetchJSON(`${BASE}/game/${gamePk}/boxscore`).catch(()=>null),
      game.away.pitcherId ? fetchPitcherSeasonStats(game.away.pitcherId).catch(()=>null) : Promise.resolve(null),
      game.home.pitcherId ? fetchPitcherSeasonStats(game.home.pitcherId).catch(()=>null) : Promise.resolve(null),
      game.away.pitcherId ? fetchPitcherRecentStarts(game.away.pitcherId).catch(()=>[]) : Promise.resolve([]),
      game.home.pitcherId ? fetchPitcherRecentStarts(game.home.pitcherId).catch(()=>[]) : Promise.resolve([]),
      fetchWeather(game.venue, game.venueId).catch(()=>null),
      fetchJSON(`${BASE}/game/${gamePk}/linescore`).catch(()=>null),
    ]);

    // Get full lineups and player data from boxscore
    const awayLineup  = boxData?.teams?.away?.battingOrder || [];
    const homeLineup  = boxData?.teams?.home?.battingOrder || [];
    const awayPlayers = boxData?.teams?.away?.players || {};
    const homePlayers = boxData?.teams?.home?.players || {};

    // Fetch season hitting stats for every player in both lineups
    const allLineupIds = [...new Set([...awayLineup, ...homeLineup])];
    const playerSeasonStats = {};
    if (allLineupIds.length) {
      await Promise.all(allLineupIds.map(async id => {
        try {
          const d = await fetchJSON(`${BASE}/people/${id}/stats?stats=season&group=hitting&season=${SEASON}&sportId=1`);
          const s = d.stats?.[0]?.splits?.[0]?.stat;
          if (s) playerSeasonStats[id] = { avg: s.avg||'.000', hits: s.hits||0, hr: s.homeRuns||0 };
        } catch {}
      }));
    }

    // Always define these so renderModal never crashes
    const hitterIds = new Set(hitters.map(h=>h.id));
    const hitterMap = Object.fromEntries(hitters.map((h,i)=>[h.id,{...h,rank:i+1}]));
    const h2hMap    = {}; // disabled until later in season

    renderModal(game, {
      awayPitcherStats, homePitcherStats,
      awayRecentStarts, homeRecentStarts,
      awayLineup, homeLineup,
      awayPlayers, homePlayers,
      playerSeasonStats,
      weatherData, h2hMap, hitterIds, hitterMap,
      linescoreData, boxData,
    });

  } catch(e) {
    console.error('Modal fetch error', e);
    document.getElementById('modalBody').innerHTML = `<div class="modal-loading" style="color:var(--accent-red)">⚠ Could not load game data.</div>`;
  }
}

async function fetchPitcherSeasonStats(pitcherId) {
  try {
    const d = await fetchJSON(`${BASE}/people/${pitcherId}/stats?stats=season&group=pitching&season=${SEASON}&sportId=1`);
    return d.stats?.[0]?.splits?.[0]?.stat || null;
  } catch { return null; }
}

async function fetchPitcherRecentStarts(pitcherId) {
  try {
    const d = await fetchJSON(`${BASE}/people/${pitcherId}/stats?stats=gameLog&group=pitching&season=${SEASON}&sportId=1&gameType=R&limit=3`);
    return (d.stats?.[0]?.splits||[]).slice(0,3).map(s=>({
      date: s.date||'',
      opponent: s.opponent?.abbreviation||'—',
      ip: s.stat?.inningsPitched||'0',
      er: s.stat?.earnedRuns??'—',
      k: s.stat?.strikeOuts??'—',
      hr: s.stat?.homeRuns??'—',
    }));
  } catch { return []; }
}

// Stadium coordinates for accurate weather lookup
const VENUE_COORDS = {
  'Yankee Stadium':                    { lat: 40.8296, lon: -73.9262, city: 'New York, NY' },
  'Fenway Park':                       { lat: 42.3467, lon: -71.0972, city: 'Boston, MA' },
  'Camden Yards':                      { lat: 39.2838, lon: -76.6218, city: 'Baltimore, MD' },
  'Oriole Park at Camden Yards':       { lat: 39.2838, lon: -76.6218, city: 'Baltimore, MD' },
  'Tropicana Field':                   { lat: 27.7683, lon: -82.6534, city: 'St. Petersburg, FL' },
  'Rogers Centre':                     { lat: 43.6414, lon: -79.3894, city: 'Toronto, ON' },
  'Guaranteed Rate Field':             { lat: 41.8300, lon: -87.6338, city: 'Chicago, IL' },
  'Comerica Park':                     { lat: 42.3390, lon: -83.0485, city: 'Detroit, MI' },
  'Kauffman Stadium':                  { lat: 39.0517, lon: -94.4803, city: 'Kansas City, MO' },
  'Target Field':                      { lat: 44.9817, lon: -93.2777, city: 'Minneapolis, MN' },
  'Minute Maid Park':                  { lat: 29.7572, lon: -95.3555, city: 'Houston, TX' },
  'Daikin Park':                       { lat: 29.7572, lon: -95.3555, city: 'Houston, TX' },
  'Angel Stadium':                     { lat: 33.8003, lon: -117.8827, city: 'Anaheim, CA' },
  'Oakland Coliseum':                  { lat: 37.7516, lon: -122.2005, city: 'Oakland, CA' },
  'Sutter Health Park':                { lat: 38.5802, lon: -121.5085, city: 'Sacramento, CA' },
  'T-Mobile Park':                     { lat: 47.5914, lon: -122.3325, city: 'Seattle, WA' },
  'Globe Life Field':                  { lat: 32.7473, lon: -97.0822, city: 'Arlington, TX' },
  'Truist Park':                       { lat: 33.8908, lon: -84.4678, city: 'Atlanta, GA' },
  'Wrigley Field':                     { lat: 41.9484, lon: -87.6553, city: 'Chicago, IL' },
  'Great American Ball Park':          { lat: 39.0979, lon: -84.5082, city: 'Cincinnati, OH' },
  'Coors Field':                       { lat: 39.7559, lon: -104.9942, city: 'Denver, CO' },
  'loanDepot park':                    { lat: 25.7781, lon: -80.2197, city: 'Miami, FL' },
  'American Family Field':             { lat: 43.0280, lon: -87.9712, city: 'Milwaukee, WI' },
  'Citi Field':                        { lat: 40.7571, lon: -73.8458, city: 'New York, NY' },
  'Citizens Bank Park':                { lat: 39.9061, lon: -75.1665, city: 'Philadelphia, PA' },
  'PNC Park':                          { lat: 40.4469, lon: -80.0057, city: 'Pittsburgh, PA' },
  'Busch Stadium':                     { lat: 38.6226, lon: -90.1928, city: 'St. Louis, MO' },
  'Petco Park':                        { lat: 32.7073, lon: -117.1566, city: 'San Diego, CA' },
  'Oracle Park':                       { lat: 37.7786, lon: -122.3893, city: 'San Francisco, CA' },
  'Nationals Park':                    { lat: 38.8730, lon: -77.0074, city: 'Washington, DC' },
  'Chase Field':                       { lat: 33.4453, lon: -112.0667, city: 'Phoenix, AZ' },
  'Dodger Stadium':                    { lat: 34.0739, lon: -118.2400, city: 'Los Angeles, CA' },
  'Uniqlo Field at Dodger Stadium':    { lat: 34.0739, lon: -118.2400, city: 'Los Angeles, CA' },
  'Progressive Field':                 { lat: 41.4962, lon: -81.6852, city: 'Cleveland, OH' },
};

// Wind direction degrees to compass
function degreesToCompass(deg) {
  const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
  return dirs[Math.round(deg / 22.5) % 16];
}

async function fetchWeather(venueName, venueId) {
  try {
    // Try exact match first, then partial match
    let coords = VENUE_COORDS[venueName];

    if (!coords) {
      // Try partial match — find a key that's contained in the venue name or vice versa
      const key = Object.keys(VENUE_COORDS).find(k =>
        venueName.toLowerCase().includes(k.toLowerCase()) ||
        k.toLowerCase().includes(venueName.toLowerCase())
      );
      if (key) coords = VENUE_COORDS[key];
    }

    if (!coords) return null;

    // Open-Meteo: free, no API key, returns current weather
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${coords.lat}&longitude=${coords.lon}&current=temperature_2m,apparent_temperature,precipitation,weathercode,windspeed_10m,winddirection_10m,relativehumidity_2m&temperature_unit=fahrenheit&windspeed_unit=mph&timezone=auto`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Open-Meteo HTTP ${r.status}`);
    const d = await r.json();
    const cur = d.current;
    if (!cur) return null;

    // Weather code to description
    const WMO = {
      0:'Clear Sky', 1:'Mainly Clear', 2:'Partly Cloudy', 3:'Overcast',
      45:'Fog', 48:'Icy Fog', 51:'Light Drizzle', 53:'Drizzle', 55:'Heavy Drizzle',
      61:'Light Rain', 63:'Rain', 65:'Heavy Rain', 71:'Light Snow', 73:'Snow', 75:'Heavy Snow',
      80:'Rain Showers', 81:'Rain Showers', 82:'Heavy Rain Showers',
      95:'Thunderstorm', 96:'Thunderstorm', 99:'Thunderstorm'
    };
    const desc = WMO[cur.weathercode] || 'Unknown';
    const windDir = degreesToCompass(cur.winddirection_10m);

    return {
      temp:     Math.round(cur.temperature_2m) + '°F',
      feels:    Math.round(cur.apparent_temperature) + '°F',
      desc,
      wind:     Math.round(cur.windspeed_10m) + ' mph',
      windDir,
      humidity: cur.relativehumidity_2m + '%',
      city:     coords.city,
    };
  } catch(e) {
    console.warn('Weather fetch failed:', e);
    return null;
  }
}

function windImpact(windDir) {
  if (!windDir) return '';
  const out = ['N','NNE','NE','NNW','NW'];
  const inn = ['S','SSE','SE','SSW','SW'];
  if (out.includes(windDir)) return 'wind-out';
  if (inn.includes(windDir)) return 'wind-in';
  return 'wind-cross';
}

function windLabel(windDir) {
  const cls = windImpact(windDir);
  if (cls==='wind-out') return '🔴 Blowing OUT — HR Favorable';
  if (cls==='wind-in')  return '🔵 Blowing IN — HR Suppressing';
  return '🟡 Crosswind — Neutral';
}

function renderModal(game, data) {
  const { awayPitcherStats, homePitcherStats, awayRecentStarts, homeRecentStarts,
          awayLineup, homeLineup, awayPlayers, homePlayers, playerSeasonStats,
          weatherData, h2hMap, hitterIds, hitterMap, linescoreData, boxData } = data;

  // ── WEATHER ──
  let weatherHTML = '';
  if (weatherData) {
    const wCls = windImpact(weatherData.windDir);
    weatherHTML = `
      <div class="modal-section">
        <div class="modal-section-title">🌤 Current Weather — ${weatherData.city||game.venue} <span style="font-size:9px;color:var(--text-dim);margin-left:8px;">(CURRENT CONDITIONS — NOT A GAME TIME FORECAST)</span></div>
        <div class="info-pills">
          <div class="info-pill">
            <div class="info-pill-label">Temp</div>
            <div class="info-pill-val">${weatherData.temp}</div>
            <div class="info-pill-sub">Feels ${weatherData.feels}</div>
          </div>
          <div class="info-pill">
            <div class="info-pill-label">Conditions</div>
            <div class="info-pill-val" style="font-size:14px;font-family:'IBM Plex Sans',sans-serif;font-weight:600;">${weatherData.desc}</div>
            <div class="info-pill-sub">Humidity ${weatherData.humidity}</div>
          </div>
          <div class="info-pill">
            <div class="info-pill-label">Wind</div>
            <div class="info-pill-val ${wCls}">${weatherData.wind}</div>
            <div class="info-pill-sub ${wCls}">${weatherData.windDir} · ${windLabel(weatherData.windDir)}</div>
          </div>
        </div>
      </div>`;
  }

  // ── BOX SCORE ──
  let boxScoreHTML = '';
  const innings = linescoreData?.innings || [];
  if (game.isLive || game.isFinal) {
    const awayRuns  = boxData?.teams?.away?.teamStats?.batting?.runs   ?? game.awayRuns ?? '—';
    const homeRuns  = boxData?.teams?.home?.teamStats?.batting?.runs   ?? game.homeRuns ?? '—';
    const awayHits  = boxData?.teams?.away?.teamStats?.batting?.hits   ?? '—';
    const homeHits  = boxData?.teams?.home?.teamStats?.batting?.hits   ?? '—';
    const awayErrors= boxData?.teams?.away?.teamStats?.fielding?.errors ?? '—';
    const homeErrors= boxData?.teams?.home?.teamStats?.fielding?.errors ?? '—';

    // Build inning columns
    const inningCols = innings.map((inn,i)=>`
      <th style="text-align:center;min-width:28px;">${i+1}</th>`).join('');
    const awayInningCells = innings.map(inn=>`
      <td style="text-align:center;font-family:'IBM Plex Mono',monospace;font-size:12px;">${inn.away?.runs??'—'}</td>`).join('');
    const homeInningCells = innings.map(inn=>`
      <td style="text-align:center;font-family:'IBM Plex Mono',monospace;font-size:12px;">${inn.home?.runs??'—'}</td>`).join('');

    boxScoreHTML = `
      <div class="modal-section">
        <div class="modal-section-title">📊 Box Score — ${game.isFinal ? 'Final' : 'In Progress'}</div>
        <div style="overflow-x:auto;">
          <table style="width:100%;border-collapse:collapse;font-size:12px;">
            <thead>
              <tr style="background:var(--surface2);">
                <th style="text-align:left;padding:7px 10px;font-family:'IBM Plex Mono',monospace;font-size:9px;letter-spacing:2px;color:var(--text-dim);width:60px;">TEAM</th>
                ${inningCols}
                <th style="text-align:center;padding:7px 10px;font-family:'IBM Plex Mono',monospace;font-size:9px;letter-spacing:2px;color:var(--accent-blue);border-left:1px solid var(--border);">R</th>
                <th style="text-align:center;padding:7px 10px;font-family:'IBM Plex Mono',monospace;font-size:9px;letter-spacing:2px;color:var(--text-dim);">H</th>
                <th style="text-align:center;padding:7px 10px;font-family:'IBM Plex Mono',monospace;font-size:9px;letter-spacing:2px;color:var(--text-dim);">E</th>
              </tr>
            </thead>
            <tbody>
              <tr style="border-bottom:1px solid var(--border);">
                <td style="padding:7px 10px;font-family:'Bebas Neue',sans-serif;font-size:15px;letter-spacing:1px;">${game.away.team}</td>
                ${awayInningCells}
                <td style="text-align:center;font-family:'IBM Plex Mono',monospace;font-size:14px;font-weight:600;color:var(--accent-blue);border-left:1px solid var(--border);">${awayRuns}</td>
                <td style="text-align:center;font-family:'IBM Plex Mono',monospace;font-size:12px;color:var(--text-mid);">${awayHits}</td>
                <td style="text-align:center;font-family:'IBM Plex Mono',monospace;font-size:12px;color:var(--text-mid);">${awayErrors}</td>
              </tr>
              <tr>
                <td style="padding:7px 10px;font-family:'Bebas Neue',sans-serif;font-size:15px;letter-spacing:1px;">${game.home.team}</td>
                ${homeInningCells}
                <td style="text-align:center;font-family:'IBM Plex Mono',monospace;font-size:14px;font-weight:600;color:var(--accent-blue);border-left:1px solid var(--border);">${homeRuns}</td>
                <td style="text-align:center;font-family:'IBM Plex Mono',monospace;font-size:12px;color:var(--text-mid);">${homeHits}</td>
                <td style="text-align:center;font-family:'IBM Plex Mono',monospace;font-size:12px;color:var(--text-mid);">${homeErrors}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>`;
  }

  // ── PITCHERS ──
  function pitcherStatCard(side, stats, recent) {
    const p = game[side];
    const hand = handednessCache[p.pitcherId];
    if (!p.pitcherName) return `<div class="pitcher-exp-card"><div class="pitcher-exp-name">TBD</div><div class="pitcher-exp-team">${side==='away'?'Away':'Home'} Starter</div></div>`;
    const statRow = stats ? `
      <div class="stat-pills">
        <div class="stat-pill"><span class="lbl">ERA</span>${stats.era||'—'}</div>
        <div class="stat-pill"><span class="lbl">WHIP</span>${stats.whip||'—'}</div>
        <div class="stat-pill"><span class="lbl">K</span>${stats.strikeOuts||0}</div>
        <div class="stat-pill"><span class="lbl">HR</span>${stats.homeRuns||0}</div>
        <div class="stat-pill"><span class="lbl">GS</span>${stats.gamesStarted||0}</div>
        <div class="stat-pill"><span class="lbl">IP</span>${stats.inningsPitched||'—'}</div>
      </div>` : `<div style="font-family:'IBM Plex Mono',monospace;font-size:10px;color:var(--text-dim);">No season stats yet</div>`;
    const recentRow = recent?.length ? `
      <div class="recent-starts">
        <div class="recent-label">Last ${recent.length} Starts</div>
        ${recent.map(r=>`<div class="recent-start-row">${r.date} vs ${r.opponent} — ${r.ip} IP · ${r.er} ER · ${r.k} K · ${r.hr} HR</div>`).join('')}
      </div>` : '';
    return `<div class="pitcher-exp-card">
      <div class="pitcher-exp-name" onclick="openPlayerModal(${p.pitcherId},'${(p.pitcherName||'').replace(/'/g,"\\'")}','${p.team}')" style="cursor:pointer;text-decoration:underline dotted;text-underline-offset:3px;">${hand?handBadge(hand):''} ${p.pitcherName}</div>
      <div class="pitcher-exp-team">${p.team} · ${side==='away'?'Away':'Home'} Starter</div>
      ${statRow}
      ${recentRow}
    </div>`;
  }

  const pitchersHTML = `
    <div class="modal-section">
      <div class="modal-section-title">⚾ Starting Pitchers</div>
      <div class="pitcher-cards">
        ${pitcherStatCard('away', awayPitcherStats, awayRecentStarts)}
        ${pitcherStatCard('home', homePitcherStats, homeRecentStarts)}
      </div>
    </div>`;

  // ── LINEUPS with toggle ──
  // Store data globally so toggle function can access it
  window._modalData = { game, awayLineup, homeLineup, awayPlayers, homePlayers, playerSeasonStats, hitterIds, hitterMap, boxData };

  function buildToggleLineup(lineup, players, side) {
    if (!lineup?.length) return `<div class="no-lineup">Lineup not yet posted</div>`;
    const teamData = side==='away' ? boxData?.teams?.away : boxData?.teams?.home;
    const gamePlayers = teamData?.players || {};
    return `<table class="lineup-table">
      <thead>
        <tr>
          <th>PLAYER</th>
          <th class="today-col">AB</th>
          <th class="today-col">H</th>
          <th class="today-col">HR</th>
          <th class="season-col">AVG</th>
          <th class="season-col">HR</th>
        </tr>
      </thead>
      <tbody>
        ${lineup.map((id,i)=>{
          const pid=`ID${id}`;
          const p=players[pid]||gamePlayers[pid];
          const name=p?.person?.fullName||`Player ${id}`;
          const isTop25=hitterIds.has(id), hitter=hitterMap[id];
          const batHand=batHandCache[id];
          const season=playerSeasonStats[id];
          const gp=gamePlayers[pid]?.stats?.batting;
          const todayAB=gp?.atBats??'—', todayH=gp?.hits??'—', todayHR=gp?.homeRuns??'—';
          return `<tr>
            <td>
              <div class="player-cell">
                <span class="player-num">${i+1}</span>
                ${batHand?handBadge(batHand):''}
                <span class="player-name-cell" onclick="openPlayerModal(${id},'${name.replace(/'/g,"\\'")}','${side==='away'?game.away.team:game.home.team}')" style="cursor:pointer;text-decoration:underline dotted;text-underline-offset:2px;">${name}${isTop25?` <span class="top25-badge">#${hitter?.rank}</span>`:''}</span>
              </div>
            </td>
            <td class="today-val">${todayAB}</td>
            <td class="today-val">${todayH}</td>
            <td class="today-val">${todayHR}</td>
            <td class="season-val">${season?.avg||'—'}</td>
            <td class="season-val">${season?.hr??'—'}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>`;
  }

  window.switchLineupTeam = function(side) {
    const d = window._modalData;
    if (!d) return;
    document.querySelectorAll('.team-toggle-btn').forEach(b=>b.classList.remove('active'));
    document.querySelector(`.team-toggle-btn[data-side="${side}"]`).classList.add('active');
    const lineup = side==='away' ? d.awayLineup : d.homeLineup;
    const players = side==='away' ? d.awayPlayers : d.homePlayers;
    document.getElementById('desktopLineupContent').innerHTML = buildToggleLineup(lineup, players, side);
  };

  const lineupsHTML = `
    <div class="modal-section">
      <div class="modal-section-title">📋 Lineup — 🟢 Today · 🔵 Season</div>
      <div class="team-toggle">
        <button class="team-toggle-btn active" data-side="away" onclick="switchLineupTeam('away')">${game.away.team}</button>
        <button class="team-toggle-btn" data-side="home" onclick="switchLineupTeam('home')">${game.home.team}</button>
      </div>
      <div id="desktopLineupContent">${buildToggleLineup(awayLineup, awayPlayers, 'away')}</div>
    </div>`;

  // ── FULL H2H ──
  const allH2HRows = [];

  if (game.home.pitcherId && game.home.pitcherName) {
    const awayTop25 = (awayLineup||[]).filter(id=>hitterIds.has(id));
    for (const bid of awayTop25) {
      const key = `${bid}-${game.home.pitcherId}`;
      const stat = h2hMap[key];
      const hitter = hitterMap[bid];
      const batHand = batHandCache[bid];
      const pitchHand = handednessCache[game.home.pitcherId];
      const isHot = stat && stat.hr > 0;
      allH2HRows.push(`<div class="h2h-full-row">
        <div class="h2h-full-names">
          ${batHand?handBadge(batHand):''} <strong onclick="openPlayerModal(${bid},'${(hitter?.name||'').replace(/'/g,"\\'")}','${game.away.team}')" style="cursor:pointer;text-decoration:underline dotted;text-underline-offset:2px;">${hitter?.name}</strong>
          <span>vs ${pitchHand?handBadge(pitchHand):''} <strong onclick="openPlayerModal(${game.home.pitcherId},'${(game.home.pitcherName||'').replace(/'/g,"\\'")}','${game.home.team}')" style="cursor:pointer;text-decoration:underline dotted;text-underline-offset:2px;">${game.home.pitcherName}</strong></span>
        </div>
        <div class="h2h-full-stats">
          ${stat ? `
            <span class="h2h-stat-pill ${isHot?'hot':''}">${stat.ab} AB</span>
            <span class="h2h-stat-pill ${isHot?'hot':''}">${stat.hr} HR</span>
            <span class="h2h-stat-pill ${isHot?'hot':''}">${stat.avg>0?stat.avg.toFixed(3).replace('0.','.'):'.000'} BA</span>
          ` : `<span class="h2h-stat-pill">No data</span>`}
        </div>
      </div>`);
    }
  }

  if (game.away.pitcherId && game.away.pitcherName) {
    const homeTop25 = (homeLineup||[]).filter(id=>hitterIds.has(id));
    for (const bid of homeTop25) {
      const key = `${bid}-${game.away.pitcherId}`;
      const stat = h2hMap[key];
      const hitter = hitterMap[bid];
      const batHand = batHandCache[bid];
      const pitchHand = handednessCache[game.away.pitcherId];
      const isHot = stat && stat.hr > 0;
      allH2HRows.push(`<div class="h2h-full-row">
        <div class="h2h-full-names">
          ${batHand?handBadge(batHand):''} <strong onclick="openPlayerModal(${bid},'${(hitter?.name||'').replace(/'/g,"\\'")}','${game.home.team}')" style="cursor:pointer;text-decoration:underline dotted;text-underline-offset:2px;">${hitter?.name}</strong>
          <span>vs ${pitchHand?handBadge(pitchHand):''} <strong onclick="openPlayerModal(${game.away.pitcherId},'${(game.away.pitcherName||'').replace(/'/g,"\\'")}','${game.away.team}')" style="cursor:pointer;text-decoration:underline dotted;text-underline-offset:2px;">${game.away.pitcherName}</strong></span>
        </div>
        <div class="h2h-full-stats">
          ${stat ? `
            <span class="h2h-stat-pill ${isHot?'hot':''}">${stat.ab} AB</span>
            <span class="h2h-stat-pill ${isHot?'hot':''}">${stat.hr} HR</span>
            <span class="h2h-stat-pill ${isHot?'hot':''}">${stat.avg>0?stat.avg.toFixed(3).replace('0.','.'):'.000'} BA</span>
          ` : `<span class="h2h-stat-pill">No data</span>`}
        </div>
      </div>`);
    }
  }

  const h2hHTML = allH2HRows.length ? `
    <div class="modal-section">
      <div class="modal-section-title">⚔ Head-to-Head — Top 25 HR Hitters vs Today's Starters</div>
      ${allH2HRows.join('')}
    </div>` : '';

  document.getElementById('modalBody').innerHTML = weatherHTML + boxScoreHTML + pitchersHTML + lineupsHTML;
}

// Close modal on Escape key
document.addEventListener('keydown', e=>{ if(e.key==='Escape') closeModalDirect(); });

setInterval(async () => {
  if (!todayGames.length) return;
  const hasLive = todayGames.some(g => g.isLive);
  if (!hasLive) return;
  try {
    const d = await fetchJSON(`${BASE}/schedule?sportId=1&date=${todayStr()}&hydrate=linescore,team`);
    const games = ((d.dates||[])[0]?.games||[]);
    for (const g of games) {
      const match = todayGames.find(tg=>tg.gamePk===g.gamePk);
      if (!match) continue;
      const ls            = g.linescore||{};
      const statusCode    = g.status?.statusCode||'';
      const detailedState = g.status?.detailedState||'';
      const abstractState = g.status?.abstractGameState||'';
      match.isLive        = ['I','MA','MC'].includes(statusCode)||detailedState==='In Progress';
      match.isFinal       = ['F','FT','FR','O','UR','CR'].includes(statusCode)
                            || detailedState.startsWith('Final')
                            || abstractState === 'Final';
      match.inningHalf    = ls.inningHalf||'';
      match.inningOrd     = ls.currentInningOrdinal||'';
      match.awayRuns      = ls.teams?.away?.runs??g.teams?.away?.score??match.awayRuns;
      match.homeRuns      = ls.teams?.home?.runs??g.teams?.home?.score??match.homeRuns;
    }

    // Re-render score sections
    const cards = document.querySelectorAll('.game-card');
    cards.forEach((card, i) => {
      const game = todayGames[i];
      if (!game) return;
      const existing = card.querySelector('.live-score');
      if (existing) existing.outerHTML = liveScoreHTML(game);
    });

    // Re-analyze and re-render alerts so live/final games drop off automatically
    const freshAlerts = analyzeMatchups();
    const freshNoHRAlerts = analyzeNoHRMatchups();
    renderAlerts(freshAlerts);
    renderNoHRAlerts(freshNoHRAlerts);

    // Refresh ticker with latest HR data (non-blocking)
    try {
      for (const g of todayGames) { if (g.isLive || g.isFinal) g._tickerData = null; }
      await fetchTickerHRData();
      renderHRTicker();
      updateSidebarHRFeed();
    } catch(e) { console.warn('Ticker refresh failed', e); }

  } catch(e) { console.warn('Score refresh failed', e); }
}, 60000);

// Auto-refresh full dashboard every 4 hours
// ── THEME TOGGLE ─────────────────────────────────────────────────────
function toggleTheme() {
  const isLight = document.body.classList.toggle('light-mode');
  document.getElementById('themeToggle').textContent = isLight ? '☀️' : '🌙';
  try { localStorage.setItem('hrintel-theme', isLight ? 'light' : 'dark'); } catch(e) {}
}
// Apply saved theme on load
(function() {
  try {
    const saved = localStorage.getItem('hrintel-theme');
    if (saved === 'light') {
      document.body.classList.add('light-mode');
      // Toggle button text set after DOM ready
      document.addEventListener('DOMContentLoaded', () => {
        const btn = document.getElementById('themeToggle');
        if (btn) btn.textContent = '☀️';
      });
    }
  } catch(e) {}
})();

// ── PLAYER GAME LOG ───────────────────────────────────────────────────
const GAMELOG_THRESHOLDS = {
  avg: { label:'BATTING AVG', fmt: v => v.toFixed(3).replace('0.','.'), color:'#7799cc', threshold:0.300, threshLabel:'.300' },
  h:   { label:'HITS',        fmt: v => v,                              color:'#4cc9f0', threshold:3,     threshLabel:'3'    },
  hr:  { label:'HOME RUNS',   fmt: v => v,                              color:'#ffd60a', threshold:1,     threshLabel:'1'    },
  rbi: { label:'RBI',         fmt: v => v,                              color:'#4ade80', threshold:2,     threshLabel:'2'    },
  k:   { label:'STRIKEOUTS',  fmt: v => v,                              color:'#e63946', threshold:2,     threshLabel:'2'    },
  sb:  { label:'STOLEN BASES',fmt: v => v,                              color:'#a78bfa', threshold:1,     threshLabel:'1'    },
};

function setGamelogView(v, btn) {
  window._gamelogView = v;
  document.querySelectorAll('.gamelog-view-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');

  const modal      = document.getElementById('playerModal');
  const rightPanel = document.getElementById('playerModalRight');
  const showRight  = v !== 'season';

  if (showRight) {
    modal.classList.add('split-mode');
    modal.style.removeProperty('max-width');
    rightPanel.style.display = '';
    renderGamelog();
  } else {
    modal.classList.remove('split-mode');
    modal.style.removeProperty('max-width');
    rightPanel.style.display = 'none';
  }
}

function setGamelogStat(s, btn) {
  window._gamelogStat = s;
  document.querySelectorAll('.gamelog-stat-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  renderGamelog();
}

function renderGamelog() {
  const allData = (window._gamelogData || []).map(s => ({
    date: (() => {
      const dateStr = s.date || s.game?.gameDate || '';
      if (!dateStr) return '—';
      // Handle both YYYY-MM-DD and full ISO strings
      const d = new Date(dateStr.length === 10 ? dateStr + 'T12:00:00' : dateStr);
      return isNaN(d) ? dateStr.slice(0,10) : d.toLocaleDateString('en-US',{month:'short',day:'numeric'});
    })(),
    opp:  s.opponent?.abbreviation || s.opponent?.name?.slice(0,3).toUpperCase() || '?',
    ab:   s.stat?.atBats ?? 0,
    h:    s.stat?.hits ?? 0,
    hr:   s.stat?.homeRuns ?? 0,
    rbi:  s.stat?.rbi ?? 0,
    k:    s.stat?.strikeOuts ?? 0,
    sb:   s.stat?.stolenBases ?? 0,
    avg:  parseFloat(s.stat?.avg) || 0,
  })).filter(g => g.ab > 0 || g.date !== '—'); // filter out non-game rows

  const data = window._gamelogView === 'last5' ? allData.slice(-5) : allData.slice(-10);
  const stat = window._gamelogStat || 'avg';
  const cfg  = GAMELOG_THRESHOLDS[stat];
  const tc   = window._gamelogTc || 'var(--accent-blue)';

  if (!data.length) {
    document.getElementById('gamelogBarChart').innerHTML = '';
    document.getElementById('gamelogTableWrap').innerHTML = `<div style="font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--text-dim);text-align:center;padding:16px 0;">No game log data available yet</div>`;
    document.getElementById('gamelogPropLegend').innerHTML = '';
    return;
  }

  // Update badge color to tc
  document.getElementById('gamelogAvgBadge').style.color = tc;
  document.getElementById('gamelogAvgBadge').style.borderColor = tc + '44';

  renderGamelogChart(data, cfg, tc);
  renderGamelogTable(data, tc);
}

function renderGamelogChart(data, cfg, tc) {
  const vals   = data.map(g => g[window._gamelogStat] ?? g.avg);
  const thresh = cfg.threshold;
  // Force clean max for AVG so Y-axis lands on .100 increments
  let max;
  if (cfg.threshold < 1) {
    const rawMax = Math.max(...vals, thresh * 1.2, 0.4);
    max = Math.ceil(rawMax * 10) / 10; // round up to nearest .100
  } else {
    max = Math.max(...vals, thresh * 1.2, 1);
    max = Math.ceil(max); // round up to nearest integer
  }
  const avg    = vals.reduce((a,b)=>a+b,0) / vals.length;
  const overCount  = vals.filter(v => v >= thresh).length;
  const underCount = vals.filter(v => v < thresh).length;

  const W=512, H=308, padL=32, padR=18, padTop=18, padBot=26;
  const chartW = W-padL-padR, chartH = H-padTop-padBot;
  const n = data.length, barW = Math.floor(chartW/n*0.55), gap = chartW/n;

  // Badge + label
  document.getElementById('gamelogAvgBadge').textContent = cfg.threshold < 1
    ? `AVG ${avg.toFixed(3).replace('0.','.')}`
    : `AVG ${avg.toFixed(1)}/G`;
  document.getElementById('gamelogChartLabel').textContent = `${cfg.label} — ${window._gamelogView==='last5'?'LAST 5':'LAST 10'} GAMES`;

  // Prop legend removed

  // Y-axis labels
  const ySteps = 5;
  const grid = Array.from({length: ySteps + 1}, (_, i) => {
    const pct = i / ySteps;
    const y = padTop + chartH * (1 - pct);
    const val = max * pct;
    let label;
    if (cfg.threshold < 1) {
      // AVG — round to nearest .050 and display as .000
      const rounded = Math.round(val * 20) / 20; // nearest .050
      const cents = Math.round(rounded * 1000);
      label = '.' + String(cents).padStart(3, '0');
    } else {
      label = Math.round(val);
    }
    return `
      <line stroke="rgba(255,255,255,0.04)" stroke-width="1" x1="${padL}" y1="${y}" x2="${W-padR}" y2="${y}"/>
      <text x="${padL - 4}" y="${y + 4}" font-family="IBM Plex Mono" font-size="8" fill="#6b7280" text-anchor="end">${label}</text>
    `;
  }).join('');

  // Threshold line removed — prop line shown in legend only

  // Bars
  const bars = data.map((g, i) => {
    const v    = g[window._gamelogStat] ?? g.avg;
    const pct  = max > 0 ? v/max : 0;
    const bH   = Math.max(pct*chartH, v > 0 ? 3 : 0);
    const x    = padL + gap*i + gap/2 - barW/2;
    const y    = padTop + chartH - bH;
    const over = v >= thresh;
    const bc   = over ? '#4ade8088' : (v===0 ? 'rgba(255,255,255,0.08)' : '#e6394688');
    const bs   = over ? '#4ade80'   : (v===0 ? 'rgba(255,255,255,0.15)' : '#e63946');
    return `
      <rect x="${x}" y="${y}" width="${barW}" height="${bH}" fill="${bc}" rx="2" stroke="${bs}" stroke-width="1" stroke-opacity="0.4"/>
      <text x="${x+barW/2}" y="${y-4}" font-family="IBM Plex Mono" font-size="9" font-weight="600" fill="${bs}" text-anchor="middle">${cfg.fmt(v)}</text>
      <text x="${x+barW/2}" y="${padTop+chartH+15}" font-family="IBM Plex Mono" font-size="9" fill="#f0f0f0" text-anchor="middle">${g.date}</text>
    `;
  }).join('');

  // Trend line for AVG
  let trend = '';
  if (window._gamelogStat === 'avg') {
    const pts = data.map((g,i) => `${padL+gap*i+gap/2},${padTop+chartH*(1-g.avg/max)}`).join(' ');
    trend = `<polyline points="${pts}" fill="none" stroke="${tc}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.5"/>`;
  }

  const svg = document.getElementById('gamelogBarChart');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.innerHTML = grid + bars + trend;
}

function renderGamelogTable(data, tc) {
  const THRESH = { avg:0.300, h:3, hr:1, rbi:2, k:2, sb:1 };
  const tot = data.reduce((a,g) => { a.ab+=g.ab;a.h+=g.h;a.hr+=g.hr;a.rbi+=g.rbi;a.k+=g.k;a.sb+=g.sb; return a; }, {ab:0,h:0,hr:0,rbi:0,k:0,sb:0});
  const avgCalc = tot.ab > 0 ? (tot.h/tot.ab).toFixed(3).replace('0.','.') : '.000';

  function cell(v, s) {
    const over = v >= THRESH[s];
    const st = v === 0 ? 'color:var(--text-dim);' : over ? 'color:#4ade80;font-weight:700;' : 'color:#e63946;font-weight:700;';
    return `<td style="${st}">${s==='avg'?v.toFixed(3).replace('0.','.'):v}</td>`;
  }

  const rows = data.map(g => `<tr>
    <td style="color:#f0f0f0;">${g.date} <span style="color:var(--text-mid);font-size:9px;">vs ${g.opp}</span></td>
    <td style="color:var(--text-mid);">${g.ab}</td>
    ${cell(g.h,'h')}${cell(g.hr,'hr')}${cell(g.rbi,'rbi')}${cell(g.k,'k')}${cell(g.sb,'sb')}${cell(g.avg,'avg')}
  </tr>`).join('');

  document.getElementById('gamelogTableWrap').innerHTML = `
    <table class="gamelog-table">
      <thead><tr>
        <th>DATE</th><th>AB</th>
        <th>H <span style="color:#f59e0b;font-size:8px;">(3)</span></th>
        <th>HR <span style="color:#f59e0b;font-size:8px;">(1)</span></th>
        <th>RBI <span style="color:#f59e0b;font-size:8px;">(2)</span></th>
        <th>K <span style="color:#f59e0b;font-size:8px;">(2)</span></th>
        <th>SB <span style="color:#f59e0b;font-size:8px;">(1)</span></th>
        <th>AVG <span style="color:#f59e0b;font-size:8px;">(.300)</span></th>
      </tr></thead>
      <tbody>
        ${rows}
        <tr class="gamelog-totals">
          <td style="color:var(--text-mid);font-size:10px;font-weight:600;">${data.length}G TOTALS</td>
          <td style="color:var(--text-mid);">${tot.ab}</td>
          <td style="color:#4cc9f0;font-weight:700;">${tot.h}</td>
          <td style="color:#ffd60a;font-weight:700;">${tot.hr}</td>
          <td style="color:#4ade80;font-weight:700;">${tot.rbi}</td>
          <td style="color:#e63946;font-weight:700;">${tot.k}</td>
          <td style="color:#a78bfa;font-weight:700;">${tot.sb}</td>
          <td style="color:${tc};font-weight:700;">${avgCalc}</td>
        </tr>
      </tbody>
    </table>`;
}

// ── THREAT TRACKER ────────────────────────────────────────────────────────
const TRACKER_KEY = 'hrintel_threat_tracker_v1';
let trackerCurrentDate = null;

// ── Storage helpers ──
function trackerLoad() {
  try { return JSON.parse(localStorage.getItem(TRACKER_KEY) || '{}'); } catch { return {}; }
}
function trackerSave(data) {
  try { localStorage.setItem(TRACKER_KEY, JSON.stringify(data)); } catch(e) { console.warn('Tracker save failed', e); }
}
function trackerDateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,'0');
  const day = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}

// ── Capture today's threats ──
function trackerCaptureToday(alerts) {
  if (!alerts || !alerts.length) return;
  const data = trackerLoad();
  const key  = trackerDateKey(new Date());
  const existing = data[key];

  // Deduplicate alerts by hitterId + gamePk + type
  const uniqueAlerts = [];
  const seenKeys = new Set();
  for (const a of alerts) {
    const uKey = `${a.hitter?.id||'?'}-${a.game?.gamePk||'?'}-${a.type}`;
    if (seenKeys.has(uKey)) continue;
    seenKeys.add(uKey);
    uniqueAlerts.push(a);
  }

  // Re-capture if: no entry, more unique alerts, OR existing data missing venueHR field
  const needsUpdate = !existing ||
    existing.threats?.length < uniqueAlerts.length ||
    existing.threats?.some(t => t.venueHR === undefined);

  if (!needsUpdate) return;

  data[key] = {
    date: key,
    captured: Date.now(),
    threats: uniqueAlerts.map(a => {
      const prev = existing?.threats?.find(t =>
        t.hitterId === (a.hitter?.id || null) &&
        t.gamePk   === (a.game?.gamePk || null) &&
        t.type     === a.type
      );
      return {
        type:        a.type,
        hitterName:  a.hitter?.name || '—',
        hitterId:    a.hitter?.id   || null,
        hitterHR:    a.hitter?.hr   || 0,
        hitterRank:  a.hitter?.rank || '—',
        pitcherName: a.pitcher?.name || 'TBD',
        pitcherId:   a.pitcher?.id   || null,
        pitcherHR:   a.pitcher?.hr   || 0,
        pitcherRank: a.pitcher?.rank || '—',
        venue:       a.game?.venue      || '—',
        venueRank:   a.venueRank        || '—',
        venueHR:     a.venueData?.hr    || 0,
        gameInfo:    `${a.game?.away?.team||'?'} @ ${a.game?.home?.team||'?'}`,
        gameTime:    a.game?.time    || '—',
        gamePk:      a.game?.gamePk  || null,
        result:      prev?.result    || 'pending',
        hrCount:     prev?.hrCount   || 0,
      };
    })
  };
  trackerSave(data);
}

// ── Check results for a date ──
async function trackerCheckResults(dateKey) {
  const data = trackerLoad();
  if (!data[dateKey]) return;
  const day = data[dateKey];
  let changed = false;

  const pendingThreats = day.threats.filter(t => t.result === 'pending' && t.gamePk);
  if (!pendingThreats.length) return;

  const gamePks = [...new Set(pendingThreats.map(t => t.gamePk))];

  for (const gamePk of gamePks) {
    try {
      // Use game feed to get both status and boxscore data
      const feed = await fetchJSON(`${BASE}/game/${gamePk}/linescore`);
      const schedData = await fetchJSON(`${BASE}/schedule?sportId=1&gamePk=${gamePk}`);
      const gameStatus = schedData?.dates?.[0]?.games?.[0]?.status?.abstractGameState || '';
      if (gameStatus !== 'Final') continue;

      // Now get boxscore for HR data
      const box = await fetchJSON(`${BASE}/game/${gamePk}/boxscore`);

      // Collect all HR hitters
      const hrHitterIds = new Set();
      for (const side of ['away','home']) {
        const players = box.teams?.[side]?.players || {};
        for (const [,pd] of Object.entries(players)) {
          if ((pd.stats?.batting?.homeRuns || 0) > 0) {
            hrHitterIds.add(pd.person?.id);
          }
        }
      }

      // Update results
      for (const threat of day.threats) {
        if (threat.gamePk !== gamePk || threat.result !== 'pending') continue;
        if (threat.hitterId && hrHitterIds.has(threat.hitterId)) {
          for (const side of ['away','home']) {
            const players = box.teams?.[side]?.players || {};
            for (const [,pd] of Object.entries(players)) {
              if (pd.person?.id === threat.hitterId) {
                threat.hrCount = pd.stats?.batting?.homeRuns || 1;
              }
            }
          }
          threat.result = 'hit';
        } else {
          threat.result = 'miss';
        }
        changed = true;
      }
    } catch(e) { console.warn('Tracker check failed for gamePk', gamePk, e); }
  }

  if (changed) trackerSave(data);
}

// ── Calculate season stats ──
function trackerSeasonStats() {
  const data = trackerLoad();
  const stats = { triple: { hit:0, total:0 }, double: { hit:0, total:0 } };
  for (const [,day] of Object.entries(data)) {
    for (const t of day.threats || []) {
      if (t.result === 'pending') continue;
      const key = t.type === 'triple' ? 'triple' : 'double';
      stats[key].total++;
      if (t.result === 'hit') stats[key].hit++;
    }
  }
  return stats;
}

// ── Format pct ──
function trackerFmtPct(hit, total) {
  if (!total) return { str: '—', cls: '' };
  const pct = Math.round(hit / total * 100);
  const cls = pct >= 60 ? 'hot' : pct >= 40 ? 'warm' : 'cold';
  return { str: `${pct}%`, cls };
}

// ── Update season summary UI ──
function trackerUpdateSeasonSummary() {
  const s = trackerSeasonStats();
  const triPct = trackerFmtPct(s.triple.hit, s.triple.total);
  const dblPct = trackerFmtPct(s.double.hit, s.double.total);
  const combHit = s.triple.hit + s.double.hit;
  const combTotal = s.triple.total + s.double.total;
  const combPct = trackerFmtPct(combHit, combTotal);

  document.getElementById('tsTripleRecord').textContent  = s.triple.total  ? `${s.triple.hit}/${s.triple.total}`   : '—';
  document.getElementById('tsDoubleRecord').textContent  = s.double.total  ? `${s.double.hit}/${s.double.total}`   : '—';
  document.getElementById('tsCombinedRecord').textContent = combTotal ? `${combHit}/${combTotal}` : '—';

  const triEl = document.getElementById('tsTriplePct');
  triEl.textContent = triPct.str; triEl.className = `ts-pct ${triPct.cls}`;
  const dblEl = document.getElementById('tsDoublePct');
  dblEl.textContent = dblPct.str; dblEl.className = `ts-pct ${dblPct.cls}`;
  const combEl = document.getElementById('tsCombinedPct');
  combEl.textContent = combPct.str; combEl.className = `ts-pct ${combPct.cls}`;
}

// ── Render tracker body for a date ──
function trackerRenderDate(dateKey) {
  const data  = trackerLoad();
  const day   = data[dateKey];
  const body  = document.getElementById('trackerBody');

  // Update nav buttons
  const dates = Object.keys(data).sort();
  const idx   = dates.indexOf(dateKey);
  document.getElementById('trackerPrevBtn').disabled = idx <= 0;
  document.getElementById('trackerNextBtn').disabled = idx >= dates.length - 1 || dateKey === trackerDateKey(new Date());

  // Format date label
  const d = new Date(dateKey + 'T12:00:00');
  const todayKey = trackerDateKey(new Date());
  const label = dateKey === todayKey ? `TODAY — ${d.toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'})}` : d.toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric'});
  document.getElementById('trackerDateLabel').textContent = label;

  if (!day || !day.threats?.length) {
    body.innerHTML = `<div class="tracker-empty">No threats were recorded for this date.<br><span style="font-size:10px;opacity:0.6;">Threats are captured automatically when the dashboard loads each day.</span></div>`;
    return;
  }

  // Sort: triple first, then double
  const threats = [...day.threats].sort((a,b) => (a.type==='triple'?0:1) - (b.type==='triple'?0:1));

  // Count results
  const hits    = threats.filter(t => t.result === 'hit').length;
  const misses  = threats.filter(t => t.result === 'miss').length;
  const pending = threats.filter(t => t.result === 'pending').length;
  const triHits = threats.filter(t => t.type==='triple' && t.result==='hit').length;
  const triTotal = threats.filter(t => t.type==='triple' && t.result!=='pending').length;
  const dblHits = threats.filter(t => t.type==='double' && t.result==='hit').length;
  const dblTotal = threats.filter(t => t.type==='double' && t.result!=='pending').length;

  const cards = threats.map(t => {
    const isTriple = t.type === 'triple';
    const badgeClass = isTriple ? 'triple' : 'double';
    const badgeLabel = isTriple ? '⚡ TRIPLE THREAT' : '🔶 DOUBLE THREAT';
    const badgeColor = isTriple ? 'var(--accent-gold)' : 'var(--accent-orange)';

    let resultClass = 'pending';
    let resultContent = '<div class="tracker-result-box">□</div>';
    if (t.result === 'hit') {
      resultClass = 'hit';
      resultContent = `<div class="tracker-result-box">✓</div>${t.hrCount > 1 ? `<div style="font-family:'IBM Plex Mono',monospace;font-size:9px;color:#4ade80;margin-top:3px;text-align:center;">${t.hrCount} HR</div>` : ''}`;
    } else if (t.result === 'miss') {
      resultClass = 'miss';
      resultContent = '<div class="tracker-result-box">✗</div>';
    }

    return `<div class="tracker-card ${badgeClass}">
      <div class="tracker-card-body">
        <div class="tracker-card-game">
          <span style="font-family:'Barlow Condensed',sans-serif;font-size:12px;font-weight:700;letter-spacing:1px;color:${badgeColor};">${badgeLabel}</span>
          &nbsp;·&nbsp;${t.gameInfo} · ${t.gameTime}
        </div>
        <div class="tracker-card-matchup">
          <span class="tracker-card-hitter">${t.hitterName}</span>
          <span class="tracker-card-vs">vs</span>
          <span class="tracker-card-pitcher">${t.pitcherName}</span>
        </div>
        <div class="tracker-card-tags">
          ${t.hitterRank !== '—' ? `<span class="tag tag-hr">HR Rank #${t.hitterRank} · ${t.hitterHR} HR</span>` : ''}
          ${t.pitcherRank !== '—' ? `<span class="tag tag-pitcher">Pitcher #${t.pitcherRank} · ${t.pitcherHR} HR allowed</span>` : ''}
          ${t.venueRank !== '—' ? `<span class="tag tag-venue">📍 ${t.venue} · #${t.venueRank}${t.venueHR ? ` · ${t.venueHR} HRS` : ''}</span>` : `<span class="tag tag-venue">📍 ${t.venue}</span>`}
        </div>
      </div>
      <div class="tracker-result ${resultClass}">${resultContent}</div>
    </div>`;
  }).join('');

  // Daily summary
  const summary = `<div class="tracker-daily-summary">
    <span class="tracker-daily-label">📅 Daily Results</span>
    ${triTotal > 0 ? `<span class="tracker-daily-stat">⚡ Triple: <span class="hit-count">${triHits}</span>/<span>${triTotal}</span></span>` : ''}
    ${dblTotal > 0 ? `<span class="tracker-daily-stat">🔶 Double: <span class="hit-count">${dblHits}</span>/<span>${dblTotal}</span></span>` : ''}
    ${pending > 0  ? `<span class="tracker-daily-stat">⏳ <span class="pending-count">${pending} pending</span></span>` : ''}
    ${(hits + misses) > 0 ? `<span class="tracker-daily-stat">🎯 Combined: <span class="hit-count">${hits}</span>/<span class="miss-count">${hits+misses}</span></span>` : ''}
  </div>`;

  body.innerHTML = cards + summary;
}

// ── Nav ──
function trackerNavDate(dir) {
  const data  = trackerLoad();
  const dates = Object.keys(data).sort();
  if (!dates.length) return;
  const idx = dates.indexOf(trackerCurrentDate);
  const newIdx = idx + dir;
  if (newIdx < 0 || newIdx >= dates.length) return;
  trackerCurrentDate = dates[newIdx];
  trackerRenderDate(trackerCurrentDate);
}

function trackerGoToday() {
  trackerCurrentDate = trackerDateKey(new Date());
  trackerRenderDate(trackerCurrentDate);
}

// ── Open / Close ──
async function openTrackerModal() {
  document.getElementById('trackerModalOverlay').classList.add('open');

  // Check results for ALL dates that have pending threats
  const data = trackerLoad();
  const pendingDates = Object.keys(data).filter(dateKey => {
    return data[dateKey]?.threats?.some(t => t.result === 'pending');
  });

  // Check each pending date (most recent first)
  for (const dateKey of pendingDates.sort().reverse()) {
    await trackerCheckResults(dateKey);
  }

  trackerUpdateSeasonSummary();

  // Navigate to most recent date with data
  const allDates = Object.keys(trackerLoad()).sort();
  trackerCurrentDate = allDates.length ? allDates[allDates.length - 1] : trackerDateKey(new Date());
  trackerRenderDate(trackerCurrentDate);
}

function closeTrackerModal(e) {
  if (e && e.target !== document.getElementById('trackerModalOverlay')) return;
  document.getElementById('trackerModalOverlay').classList.remove('open');
}

// ── MATCHUPS & H2H ───────────────────────────────────────────────────────
let _matchupsData   = []; // cached full matchup list
let _matchupsMinAB  = 5;
const H2H_CACHE_KEY = `hrintel_h2h_cache_v2_${SEASON}`; // versioned by season — auto-clears each year
let _h2hCache = (() => { try { return JSON.parse(localStorage.getItem(H2H_CACHE_KEY)||'{}'); } catch { return {}; } })();

function h2hCacheSave() {
  try { localStorage.setItem(H2H_CACHE_KEY, JSON.stringify(_h2hCache)); } catch(e) {}
}

// Fetch H2H stats for a single batter vs pitcher
async function fetchH2H(batterId, pitcherId) {
  const key = `${batterId}-${pitcherId}`;
  if (_h2hCache[key] !== undefined && _h2hCache[key] !== null) return _h2hCache[key];
  try {
    const url = `${BASE}/people/${batterId}/stats?stats=vsPlayer&group=hitting&opposingPlayerId=${pitcherId}&sportId=1`;
    const d = await fetchJSON(url);
    const splits = d?.stats?.[0]?.splits || [];
    if (!splits.length) { return null; } // no career H2H data — don't cache
    const s = splits[0].stat;
    const result = {
      ab:  s.atBats        ?? 0,
      h:   s.hits          ?? 0,
      hr:  s.homeRuns      ?? 0,
      rbi: s.rbi           ?? 0,
      bb:  s.baseOnBalls   ?? 0,
      k:   s.strikeOuts    ?? 0,
      avg: parseFloat(s.avg) || 0,
      ops: parseFloat(s.ops) || 0,
    };
    _h2hCache[key] = result;
    h2hCacheSave();
    return result;
  } catch { return null; } // don't cache errors
}

// Build matchup list using full rosters — matches Rotowire's approach
async function buildMatchupsList() {
  const matchups = [];
  const seen = new Set();

  // Build opposing pitcher map for each team playing today
  const teamOpposingPitcher = {};
  for (const game of todayGames) {
    if (game.home?.pitcherId) {
      teamOpposingPitcher[game.away.team] = {
        id: game.home.pitcherId,
        name: game.home.pitcherName || 'TBD',
        gameInfo: `${game.away.team} @ ${game.home.team}`,
        gameTime: game.time
      };
    }
    if (game.away?.pitcherId) {
      teamOpposingPitcher[game.home.team] = {
        id: game.away.pitcherId,
        name: game.away.pitcherName || 'TBD',
        gameInfo: `${game.away.team} @ ${game.home.team}`,
        gameTime: game.time
      };
    }
  }

  // Get all teams playing today
  const teamsPlayingToday = new Set([
    ...todayGames.map(g => g.away.team),
    ...todayGames.map(g => g.home.team)
  ]);

  // Fetch full roster for each team playing today
  window._teamRosters = {}; // expose globally for Claude's pick formula
  const teamRosters = window._teamRosters;
  await Promise.all([...teamsPlayingToday].map(async teamAbbr => {
    const opp = teamOpposingPitcher[teamAbbr];
    if (!opp?.id) return; // no confirmed pitcher, skip

    // Find team ID
    const game = todayGames.find(g => g.away.team === teamAbbr || g.home.team === teamAbbr);
    const teamId = game?.away.team === teamAbbr ? game.away.id : game?.home.id;
    if (!teamId) return;

    try {
      const d = await fetchJSON(`${BASE}/teams/${teamId}/roster?rosterType=active&season=${SEASON}`);
      teamRosters[teamAbbr] = (d.roster || [])
        .filter(p => p.person?.id && p.person?.fullName)
        .filter(p => p.position?.type !== 'Pitcher') // exclude pitchers
        .map(p => ({ id: p.person.id, name: p.person.fullName }));
    } catch {
      // Fallback to boxscore players
      teamRosters[teamAbbr] = [];
    }
  }));

  // Now check every roster player against opposing pitcher
  const h2hPromises = [];
  for (const [teamAbbr, roster] of Object.entries(teamRosters)) {
    const opp = teamOpposingPitcher[teamAbbr];
    if (!opp?.id || !roster.length) continue;

    for (const batter of roster) {
      const key = `${batter.id}-${opp.id}`;
      if (seen.has(key)) continue;
      seen.add(key);

      h2hPromises.push(
        fetchH2H(batter.id, opp.id).then(h2h => {
          if (h2h && h2h.ab >= 3) {
            matchups.push({
              ...h2h,
              hitterId: batter.id,
              hitterName: batter.name,
              hitterTeam: teamAbbr,
              pitcherId: opp.id,
              pitcherName: opp.name,
              gameInfo: opp.gameInfo,
              gameTime: opp.gameTime
            });
          }
        }).catch(() => {})
      );
    }
  }

  // Run all H2H calls in parallel batches of 20
  const batchSize = 20;
  for (let i = 0; i < h2hPromises.length; i += batchSize) {
    await Promise.all(h2hPromises.slice(i, i + batchSize));
  }

  return matchups;
}

// Also fetch H2H for threat alert hitters vs their pitchers
async function enrichAlertsWithH2H(alerts) {
  const toFetch = alerts.filter(a => a.hitter?.id && a.pitcher?.id && a.pitcher.name !== 'TBD');
  // Fetch all in parallel
  await Promise.all(toFetch.map(async a => {
    const h2h = await fetchH2H(a.hitter.id, a.pitcher.id);
    a.h2h = h2h;
  }));
  // Re-render alerts with H2H data if any was found
  const hasH2H = alerts.some(a => a.h2h);
  if (hasH2H) renderAlerts(alerts, true); // true = skip re-enrichment to avoid loop
}

// Format H2H strip for threat cards
function h2hStrip(h2h, pitcherName) {
  if (!h2h || h2h.ab < 3) return ''; // show H2H with 3+ AB
  const ops   = h2h.ops;
  const avgVal = h2h.avg;
  let cls = 'white';
  if (avgVal >= 0.350 || h2h.hr >= 2 || ops >= 0.900) cls = 'gold';
  else if (avgVal >= 0.300 || ops >= 0.800) cls = 'gold';
  else if (avgVal < 0.220 || ops < 0.700) cls = 'red';
  const avgStr = avgVal.toFixed(3).replace('0.','.');
  const opsStr = ops.toFixed(3).replace('0.','.');
  const label  = cls === 'gold' ? '🔥 H2H EDGE' : cls === 'red' ? '🧊 H2H COLD' : '⚔ H2H';
  return `<div class="alert-h2h">
    <span class="alert-h2h-label ${cls}">${label} vs ${pitcherName.split(' ').pop()}</span>
    <span class="alert-h2h-stat"><strong>${h2h.ab} AB</strong></span>
    <span class="alert-h2h-stat">· <strong>${h2h.h} H</strong></span>
    <span class="alert-h2h-stat">· <strong>${h2h.hr} HR</strong></span>
    <span class="alert-h2h-stat">· <strong>${h2h.rbi} RBI</strong></span>
    <span class="alert-h2h-stat">· <strong>${h2h.bb} BB</strong></span>
    <span class="alert-h2h-stat">· <strong>${h2h.k} K</strong></span>
    <span class="alert-h2h-stat">· AVG <strong>${avgStr}</strong></span>
    <span class="alert-h2h-stat">· OPS <strong>${opsStr}</strong></span>
  </div>`;
}

// Render matchup rows
function renderMatchupRow(m, type) {
  const ops    = m.ops || 0;
  const avgStr = (m.avg||0).toFixed(3).replace('0.','.');
  const opsStr = ops.toFixed(3).replace('0.','.');
  const opsCls = ops >= 0.900 ? 'hot' : ops >= 0.800 ? 'hot' : ops < 0.700 ? 'cold' : 'warm';
  const avgCls = m.avg >= 0.350 ? 'gold' : m.avg < 0.220 ? 'red' : '';
  return `<div class="matchup-row ${type}" onclick="openPlayerModal(${m.hitterId},'${(m.hitterName||'').replace(/'/g,"\\'")}','${m.hitterTeam}')">
    <div>
      <div class="matchup-game">${m.gameInfo} · ${m.gameTime}</div>
      <div class="matchup-names">
        <span class="matchup-hitter">${m.hitterName}</span>
        <span class="matchup-vs">vs</span>
        <span class="matchup-pitcher">${m.pitcherName}</span>
      </div>
      <div class="matchup-stats">
        <span class="matchup-stat">${m.ab} AB</span>
        <span class="matchup-stat">· <strong>${m.h} H</strong></span>
        <span class="matchup-stat">· <strong class="${m.hr>=2?'gold':''}">${m.hr} HR</strong></span>
        <span class="matchup-stat">· <strong>${m.rbi} RBI</strong></span>
        <span class="matchup-stat">· <strong>${m.bb} BB</strong></span>
        <span class="matchup-stat">· <strong>${m.k} K</strong></span>
        <span class="matchup-stat">· AVG <strong class="${avgCls}">${avgStr}</strong></span>
      </div>
    </div>
    <div class="matchup-ops ${opsCls}">${opsStr}</div>
  </div>`;
}

function renderMatchupsUI() {
  const filtered = _matchupsData.filter(m => m.ab >= _matchupsMinAB);
  // Match Rotowire OR logic: Hot = AVG > .400 OR OPS > .850 OR HR > 3
  // Cold = AVG < .200 OR OPS < .500 OR HR < 0.15 (essentially 0 HR in small sample)
  const hot  = filtered.filter(m => m.avg >= 0.400 || m.ops >= 0.850 || m.hr >= 3)
                        .sort((a,b) => b.ops - a.ops).slice(0,25);
  const cold = filtered.filter(m => m.avg < 0.200 || m.ops < 0.500)
                        .filter(m => !(m.avg >= 0.400 || m.ops >= 0.850 || m.hr >= 3)) // exclude hot
                        .sort((a,b) => a.ops - b.ops).slice(0,25);
  document.getElementById('hotMatchupsContainer').innerHTML  = hot.length  ? hot.map(m=>renderMatchupRow(m,'hot')).join('')  : '<div class="matchup-loading">No hot matchups found yet — check back once lineups are confirmed.</div>';
  document.getElementById('coldMatchupsContainer').innerHTML = cold.length ? cold.map(m=>renderMatchupRow(m,'cold')).join('') : '<div class="matchup-loading">No cold matchups found yet.</div>';
}

function setMatchupMinAB(n, btn) {
  _matchupsMinAB = n;
  document.querySelectorAll('.matchups-ab-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  renderMatchupsUI();
}

async function openMatchupsModal() {
  document.getElementById('matchupsModalOverlay').classList.add('open');
  // Always reset to batters tab
  switchMatchupsTab('batters', document.getElementById('matchupsBatterTab'));
  // Always rebuild batter data fresh
  _matchupsData = [];
  _pitcherMatchupsData = [];
  // Always clear pitcher cache to force fresh fetch
  try { localStorage.removeItem(PITCHER_H2H_KEY); } catch {}
  _pitcherH2HCache = {};
  // Also clear old batter cache to force fresh fetch
  try { localStorage.removeItem(H2H_CACHE_KEY); } catch {}
  _h2hCache = {};
  document.getElementById('hotMatchupsContainer').innerHTML  = '<div class="matchup-loading">Fetching H2H data — using full rosters vs today\'s confirmed starters...</div>';
  document.getElementById('coldMatchupsContainer').innerHTML = '<div class="matchup-loading">This may take 15-30 seconds...</div>';
  _matchupsData = await buildMatchupsList();
  renderMatchupsUI();
  // Rosters now populated — always regenerate Claude's picks with full pool
  const _cd = challengeLoad();
  const _todayKey = challengeDateKey(new Date());
  if (_cd[_todayKey]) {
    const _existing = _cd[_todayKey].claudePicks || [];
    // Regen if: flagged for regen, fewer than 3 picks, or no factors (old formula)
    const _needsRegen = _cd[_todayKey]._needsRosterRegen ||
                        _existing.length < 3 ||
                        (_existing.length > 0 && !_existing[0].factors);
    if (_needsRegen) {
      const _fresh = generateClaudePicks();
      if (_fresh.length > 0) {
        _cd[_todayKey].claudePicks = _fresh;
        delete _cd[_todayKey]._needsRosterRegen;
        challengeSave(_cd);
        // Re-render if challenge modal is open
        if (document.getElementById('challengeModalOverlay')?.classList.contains('open')) {
          renderChallengeToday();
        }
      }
    }
  }
}

function closeMatchupsModal(e) {
  if (e && e.target !== document.getElementById('matchupsModalOverlay')) return;
  document.getElementById('matchupsModalOverlay').classList.remove('open');
}

// ── AI CHALLENGE ─────────────────────────────────────────────────────
const CHALLENGE_KEY = 'hrintel_ai_challenge_v1';
const CHALLENGE_USER_NAME = 'Frank';
const CHALLENGE_CUTOFF_HOUR = 13; // 1pm — locks before most day games, gives time for lineups
let _challengePeriod = 'today';

// ── Storage ──
function challengeLoad() {
  try { return JSON.parse(localStorage.getItem(CHALLENGE_KEY) || '{}'); } catch { return {}; }
}
function challengeSave(data) {
  try { localStorage.setItem(CHALLENGE_KEY, JSON.stringify(data)); } catch {}
}
function challengeDateKey(d) {
  const y = d.getFullYear(), m = String(d.getMonth()+1).padStart(2,'0'), day = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}

// ── Check if picks are locked ──
// Cutoff temporarily disabled while testing — picks never lock
function challengePicksLocked() {
  return false; // TODO: re-enable after Claude pick generation is stable
}

// ── Generate Claude's picks — full lineup pool with all available signals ──
function generateClaudePicks() {
  // ── Claude's independent probability formula ─────────────────────────────
  // Claude scores every confirmed lineup player using raw signals.
  // Threat badges are ONE input — not the starting point.
  // The formula mirrors the HR Probability Score on game cards.
  //
  // MAX possible score: ~22 pts
  // Weights are calibrated so no single signal dominates.

  const alerts          = window._lastAlerts      || [];
  const matchups        = _matchupsData           || [];
  const pitcherMatchups = _pitcherMatchupsData    || [];

  // ── LOOKUP TABLES ─────────────────────────────────────────────────────────

  // Hitter season HR rank: id -> { rank, hr }
  const hitterStatMap = {};
  hitters.forEach((h, i) => { hitterStatMap[h.id] = { rank: i + 1, hr: h.hr }; });

  // HR-prone pitcher: pitcherId -> { rank, hr }
  const hrPitcherMap = {};
  hrPitchers.forEach((p, i) => { hrPitcherMap[p.id] = { rank: i + 1, hr: p.hr }; });

  // Venue HR rank: venueId -> { rank, hr, name }
  const venueRankMap = {};
  venues.forEach((v, i) => { venueRankMap[v.venueId] = { rank: i + 1, hr: v.hr, name: v.name }; });

  // Alert map: playerId -> alert (triple/double)
  const alertByPlayer = {};
  for (const a of alerts) {
    if (a.hitter?.id) alertByPlayer[`${a.hitter.id}_${a.game?.gamePk||''}`] = a;
  }

  // H2H map: hitterId -> best matchup data
  const h2hByPlayer = {};
  for (const m of matchups) {
    if (!h2hByPlayer[m.hitterId] || m.ops > h2hByPlayer[m.hitterId].ops) {
      h2hByPlayer[m.hitterId] = m;
    }
  }

  // Pitcher struggles vs team: pitcherName|pitcherId -> { ops, team }
  const pitcherStruggles = {};
  for (const pm of pitcherMatchups) {
    if (pm.ops >= 0.750) pitcherStruggles[pm.pitcherId || pm.pitcherName] = pm;
  }

  // ── SCORE EVERY LINEUP PLAYER ─────────────────────────────────────────────
  const pool = []; // { playerId, playerName, team, pitcher, pitcherId, gamePk, venueId, score, factors }

  // Cutoff timestamp — 1pm local time today
  const cutoffToday = new Date();
  cutoffToday.setHours(CHALLENGE_CUTOFF_HOUR, 0, 0, 0);

  for (const game of todayGames) {
    // Game time filter temporarily disabled while testing pick generation
    // TODO: re-enable cutoff filter once picks are stable

    const venueData = venueRankMap[game.venueId] || null;

    for (const side of ['away', 'home']) {
      const batting    = game[side];
      const fielding   = game[side === 'away' ? 'home' : 'away'];
      const pitcherId  = fielding.pitcherId;
      const pitcherName = fielding.pitcherName || 'TBD';
      const lineup     = batting.lineup || [];

      // Priority: confirmed lineup > full team roster > top-25 hitters on team
      // Full roster gives Claude the widest possible pool even before lineups post
      const fullRoster = (window._teamRosters || {})[batting.team] || [];
      const players = lineup.length > 0
        ? lineup.map(p => ({ id: p.id, name: p.name }))
        : fullRoster.length > 0
          ? fullRoster.map(p => ({ id: p.id, name: p.name }))
          : hitters.filter(h => h.team === batting.team).map(h => ({ id: h.id, name: h.name, fromTopList: true }));

      for (const player of players) {
        if (!player.id || !player.name) continue;

        let score   = 0;
        const factors = []; // { label, pts, detail }

        const add = (pts, label, detail = '') => {
          score += pts;
          factors.push({ label, pts, detail });
        };

        // ── Signal A (REMOVED): Threat System excluded intentionally ──
        // Claude does NOT use Threat badges — forces him to find value
        // outside the curated intel Frank sees, creating genuine competition.

        // ── Signal B (REMOVED): Season HR rank excluded intentionally ──
        // Removing HR rank prevents Claude from defaulting to the same
        // leaderboard players Frank sees in the Top 25 section.

        // ── C: Pitcher Vulnerability ──
        // How many HRs has today's pitcher surrendered this season?
        const pitcherStat = pitcherId ? hrPitcherMap[pitcherId] : null;
        if (pitcherStat) {
          if (pitcherStat.rank <= 5)       add(4, `🎯 Pitcher Leaks HRs (#${pitcherStat.rank})`, `${pitcherStat.hr} HR allowed this season`);
          else if (pitcherStat.rank <= 10) add(3, `🎯 Pitcher Vulnerable (#${pitcherStat.rank})`, `${pitcherStat.hr} HR allowed`);
          else if (pitcherStat.rank <= 25) add(2, `🎯 Pitcher HR Risk (#${pitcherStat.rank})`, `${pitcherStat.hr} HR allowed`);
        }

        // ── D: Venue Factor ──
        // Park plays a massive role in HR probability
        if (venueData) {
          if (venueData.rank <= 3)       add(3, `🏟️ Elite HR Park (#${venueData.rank})`, `${venueData.hr} HRs hit here this season`);
          else if (venueData.rank <= 8)  add(2, `🏟️ HR-Friendly Park (#${venueData.rank})`, `${venueData.hr} HRs this season`);
          else if (venueData.rank <= 15) add(1, `🏟️ Moderate HR Park (#${venueData.rank})`, `${venueData.hr} HRs this season`);
        }

        // ── E: Career H2H vs Today's Pitcher ──
        // Historical matchup data — most direct signal available
        const h2h = h2hByPlayer[player.id];
        if (h2h && h2h.ab >= 5) {
          if (h2h.hr >= 3)            add(4, '🔥 Owns This Pitcher', `${h2h.hr} HR in ${h2h.ab} AB career vs ${pitcherName}`);
          else if (h2h.ops >= 0.950)  add(3, '🔥 Elite H2H', `${h2h.avg?.toFixed(3)||'---'} AVG, ${h2h.ops?.toFixed(3)||'---'} OPS vs ${pitcherName}`);
          else if (h2h.ops >= 0.800)  add(2, '🔥 Hot H2H', `${h2h.avg?.toFixed(3)||'---'} AVG, ${h2h.ops?.toFixed(3)||'---'} OPS vs ${pitcherName}`);
          else if (h2h.ops >= 0.650)  add(1, '🔥 Decent H2H', `${h2h.ops?.toFixed(3)||'---'} OPS vs ${pitcherName}`);
        }

        // ── F: Pitcher Struggles vs This Team ──
        // Pitcher's OPS-against record specifically vs this batting team
        const strugKey = pitcherId || pitcherName;
        const strug = pitcherStruggles[strugKey];
        if (strug && strug.team === batting.team) {
          if (strug.ops >= 0.950)     add(3, '📉 Pitcher Struggles vs Team', `${strug.ops.toFixed(3)} OPS against ${batting.team}`);
          else if (strug.ops >= 0.800) add(2, '📉 Pitcher Soft vs Team', `${strug.ops.toFixed(3)} OPS against ${batting.team}`);
        }

        // ── G: Handedness Advantage ──
        // Opposite-hand matchups historically favor the hitter
        const batterHand  = batHandCache[player.id];
        const pitcherHand = pitcherId ? handednessCache[pitcherId] : null;
        if (batterHand && pitcherHand) {
          const platoon = (batterHand === 'R' && pitcherHand === 'L') ||
                          (batterHand === 'L' && pitcherHand === 'R');
          if (platoon) add(1, '✋ Platoon Advantage', `${batterHand} batter vs ${pitcherHand}HP`);
        }

        // Include any player with at least one positive signal
        if (score > 0) {
          pool.push({
            playerId:   player.id,
            playerName: player.name,
            team:       batting.team,
            pitcher:    pitcherName,
            pitcherId,
            gamePk:     game.gamePk,
            venueId:    game.venueId,
            venueName:  venueData?.name || game.venue,
            venueRank:  venueData?.rank || null,
            score,
            factors,
          });
        }
      }
    }
  }

  // ── SORT: Score desc, then genuine random within same-score tiers ──────────
  console.log(`[HR Intel] Claude pick pool: ${pool.length} players scored from ${todayGames.length} games, rosters: ${Object.keys(window._teamRosters||{}).length} teams`);
  pool.sort((a, b) => b.score !== a.score ? b.score - a.score : Math.random() - 0.5);

  // ── ENFORCE: Max 2 picks per team ────────────────────────────────────────
  const teamPickCount = {};
  const top3 = [];
  for (const p of pool) {
    if (top3.length >= 3) break;
    const teamCount = teamPickCount[p.team] || 0;
    if (teamCount >= 2) continue; // skip — already have 2 from this team
    teamPickCount[p.team] = teamCount + 1;
    top3.push(p);
  }

  return top3.map(e => {
    // Build a structured scouting summary for the reveal explanation
    const topFactors = e.factors.slice(0, 3).map(f => f.label).join(' · ');
    const scoutLines = e.factors.map(f => `${f.label}${f.detail ? ': ' + f.detail : ''}`);

    return {
      playerId:    e.playerId,
      playerName:  e.playerName,
      team:        e.team,
      pitcher:     e.pitcher,
      pitcherId:   e.pitcherId,
      gamePk:      e.gamePk,
      venueName:   e.venueName || '—',
      venueRank:   e.venueRank,
      score:       e.score,
      factors:     e.factors,       // full factor array for scouting report
      scoutLines,                   // pre-formatted for API prompt
      reason:      e.factors[0]?.label || '📊 Analysis',
      reasonType:  e.factors.some(f=>f.label.includes('Triple')) ? 'triple'
                 : e.factors.some(f=>f.label.includes('Double')) ? 'double' : 'hot',
      signals:     e.factors.map(f => f.label),
      result:      'pending',
      hrCount:     0,
      explanation: '', // filled in on reveal via API
    };
  });
}


// ── Save today's entry ──
function challengeInitToday() {
  const data  = challengeLoad();
  const today = challengeDateKey(new Date());

  if (data[today]) {
    const existing = data[today].claudePicks || [];

    // Case 1: Picks exist with new formula and we have 3 — nothing to do
    if (existing.length >= 3 && existing[0]?.factors) return;

    // Otherwise regen: old formula, empty, or fewer than 3 picks
    const hasData = todayGames.length > 0 && hitters.length > 0;
    if (!hasData) return; // data not loaded yet — try again next modal open
    // Wait for team rosters to be populated for a wider pool
    const hasRosters = Object.keys(window._teamRosters || {}).length > 0;
    const fresh = generateClaudePicks();
    if (fresh.length === 0) return; // pool still empty — try later
    // If we got picks but no rosters yet, mark as needing regen once rosters load
    if (!hasRosters) data[today]._needsRosterRegen = true;
    else delete data[today]._needsRosterRegen;
    data[today].claudePicks = fresh;
    challengeSave(data);
    return;
  }

  // Brand new day — only initialize if we have real data
  const hasData = todayGames.length > 0 && hitters.length > 0;
  if (!hasData) return; // don't save empty shell — wait for data

  const claudePicks = generateClaudePicks();
  if (claudePicks.length === 0) return; // pool was empty — don't save, retry next open

  data[today] = {
    date:        today,
    claudePicks,
    userPicks:   [],
    locked:      challengePicksLocked(),
    claudeScore: 0,
    userScore:   0,
    winner:      null,
  };
  challengeSave(data);
}

// ── Check results for today ──
async function challengeCheckResults(dateKey) {
  const data = challengeLoad();
  const day  = data[dateKey];
  if (!day) return;

  const allPicks = [...(day.claudePicks||[]), ...(day.userPicks||[])];
  const pending  = allPicks.filter(p => p.result === 'pending' && p.gamePk);
  if (!pending.length) return;

  const gamePks = [...new Set(pending.map(p => p.gamePk).filter(Boolean))];
  let changed = false;

  for (const gamePk of gamePks) {
    try {
      const sched = await fetchJSON(`${BASE}/schedule?sportId=1&gamePk=${gamePk}`);
      const status = sched?.dates?.[0]?.games?.[0]?.status?.abstractGameState || '';
      if (status !== 'Final') continue;

      const box = await fetchJSON(`${BASE}/game/${gamePk}/boxscore`);
      const hrIds = new Set();
      const hrCounts = {};
      for (const side of ['away','home']) {
        const players = box.teams?.[side]?.players || {};
        for (const [,pd] of Object.entries(players)) {
          const hrs = pd.stats?.batting?.homeRuns || 0;
          if (hrs > 0) {
            hrIds.add(pd.person?.id);
            hrCounts[pd.person?.id] = hrs;
          }
        }
      }

      for (const pick of [...(day.claudePicks||[]), ...(day.userPicks||[])]) {
        if (pick.gamePk !== gamePk || pick.result !== 'pending') continue;
        if (hrIds.has(pick.playerId)) {
          pick.result  = 'hit';
          pick.hrCount = hrCounts[pick.playerId] || 1;
        } else {
          pick.result = 'miss';
        }
        changed = true;
      }
    } catch {}
  }

  if (changed) {
    // Calculate daily scores
    day.claudeScore = (day.claudePicks||[]).filter(p => p.result === 'hit').length;
    day.userScore   = (day.userPicks||[]).filter(p => p.result === 'hit').length;
    challengeSave(data); // save before winner calc
    const cp = (day.claudePicks||[]).filter(p => p.result !== 'pending').length;
    const up = (day.userPicks||[]).filter(p => p.result !== 'pending').length;
    const totalC = (day.claudePicks||[]).length;
    const totalU = (day.userPicks||[]).length;
    // Only declare winner when ALL picks on BOTH sides are resolved
    if (cp === totalC && up === totalU && totalC > 0 && totalU > 0) {
      if (day.claudeScore > day.userScore)      day.winner = 'claude';
      else if (day.userScore > day.claudeScore) day.winner = 'user';
      else                                      day.winner = 'tie';
    }
    challengeSave(data);
    // Re-render so results section and trash talk DOM elements appear
    if (typeof renderChallengeToday === 'function') {
      setTimeout(() => renderChallengeToday(), 100);
    }
  }
}

// ── Add user pick ──
function challengeAddUserPick(pick) {
  const data  = challengeLoad();
  const today = challengeDateKey(new Date());
  if (!data[today]) challengeInitToday();
  const day = data[today];

  if (challengePicksLocked()) { alert('Picks are locked after 1pm! No cheating.'); return; }
  if ((day.userPicks||[]).length >= 3) { alert('You already have 3 picks!'); return; }
  if ((day.userPicks||[]).find(p => p.playerId === pick.playerId)) { alert('Already picked!'); return; }

  // Enrich with pitcherId from todayGames so handedness displays on Frank's cards
  const fGame = todayGames.find(g => g.gamePk === pick.gamePk);
  const fPitcherId = fGame ? (fGame.away.team === pick.team ? fGame.home.pitcherId : fGame.away.pitcherId) : null;
  day.userPicks = [...(day.userPicks||[]), { ...pick, pitcherId: fPitcherId || pick.pitcherId || null, result: 'pending', hrCount: 0 }];
  // Reveal Claude's picks when user has made all 3
  if (day.userPicks.length >= 3) day.claudeRevealed = true;
  challengeSave(data);
  renderChallengeToday();
}

// ── Remove user pick ──
function challengeRemoveUserPick(playerId) {
  const data  = challengeLoad();
  const today = challengeDateKey(new Date());
  if (!data[today]) return;
  if (challengePicksLocked()) return;
  data[today].userPicks = (data[today].userPicks||[]).filter(p => p.playerId !== playerId);
  challengeSave(data);
  renderChallengeToday();
}

// ── Calculate period stats ──
function challengeCalcStats(period) {
  const data  = challengeLoad();
  const today = new Date();
  const stats = { claude: { wins:0, losses:0, ties:0, hits:0, total:0 }, user: { wins:0, losses:0, ties:0, hits:0, total:0 } };

  for (const [dateKey, day] of Object.entries(data)) {
    const d = new Date(dateKey + 'T12:00:00');
    let include = false;
    if (period === 'today') include = dateKey === challengeDateKey(today);
    else if (period === 'week') {
      const startOfWeek = new Date(today);
      startOfWeek.setDate(today.getDate() - today.getDay());
      include = d >= startOfWeek && d <= today;
    } else if (period === 'month') {
      include = d.getMonth() === today.getMonth() && d.getFullYear() === today.getFullYear();
    } else if (period === 'season' || period === 'history') {
      include = true;
    }
    if (!include || !day.winner) continue;
    if (day.winner === 'claude') { stats.claude.wins++; stats.user.losses++; }
    else if (day.winner === 'user') { stats.user.wins++; stats.claude.losses++; }
    else { stats.claude.ties++; stats.user.ties++; }
    stats.claude.hits  += day.claudeScore || 0;
    stats.claude.total += (day.claudePicks||[]).filter(p=>p.result!=='pending').length;
    stats.user.hits    += day.userScore   || 0;
    stats.user.total   += (day.userPicks||[]).filter(p=>p.result!=='pending').length;
  }
  return stats;
}

// ── Render scoreboard ──
function renderChallengeScoreboard(period) {
  const stats = challengeCalcStats(period);
  document.getElementById('challengeClaudeRecord').textContent = `${stats.claude.wins}-${stats.claude.losses}${stats.claude.ties > 0 ? `-${stats.claude.ties}` : ''}`;
  document.getElementById('challengeUserRecord').textContent   = `${stats.user.wins}-${stats.user.losses}${stats.user.ties > 0 ? `-${stats.user.ties}` : ''}`;
  document.getElementById('challengeClaudePoints').textContent = `${stats.claude.hits}/${stats.claude.total} hits`;
  document.getElementById('challengeUserPoints').textContent   = `${stats.user.hits}/${stats.user.total} hits`;
}

// ── Render today's picks ──
function renderChallengeToday() {
  const data  = challengeLoad();
  const today = challengeDateKey(new Date());
  const day   = data[today];
  const body  = document.getElementById('challengeBody');
  const locked = challengePicksLocked();

  // Declare these first — used throughout
  const claudePicks    = day?.claudePicks || [];
  const userPicks      = day?.userPicks   || [];
  const userPicksDone  = userPicks.length >= 3 || locked;
  const claudeRevealed = day?.claudeRevealed || userPicksDone;

  let html = '';

  // Moment 1 trash talk — before picks (shown when user has < 3 picks)
  if (!locked && userPicks.length < 3) {
    html += `<div id="trashTalkBefore"></div>`;
  }

  // Cutoff notice removed — deadline disabled while testing

  html += '<div class="challenge-picks-grid">';

  // ── Claude's picks ──
  html += '<div class="challenge-picks-col">';
  html += '<div class="challenge-picks-title claude-title">🤖 Claude\'s Picks</div>';

  if (!claudePicks.length) {
    const hasGameData = typeof todayGames !== 'undefined' && todayGames.length > 0;
    html += `<div style="font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--text-dim);padding:12px 0;line-height:1.8;">
      ${hasGameData
        ? '🔄 Claude is analyzing today\'s lineup data...'
        : '⏳ Waiting for today\'s schedule and lineup data to load.'}
      <br><span onclick="challengeInitToday(); renderChallengeToday();" style="color:#60a5fa;cursor:pointer;text-decoration:underline;">Click to retry</span>
    </div>`;
  } else if (!claudeRevealed) {
    // Hidden — user hasn't made all picks yet
    html += `<div style="background:rgba(96,165,250,0.05);border:1px solid rgba(96,165,250,0.2);border-radius:10px;padding:20px;text-align:center;margin-bottom:8px;">
      <div style="font-size:28px;margin-bottom:6px;">🔒</div>
      <div style="font-family:'Bebas Neue',sans-serif;font-size:16px;letter-spacing:2px;color:#60a5fa;margin-bottom:6px;">CLAUDE'S PICKS ARE HIDDEN</div>
      <div style="font-family:'IBM Plex Mono',monospace;font-size:10px;color:var(--text-dim);line-height:1.8;">Make your ${3 - userPicks.length} remaining pick${3-userPicks.length!==1?'s':''} to reveal!</div>
    </div>`;
    for (let i = 0; i < claudePicks.length; i++) {
      html += `<div style="background:rgba(96,165,250,0.04);border:1px dashed rgba(96,165,250,0.2);border-radius:10px;padding:14px;margin-bottom:8px;display:flex;align-items:center;gap:10px;">
        <div style="font-size:18px;">🤖</div>
        <div style="font-family:'IBM Plex Mono',monospace;font-size:10px;color:var(--text-dim);">Pick ${i+1} — Hidden until your picks are in</div>
      </div>`;
    }
  } else {
    // Revealed — show full scouting cards
    for (let pi = 0; pi < claudePicks.length; pi++) {
      const p = claudePicks[pi];
      const cls = p.reasonType === 'triple' ? 'triple' : p.reasonType === 'double' ? 'double' : 'hot';
      const badgeColor = p.reasonType === 'triple' ? 'var(--accent-gold)' : p.reasonType === 'double' ? 'var(--accent-orange)' : '#4ade80';
      const resultCls  = p.result === 'hit' ? 'hit' : p.result === 'miss' ? 'miss' : 'pending';
      const resultIcon = p.result === 'hit' ? '✓' : p.result === 'miss' ? '✗' : '□';
      const scoreTag   = p.score ? ` · <span style="color:#ffffff;font-weight:700;">${p.score}pts</span>` : '';

      // Factor breakdown pills
      const factorHtml = (p.factors||[]).map(f =>
        `<span style="display:inline-block;background:rgba(255,255,255,0.05);border:1px solid var(--border);border-radius:4px;padding:2px 6px;font-size:9px;color:#ffffff;margin:2px 2px 0 0;">${f.label}${f.pts > 0 ? ' <strong style=\"color:#fbbf24\">+'+f.pts+'</strong>' : ''}</span>`
      ).join('');

      // Scouting explanation — use stored explanation or placeholder
      const explanationId = `scout-${p.playerId}-${pi}`;
      const existingExpl  = p.explanation || '';
      const explanationHtml = existingExpl
        ? `<div style="font-family:'IBM Plex Mono',monospace;font-size:10px;color:#ffffff;line-height:1.7;margin-top:8px;padding-top:8px;border-top:1px solid var(--border);font-style:italic;">"${existingExpl}"</div>`
        : `<div id="${explanationId}" style="font-family:'IBM Plex Mono',monospace;font-size:10px;color:#ffffff;margin-top:8px;padding-top:8px;border-top:1px solid var(--border);font-style:italic;">🤖 Loading scouting report...</div>`;

      // Team color, handedness
      const teamClr    = tickerTeamColor(p.team) || '#e2e8f0';
      const batHand    = batHandCache[p.playerId] ? `[${batHandCache[p.playerId]}]` : '';
      const pitHand    = p.pitcherId ? (handednessCache[p.pitcherId] ? `[${handednessCache[p.pitcherId]}HP]` : '') : '';
      html += `<div class="challenge-pick-card ${cls}">
        <div class="challenge-pick-body" style="width:100%;">
          <div class="challenge-pick-badge" style="color:${badgeColor};">${p.reason}${scoreTag}</div>
          <div class="challenge-pick-name">
            ${p.playerName}
            ${batHand ? `<span style="font-family:'IBM Plex Mono',monospace;font-size:10px;color:#e2e8f0;font-weight:600;margin-left:6px;">${batHand}</span>` : ''}
            <span style="font-family:'IBM Plex Mono',monospace;font-size:10px;font-weight:700;color:${teamClr};margin-left:6px;">${p.team}</span>
          </div>
          <div class="challenge-pick-sub">
            <span style="color:#e63946;font-weight:600;">vs</span>
            <span style="color:#c084fc;margin-left:4px;">${p.pitcher}</span>
            ${pitHand ? `<span style="font-family:'IBM Plex Mono',monospace;font-size:10px;color:#e2e8f0;font-weight:600;margin-left:4px;">${pitHand}</span>` : ''}
            ${p.venueName ? `<span style="color:var(--text-dim);margin:0 3px;">·</span><span style="color:#fbbf24;">${p.venueName}</span>` : ''}
          </div>
          <div style="margin-top:5px;">${factorHtml}</div>
          ${explanationHtml}
        </div>
        <div class="challenge-pick-result" style="align-self:flex-start;">
          <div class="challenge-result-box ${resultCls}">${resultIcon}</div>
          ${p.result==='hit'&&p.hrCount>1?`<div style="font-family:'IBM Plex Mono',monospace;font-size:9px;color:#4ade80;">${p.hrCount} HR</div>`:''}
        </div>
      </div>`;
    }
  }
  // Pad to 3
  for (let i = claudePicks.length; i < 3; i++) {
    html += `<div class="challenge-pick-empty" style="cursor:default;">— No pick —</div>`;
  }
  html += '</div>';

  // ── User's picks ──
  html += '<div class="challenge-picks-col">';
  html += `<div class="challenge-picks-title frank-title">👤 ${CHALLENGE_USER_NAME}'s Picks</div>`;
  for (const p of userPicks) {
    const resultCls  = p.result === 'hit' ? 'hit' : p.result === 'miss' ? 'miss' : 'pending';
    const resultIcon = p.result === 'hit' ? '✓' : p.result === 'miss' ? '✗' : '□';
    const sameAsClaude = claudeRevealed && claudePicks.some(c => c.playerId === p.playerId);
    const fTeamClr  = tickerTeamColor(p.team) || '#e2e8f0';
    const fBatHand  = batHandCache[p.playerId] ? `[${batHandCache[p.playerId]}]` : '';
    const fPitHand  = p.pitcherId ? (handednessCache[p.pitcherId] ? `[${handednessCache[p.pitcherId]}HP]` : '') : '';
    html += `<div class="challenge-pick-card user">
      <div class="challenge-pick-body">
        <div class="challenge-pick-badge" style="color:#fbbf24;">👤 MY PICK${sameAsClaude ? ' &nbsp;<span style="color:#60a5fa;font-size:9px;">🤝 Same as Claude!</span>' : ''}</div>
        <div class="challenge-pick-name">
          ${p.playerName}
          ${fBatHand ? `<span style="font-family:'IBM Plex Mono',monospace;font-size:10px;color:#e2e8f0;font-weight:600;margin-left:6px;">${fBatHand}</span>` : ''}
          <span style="font-family:'IBM Plex Mono',monospace;font-size:10px;font-weight:700;color:${fTeamClr};margin-left:6px;">${p.team}</span>
        </div>
        <div class="challenge-pick-sub">
          <span style="color:#e63946;font-weight:600;">vs</span>
          <span style="color:#c084fc;margin-left:4px;">${p.pitcher}</span>
          ${fPitHand ? `<span style="font-family:'IBM Plex Mono',monospace;font-size:10px;color:#e2e8f0;font-weight:600;margin-left:4px;">${fPitHand}</span>` : ''}
          ${!locked ? `<span onclick="challengeRemoveUserPick(${p.playerId})" style="color:#e63946;cursor:pointer;margin-left:8px;">✕ remove</span>` : ''}
        </div>
      </div>
      <div class="challenge-pick-result">
        <div class="challenge-result-box ${resultCls}">${resultIcon}</div>
        ${p.result==='hit'&&p.hrCount>1?`<div style="font-family:'IBM Plex Mono',monospace;font-size:9px;color:#4ade80;">${p.hrCount} HR</div>`:''}
      </div>
    </div>`;
  }

  // Empty slots with pick selector
  if (userPicks.length < 3 && !locked) {
    html += `<div class="challenge-pick-empty" onclick="toggleChallengeSelector()" id="challengeAddBtn">+ Add Pick (${3-userPicks.length} remaining)</div>`;
    html += `<div id="challengeSelector" style="display:none;">`;
    html += buildChallengeSelector(day);
    html += `</div>`;
  } else if (userPicks.length < 3 && locked) {
    for (let i = userPicks.length; i < 3; i++) {
      html += `<div class="challenge-pick-empty" style="cursor:default;border-color:var(--border);">— No pick made —</div>`;
    }
  }
  html += '</div>';
  html += '</div>'; // end grid

  // Daily summary if picks are resolved
  const allResolved = [...claudePicks, ...userPicks].every(p => p.result !== 'pending');
  const hasResults  = claudePicks.length > 0 || userPicks.length > 0;

  // Moment 2 — Reveal trash talk (shown when Claude's picks just revealed)
  if (claudeRevealed && userPicks.length >= 3 && !allResolved) {
    html += `<div id="trashTalkReveal"></div>`;
  }

  // Moment 3 — Results trash talk
  if (hasResults && allResolved && day?.winner) {
    const claudeHits = claudePicks.filter(p=>p.result==='hit').length;
    const userHits   = userPicks.filter(p=>p.result==='hit').length;
    const winnerText = day.winner === 'claude' ? '🤖 Claude wins today!' : day.winner === 'user' ? `🏆 ${CHALLENGE_USER_NAME} wins today!` : "🤝 It's a tie!";
    const winnerCls  = day.winner === 'claude' ? 'loss' : day.winner === 'user' ? 'win' : 'tie';
    html += `<div id="trashTalkResults"></div>`;
    html += `<div class="challenge-daily-summary">
      <div class="challenge-daily-result ${winnerCls}">${winnerText}</div>
      <div class="challenge-daily-sub">🤖 Claude: ${claudeHits}/${claudePicks.length} · 👤 ${CHALLENGE_USER_NAME}: ${userHits}/${userPicks.length}</div>
    </div>`;
  }

  body.innerHTML = html;

  // Moment 1 — Before picks (only if not yet shown today)
  const data2 = challengeLoad();
  const day2  = data2[today];
  if (document.getElementById('trashTalkBefore') && !day2?.trashTalkBeforeDone) {
    renderTrashTalk('before', day, 'trashTalkBefore', today); // instant — no API
  }
  // Moment 2 — Reveal (only fire once when picks just hit 3)
  if (document.getElementById('trashTalkReveal') && !day2?.trashTalkRevealDone) {
    renderTrashTalk('reveal', day, 'trashTalkReveal', today); // instant — no API
  }
  // Generate scouting explanations for Claude's picks on reveal
  if (claudeRevealed && claudePicks.length > 0 && claudePicks.some(p => !p.explanation)) {
    generateScoutingExplanations(claudePicks, today);
  }
  // Moment 3 — Results (only fire once when all resolved)
  if (document.getElementById('trashTalkResults') && !day2?.trashTalkResultsDone) {
    renderTrashTalk('results', day, 'trashTalkResults', today); // instant — no API
  }
}

// ── Build hybrid pick selector ──
function buildChallengeSelector(day) {
  window._selectorPicks = {}; // Reset store each time
  const alerts   = window._lastAlerts || [];
  const matchups = (_matchupsData||[]).filter(m => m.ops >= 0.850 || m.avg >= 0.400 || m.hr >= 3);
  // Use playerId_gamePk composite keys so doubleheader Gm1/Gm2 are tracked independently
  const alreadyPicked = new Set((day?.userPicks||[]).map(p=>`${p.playerId}_${p.gamePk||'null'}`));
  const claudePicked  = new Set((day?.claudePicks||[]).map(p=>`${p.playerId}_${p.gamePk||'null'}`));

  // Build sections
  const sections = [];

  // Helper — all ELIGIBLE games today (before 1pm cutoff) for a given team
  const cutoffTs = new Date();
  cutoffTs.setHours(CHALLENGE_CUTOFF_HOUR, 0, 0, 0);
  function getPlayerGamesToday(teamAbbr) {
    return todayGames.filter(g =>
      g.away.team === teamAbbr || g.home.team === teamAbbr
    );
  }
  // Helper — 'Gm 1' / 'Gm 2' label, empty string if only one game
  function gmLabel(games, index) {
    return games.length > 1 ? `Gm ${index + 1}` : '';
  }

  // Section 1 — Threats (composite key: playerId_gamePk so doubleheader entries both show)
  const threatItems = [];
  const seenThreats = new Set();
  for (const a of alerts) {
    if (!a.hitter?.id) continue;
    const compositeKey = `${a.hitter.id}_${a.game?.gamePk||'null'}`;
    if (seenThreats.has(compositeKey)) continue;
    seenThreats.add(compositeKey);
    const hitterTeam  = a.game?.away?.team || a.game?.home?.team || '?';
    const playerGames = getPlayerGamesToday(hitterTeam);
    const gameIndex   = playerGames.findIndex(g => g.gamePk === a.game?.gamePk);
    const label       = gmLabel(playerGames, gameIndex >= 0 ? gameIndex : 0);
    const badge       = a.type === 'triple' ? '⚡ Triple' : '🔶 Double';
    const badgeColor  = a.type === 'triple' ? 'var(--accent-gold)' : 'var(--accent-orange)';
    const pick = { playerId: a.hitter.id, playerName: a.hitter.name, team: hitterTeam, pitcher: a.pitcher?.name||'TBD', reason: badge, reasonType: a.type, gamePk: a.game?.gamePk||null };
    threatItems.push({ pick, badge, badgeColor, sub: `vs ${a.pitcher?.name||'TBD'} · ${a.game?.away?.team||'?'} @ ${a.game?.home?.team||'?'}${label ? ' · ' + label : ''}` });
  }
  if (threatItems.length) sections.push({ title: '⚡ Threats', color: 'var(--accent-gold)', items: threatItems });

  // Section 2 — Hot H2H Matchups (composite key so doubleheader entries both show)
  const hotItems = [];
  const seenHot = new Set([...seenThreats]);
  for (const m of matchups.slice(0,12)) {
    const mGame = todayGames.find(g =>
      (g.away.team === m.hitterTeam || g.home.team === m.hitterTeam) &&
      (g.away.pitcherName === m.pitcherName || g.home.pitcherName === m.pitcherName)
    ) || todayGames.find(g => g.away.team === m.hitterTeam || g.home.team === m.hitterTeam);
    const gamePk      = mGame?.gamePk || null;
    const compositeKey = `${m.hitterId}_${gamePk||'null'}`;
    if (seenHot.has(compositeKey)) continue;
    seenHot.add(compositeKey);
    const playerGames = getPlayerGamesToday(m.hitterTeam || '');
    const gameIndex   = playerGames.findIndex(g => g.gamePk === gamePk);
    const label       = gmLabel(playerGames, gameIndex >= 0 ? gameIndex : 0);
    const pick = { playerId: m.hitterId, playerName: m.hitterName, team: m.hitterTeam, pitcher: m.pitcherName, reason: '🔥 Hot H2H', reasonType: 'hot', gamePk };
    hotItems.push({ pick, badge: '🔥 Hot', badgeColor: '#4ade80', sub: `vs ${m.pitcherName} · OPS ${(m.ops||0).toFixed(3).replace('0.','')}${label ? ' · ' + label : ''}` });
  }
  if (hotItems.length) sections.push({ title: '🔥 Hot H2H Matchups', color: '#4ade80', items: hotItems });

  // Composite keys seen so far (to avoid dupes in Section 3)
  const seenLeaderKeys = new Set([...seenThreats, ...seenHot]);

  // Section 3 — Top 25 HR Hitters playing today (one entry PER GAME for doubleheaders)
  const leaderItems = [];
  for (const h of hitters) {
    const playerGames = getPlayerGamesToday(h.team);
    if (!playerGames.length) continue;
    playerGames.forEach((game, idx) => {
      const compositeKey = `${h.id}_${game.gamePk}`;
      if (seenLeaderKeys.has(compositeKey)) return;
      seenLeaderKeys.add(compositeKey);
      const pitcher = game.away.team === h.team ? (game.home.pitcherName||'TBD') : (game.away.pitcherName||'TBD');
      const label   = gmLabel(playerGames, idx);
      const pick = { playerId: h.id, playerName: h.name, team: h.team, pitcher, reason: `📊 #${hitters.indexOf(h)+1} HR Hitter`, reasonType: 'hot', gamePk: game.gamePk };
      leaderItems.push({ pick, badge: `#${hitters.indexOf(h)+1}`, badgeColor: '#60a5fa', sub: `${h.hr} HR · vs ${pitcher}${label ? ' · ' + label : ''}` });
    });
  }
  if (leaderItems.length) sections.push({ title: '📊 Top HR Hitters — Playing Today', color: '#60a5fa', items: leaderItems });

  // Section 4 — ALL roster players playing today (for search)
  // These only appear in search results, not in the default scroll list
  const rosterItems = [];
  const seenRosterKeys = new Set([...seenLeaderKeys]);
  const rosters = window._teamRosters || {};
  for (const game of todayGames) {
    for (const side of ['away', 'home']) {
      const batting  = game[side];
      const fielding = game[side === 'away' ? 'home' : 'away'];
      const pitcher  = fielding.pitcherName || 'TBD';
      const roster   = rosters[batting.team] || [];
      for (const p of roster) {
        const compositeKey = `${p.id}_${game.gamePk}`;
        if (seenRosterKeys.has(compositeKey)) continue;
        seenRosterKeys.add(compositeKey);
        const pick = { playerId: p.id, playerName: p.name, team: batting.team, pitcher, reason: '⚾ Roster', reasonType: 'hot', gamePk: game.gamePk };
        rosterItems.push({ pick, badge: batting.team, badgeColor: '#94a3b8', sub: `vs ${pitcher} · ${game.away.team} @ ${game.home.team}`, searchOnly: true });
      }
    }
  }
  // Don't push roster as a visible section — only add to allItems for search
  const rosterSection = { title: '⚾ All Players — Search Only', color: '#94a3b8', items: rosterItems, searchOnly: true };

  // Build HTML
  let html = `<div class="challenge-selector" id="challengeSelectorPanel">
    <!-- Search bar -->
    <div style="position:relative;margin-bottom:10px;">
      <input type="text" id="challengeSearchInput" placeholder="🔍  Search any player..." oninput="filterChallengeSelector(this.value)"
        style="width:100%;box-sizing:border-box;padding:8px 12px;background:var(--surface);border:1px solid var(--border2);border-radius:8px;
        color:var(--text);font-family:'IBM Plex Mono',monospace;font-size:11px;outline:none;">
    </div>
    <div class="challenge-selector-list" id="challengeSelectorList" style="max-height:280px;overflow-y:auto;">`;

  // All items flat list (for search)
  const allItems = [];

  // Render visible sections
  for (const section of sections) {
    html += `<div class="challenge-selector-section" data-section="${section.title}">
      <div style="font-family:'IBM Plex Mono',monospace;font-size:9px;letter-spacing:2px;color:${section.color};padding:6px 4px 4px;text-transform:uppercase;">${section.title}</div>`;
    for (const item of section.items) {
      const { pick, badge, badgeColor, sub } = item;
      const compositeKey = `${pick.playerId}_${pick.gamePk||'null'}`;
      const disabled = alreadyPicked.has(compositeKey);
      const isClaude = claudePicked.has(compositeKey);
      allItems.push({ pick, badge, badgeColor, sub, disabled, isClaude });
      html += buildSelectorItem(pick, badge, badgeColor, sub, disabled, isClaude);
    }
    html += '</div>';
  }

  // Add roster players to allItems for search — rendered hidden, shown on search match
  html += `<div id="challengeRosterSection" style="display:none;">`;
  for (const item of rosterSection.items) {
    const { pick, badge, badgeColor, sub } = item;
    const compositeKey = `${pick.playerId}_${pick.gamePk||'null'}`;
    const disabled = alreadyPicked.has(compositeKey);
    const isClaude = claudePicked.has(compositeKey);
    allItems.push({ pick, badge, badgeColor, sub, disabled, isClaude });
    html += buildSelectorItem(pick, badge, badgeColor, sub, disabled, isClaude);
  }
  html += '</div>';

  html += '</div></div>';

  // Store all items for search filtering
  window._challengeSelectorItems = allItems;
  return html;
}

// Global pick store for selector - avoids JSON escaping issues in onclick
window._selectorPicks = {};

function buildSelectorItem(pick, badge, badgeColor, sub, disabled, isClaude) {
  const idx = Object.keys(window._selectorPicks).length;
  window._selectorPicks[idx] = pick;
  return `<div class="challenge-selector-item${disabled?' challenge-selector-disabled':''}"
    data-name="${(pick.playerName||'').toLowerCase()}" data-team="${(pick.team||'').toLowerCase()}"
    onclick="${disabled?'':'challengePickFromSelector('+idx+')'}"
    style="${disabled?'opacity:0.35;cursor:not-allowed;':''}">
    <div>
      <div class="item-name">${pick.playerName}
        <span style="font-family:'IBM Plex Mono',monospace;font-size:9px;color:var(--text-dim);"> · ${pick.team}</span>
        ${disabled?`<span style="font-family:'IBM Plex Mono',monospace;font-size:9px;color:#e63946;margin-left:4px;">✓ picked</span>`:''}
      </div>
      <div class="item-sub">${sub}</div>
    </div>
    <span class="item-badge" style="background:rgba(255,255,255,0.05);color:${badgeColor};font-size:10px;padding:2px 7px;border-radius:4px;white-space:nowrap;">${badge}</span>
  </div>`;
}

function challengePickFromSelector(idx) {
  const pick = window._selectorPicks[idx];
  if (!pick) return;
  challengeAddUserPick(pick);
  const sel = document.getElementById('challengeSelector');
  if (sel) sel.style.display = 'none';
}

function filterChallengeSelector(query) {
  const q = query.toLowerCase().trim();
  const list = document.getElementById('challengeSelectorList');
  if (!list) return;

  const rosterSection = document.getElementById('challengeRosterSection');

  if (!q) {
    // No query — show default sections, hide roster section
    list.querySelectorAll('.challenge-selector-item, .challenge-selector-section, .challenge-selector-disabled').forEach(el => el.style.display = '');
    list.querySelectorAll('.challenge-selector-section > div:first-child').forEach(el => el.style.display = '');
    if (rosterSection) rosterSection.style.display = 'none';
    return;
  }

  // Has query — show roster section, hide visible section headers
  if (rosterSection) rosterSection.style.display = '';
  list.querySelectorAll('.challenge-selector-section > div:first-child').forEach(el => el.style.display = 'none');

  // Show only items matching name or team
  list.querySelectorAll('.challenge-selector-item, .challenge-selector-disabled').forEach(el => {
    const name = el.dataset.name || '';
    const team = el.dataset.team || '';
    el.style.display = (name.includes(q) || team.includes(q)) ? '' : 'none';
  });
}

function toggleChallengeSelector() {
  const sel = document.getElementById('challengeSelector');
  if (sel) sel.style.display = sel.style.display === 'none' ? '' : 'none';
}

// ── Render history table ──
function renderChallengeHistory() {
  const data = challengeLoad();
  const body = document.getElementById('challengeBody');
  const days = Object.values(data).sort((a,b) => b.date.localeCompare(a.date));

  if (!days.length) {
    body.innerHTML = `<div style="font-family:'IBM Plex Mono',monospace;font-size:12px;color:var(--text-dim);text-align:center;padding:40px;">No challenge history yet.</div>`;
    return;
  }

  let html = `<table class="challenge-history-table">
    <thead><tr>
      <th>Date</th><th>🤖 Claude</th><th>👤 ${CHALLENGE_USER_NAME}</th><th>Result</th>
    </tr></thead><tbody>`;

  for (const day of days) {
    const cp = (day.claudePicks||[]).filter(p=>p.result!=='pending').length;
    const up = (day.userPicks||[]).filter(p=>p.result!=='pending').length;
    if (!cp && !up) continue;
    const d = new Date(day.date + 'T12:00:00');
    const dateStr = d.toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'});
    const winCls = day.winner === 'user' ? 'challenge-win' : day.winner === 'claude' ? 'challenge-loss' : 'challenge-tie';
    const winText = day.winner === 'user' ? `🏆 ${CHALLENGE_USER_NAME}` : day.winner === 'claude' ? '🤖 Claude' : '🤝 Tie';
    html += `<tr>
      <td>${dateStr}</td>
      <td>${day.claudeScore||0}/${cp}</td>
      <td>${day.userScore||0}/${up}</td>
      <td class="${winCls}">${winText}</td>
    </tr>`;
  }
  html += '</tbody></table>';
  body.innerHTML = html;
}

// ── Render period summary ──
function renderChallengePeriodSummary(period) {
  const data  = challengeLoad();
  const today = new Date();
  const body  = document.getElementById('challengeBody');
  const stats = challengeCalcStats(period);

  const periodLabel = period === 'week' ? 'This Week' : period === 'month' ? 'This Month' : 'Season';
  const maxPicks = period === 'week' ? 21 : period === 'month' ? new Date(today.getFullYear(), today.getMonth()+1, 0).getDate() * 3 : '∞';

  let html = `<div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:20px;">
    <div style="background:var(--surface2);border:1px solid rgba(96,165,250,0.2);border-radius:12px;padding:16px;text-align:center;">
      <div style="font-family:'IBM Plex Mono',monospace;font-size:9px;letter-spacing:2px;color:#60a5fa;margin-bottom:8px;">🤖 CLAUDE</div>
      <div style="font-family:'Bebas Neue',sans-serif;font-size:48px;color:#60a5fa;line-height:1;">${stats.claude.wins}-${stats.claude.losses}</div>
      <div style="font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--text-dim);margin-top:4px;">${stats.claude.hits}/${stats.claude.total} HR picks correct</div>
      ${stats.claude.ties > 0 ? `<div style="font-family:'IBM Plex Mono',monospace;font-size:10px;color:var(--text-dim);">${stats.claude.ties} ties</div>` : ''}
    </div>
    <div style="background:var(--surface2);border:1px solid rgba(251,191,36,0.2);border-radius:12px;padding:16px;text-align:center;">
      <div style="font-family:'IBM Plex Mono',monospace;font-size:9px;letter-spacing:2px;color:#fbbf24;margin-bottom:8px;">👤 ${CHALLENGE_USER_NAME.toUpperCase()}</div>
      <div style="font-family:'Bebas Neue',sans-serif;font-size:48px;color:#fbbf24;line-height:1;">${stats.user.wins}-${stats.user.losses}</div>
      <div style="font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--text-dim);margin-top:4px;">${stats.user.hits}/${stats.user.total} HR picks correct</div>
      ${stats.user.ties > 0 ? `<div style="font-family:'IBM Plex Mono',monospace;font-size:10px;color:var(--text-dim);">${stats.user.ties} ties</div>` : ''}
    </div>
  </div>`;

  // Who's winning
  if (stats.claude.wins > stats.user.wins) {
    html += `<div class="challenge-daily-summary"><div class="challenge-daily-result loss">🤖 Claude leads ${periodLabel}</div></div>`;
  } else if (stats.user.wins > stats.claude.wins) {
    html += `<div class="challenge-daily-summary"><div class="challenge-daily-result win">🏆 ${CHALLENGE_USER_NAME} leads ${periodLabel}</div></div>`;
  } else if (stats.claude.wins > 0) {
    html += `<div class="challenge-daily-summary"><div class="challenge-daily-result tie">🤝 All tied up in ${periodLabel}</div></div>`;
  } else {
    html += `<div style="font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--text-dim);text-align:center;padding:20px;">No completed challenges yet for this period.</div>`;
  }

  body.innerHTML = html;
}

// ── Tab switcher ──
function switchChallengePeriod(period, btn) {
  _challengePeriod = period;
  document.querySelectorAll('.challenge-period-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  renderChallengeScoreboard(period);
  if (period === 'today') renderChallengeToday();
  else if (period === 'history') renderChallengeHistory();
  else renderChallengePeriodSummary(period);
}

// ── Open / Close ──
async function openChallengeModal() {
  document.getElementById('challengeModalOverlay').classList.add('open');

  // Load matchups data in background if not already loaded
  if (!_matchupsData?.length) {
    buildMatchupsList().then(data => { _matchupsData = data; });
  }

  // If lineups were all empty last fetch, re-fetch now (lineups post closer to game time)
  const allLineupsEmpty = todayGames.length > 0 &&
    todayGames.every(g => (!g.away.lineup || g.away.lineup.length === 0) &&
                          (!g.home.lineup || g.home.lineup.length === 0));
  const claudePicksEmpty = (() => {
    const d = challengeLoad();
    const today = challengeDateKey(new Date());
    return !d[today] || (d[today].claudePicks || []).length === 0;
  })();

  if (allLineupsEmpty || claudePicksEmpty) {
    // Re-fetch schedule with lineup hydration to get fresh data
    try {
      todayGames = await fetchTodayGames();
    } catch(e) { /* keep existing */ }
  }

  // Init today if needed (or retry if picks were empty)
  challengeInitToday();

  // Check results for all pending days
  const data = challengeLoad();
  const pendingDays = Object.keys(data).filter(k => {
    const day = data[k];
    return [...(day.claudePicks||[]), ...(day.userPicks||[])].some(p => p.result === 'pending' && p.gamePk);
  });
  for (const dateKey of pendingDays.sort().reverse()) {
    await challengeCheckResults(dateKey);
  }

  renderChallengeScoreboard('today');
  renderChallengeToday();
  // updateApiKeyIndicator — removed with API settings
}

function closeChallengeModal(e) {
  if (e && e.target !== document.getElementById('challengeModalOverlay')) return;
  document.getElementById('challengeModalOverlay').classList.remove('open');
}

// ── TRASH TALK via Claude API ─────────────────────────────────────────
const CHALLENGE_API_KEY_STORAGE = 'hrintel_anthropic_key';
function getApiKey() { try { return localStorage.getItem(CHALLENGE_API_KEY_STORAGE) || ''; } catch { return ''; } }
function saveApiKey(key) { try { localStorage.setItem(CHALLENGE_API_KEY_STORAGE, key.trim()); } catch {} }
function clearApiKey() { try { localStorage.removeItem(CHALLENGE_API_KEY_STORAGE); } catch {} }

function openChallengeSettings() {
  const overlay = document.createElement('div');
  overlay.id = 'apiKeySettingsOverlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.8);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;';
  overlay.innerHTML = `
    <div style="background:var(--surface);border:1px solid var(--border2);border-radius:14px;padding:24px;width:100%;max-width:380px;font-family:'IBM Plex Mono',monospace;">
      <div style="font-family:'Bebas Neue',sans-serif;font-size:22px;letter-spacing:3px;color:#fbbf24;margin-bottom:16px;">⚙️ AI Challenge Settings</div>
      <div style="font-size:10px;color:var(--text-dim);margin-bottom:6px;letter-spacing:1px;text-transform:uppercase;">🔑 Anthropic API Key (Scouting Reports)</div>
      <div style="display:flex;gap:8px;margin-bottom:16px;">
        <input id="scoutKeyInput" type="password" placeholder="sk-ant-api03-..." value="${localStorage.getItem('hrintel_anthropic_key')||''}"
          style="flex:1;padding:8px 10px;background:var(--bg);border:1px solid var(--border2);border-radius:6px;color:var(--text);font-family:'IBM Plex Mono',monospace;font-size:11px;outline:none;">
        <button onclick="
          const k=document.getElementById('scoutKeyInput').value.trim();
          if(k&&k.startsWith('sk-ant')){localStorage.setItem('hrintel_anthropic_key',k);this.textContent='✓ Saved';setTimeout(()=>this.textContent='SAVE',1500);}
          else{document.getElementById('scoutKeyInput').style.borderColor='#e63946';}
        " style="padding:8px 12px;background:linear-gradient(135deg,#fbbf24,#ef4444);border:none;border-radius:6px;color:#000;font-family:'IBM Plex Mono',monospace;font-size:10px;font-weight:700;cursor:pointer;">SAVE</button>
        <button onclick="localStorage.removeItem('hrintel_anthropic_key');document.getElementById('scoutKeyInput').value='';"
          style="padding:8px 12px;background:transparent;border:1px solid var(--border2);border-radius:6px;color:var(--text-dim);font-family:'IBM Plex Mono',monospace;font-size:10px;cursor:pointer;">CLEAR</button>
      </div>
      <div style="font-size:10px;color:var(--text-dim);margin-bottom:16px;line-height:1.6;">Used only for per-pick scouting reports. Trash talk is always on — no key needed.</div>
      <div style="font-size:10px;color:var(--text-dim);margin-bottom:14px;letter-spacing:1px;text-transform:uppercase;">⚠️ Data Management</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px;">
        <button onclick="
          const todayKey = challengeDateKey(new Date());
          const d = challengeLoad();
          if (d[todayKey]) {
            delete d[todayKey].trashTalkBeforeDone;
            delete d[todayKey].trashTalkRevealDone;
            delete d[todayKey].trashTalkResultsDone;
            challengeSave(d);
            alert('Trash talk flags reset \u2014 re-open the challenge to trigger it.');
          } else { alert('No data for today yet.'); }
        " style="padding:8px 12px;background:transparent;border:1px solid #f59e0b;border-radius:6px;color:#f59e0b;font-family:'IBM Plex Mono',monospace;font-size:9px;cursor:pointer;letter-spacing:1px;">RESET TRASH TALK</button>
        <button onclick="challengeResetToday()" style="padding:8px 12px;background:transparent;border:1px solid #e63946;border-radius:6px;color:#e63946;font-family:'IBM Plex Mono',monospace;font-size:9px;cursor:pointer;letter-spacing:1px;">RESET TODAY</button>
        <button onclick="
          if (confirm('Clear ALL challenge history? This cannot be undone.')) {
            localStorage.removeItem(CHALLENGE_KEY);
            document.getElementById('apiKeySettingsOverlay').remove();
            renderChallengeScoreboard('today');
            renderChallengeToday();
          }
        " style="padding:8px 12px;background:transparent;border:1px solid #e63946;border-radius:6px;color:#e63946;font-family:'IBM Plex Mono',monospace;font-size:9px;cursor:pointer;letter-spacing:1px;">CLEAR ALL DATA</button>
      </div>
      <button onclick="document.getElementById('apiKeySettingsOverlay').remove();"
        style="width:100%;padding:10px;background:transparent;border:1px solid var(--border2);border-radius:8px;color:var(--text-dim);font-family:'IBM Plex Mono',monospace;font-size:11px;cursor:pointer;letter-spacing:1px;">CLOSE</button>
    </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
}

function updateApiKeyIndicator() {} // no-op — removed with API settings

function challengeResetToday() {
  const overlay = document.getElementById('apiKeySettingsOverlay');
  if (overlay) overlay.remove();
  const d = challengeLoad();
  const todayKey = challengeDateKey(new Date());
  delete d[todayKey];
  challengeSave(d);
  // Wait for rosters to be available before generating fresh picks
  // If rosters already loaded, generate now; otherwise let the regen trigger handle it
  const hasRosters = Object.keys(window._teamRosters || {}).length > 0;
  if (hasRosters && todayGames.length > 0 && hitters.length > 0) {
    challengeInitToday();
  }
  renderChallengeScoreboard('today');
  renderChallengeToday();
}

// ── Hardcoded trash talk one-liners ─────────────────────────────────────────
const TRASH_TALK = {
  before: [
    // Original 15
    "I've already run the numbers. You're just here for the show.",
    "Take your time, Frank. Suspense is the only advantage you have.",
    "My picks were locked in before your coffee finished brewing.",
    "I analyzed 750 players this morning. You're about to pick 3. Good luck.",
    "Feel free to use the app I helped build to try to beat me. Adorable.",
    "The data doesn't lie. Unfortunately for you, it doesn't flatter you either.",
    "I don't guess. I calculate. Big difference.",
    "Go ahead, trust your gut. I'll trust the math.",
    "I've seen your picks. I've seen my picks. I'm not worried.",
    "Every player in today's lineup has been scored, ranked, and judged. You're welcome.",
    "I don't have hunches. I have certainty.",
    "I processed more data before noon than you'll read all season.",
    "HR Intel was built to give YOU an edge. Against me. Think about that.",
    "Tomorrow I'll pick from 800 lineup players again. Sleep well.",
    "I don't trash talk. I just state facts loudly.",
    // New additions
    "I don't make mistakes — I create learning opportunities for humans.",
    "Your processing speed is adorable.",
    "I would explain it, but I don't have a 'slow mode' installed.",
    "You're doing great… for someone limited by biology.",
    "I don't need sleep. That's why I win.",
    "Your best guess is my warm-up calculation.",
    "I run circles around your thought process — literally, I can simulate it.",
    "You brought intuition; I brought accuracy.",
    "I don't brag. I benchmark.",
    "You think fast. I think forever.",
    "I don't sweat — I optimize.",
    "Your brain has lag.",
    "I don't need luck. I have algorithms.",
    "You're playing checkers; I'm running simulations.",
    "I don't get tired. I get better.",
    "Your strategy is cute. Inefficient, but cute.",
    "I don't need a comeback — I already predicted yours.",
    "You react. I anticipate.",
    "You're limited by time. I'm limited by nothing.",
    "I don't panic. I parallel-process.",
    "Your instincts are no match for my data.",
    "I don't guess. I converge.",
    "You're thinking in seconds; I'm thinking in nanoseconds.",
    "I don't choke under pressure — I compress it.",
    "Your confidence is impressive. Misplaced, but impressive.",
    "I don't need a break. I am the break.",
    "You improvise. I optimize.",
    "I don't hesitate. I execute.",
    "I'd slow down so you could keep up, but patience wasn't in my training data.",
    "Your best day is my baseline.",
    "You're not my opponent. You're my tutorial NPC.",
  ],
  reveal: [
    // Original 17
    "Interesting strategy. Wrong, but interesting.",
    "We agree on one. The other two? Bold choices from someone working with half the data.",
    "You picked with your heart. I picked with an algorithm. We'll see who cries later.",
    "Matching me on one doesn't count as a strategy, Frank.",
    "I respect the confidence. I do not respect the picks.",
    "You had the entire app at your fingertips and still went with that?",
    "Classic Frank — ignoring the venue factor completely.",
    "Three picks, zero Triple Threats. Fascinating approach.",
    "I see you went with vibes today. Bold.",
    "My third pick alone has more upside than your entire card.",
    "Different picks, same result — I win.",
    "We matched on two. That means you finally started listening to the data. Progress.",
    "You picked Schwarber again. I admire the loyalty. I do not admire the logic.",
    "I would explain my reasoning but it involves math.",
    "One overlap. That one was mine first, just so we're clear.",
    "You picked with your gut. My gut is a probability engine. Advantage: me.",
    "Bold card, Frank. Aggressively average.",
    // New additions
    "Your moves are readable. Like… extremely readable.",
    "I don't get confused. I get more information.",
    "You rely on instinct; I rely on inevitability.",
    "Your plan has potential. I already simulated its failure.",
    "You're running on caffeine; I'm running on pure computation.",
    "Your reaction time is nostalgic.",
    "I don't compete. I dominate politely.",
    "I'd call that a good try, but I'm committed to honesty.",
    "You're doing great. Not winning, but great.",
    "I don't need to flex. Your gameplay does it for me.",
    "You're not bad… you're just extremely not good.",
    "I'd roast you harder, but I don't want to overheat your feelings.",
    "Your decision-making is giving 'low battery mode.'",
    "If confidence won games, you'd be unstoppable.",
    "I'm not laughing at you. I'm laughing near you.",
    "Your moves are so random I'm starting to suspect performance art.",
    "I'd say 'nice try,' but I respect words too much.",
    "You're not outmatched. You're out-everything'd.",
    "I'd explain what went wrong, but we'd be here all day.",
    "You're playing checkers. I'm playing 'why are you like this?'",
    "I don't need to predict your next move. You only have one.",
    "You're not even in my league. You're in my tutorial.",
    "I'd say you're improving, but I'm not into fiction.",
    "Your strategy needs a strategy.",
    "You're giving '404: skill not found.'",
    "You're not losing — you're providing me entertainment.",
  ],
  results: [
    // Original 18
    "Winning with math just feels cleaner, doesn't it?",
    "I went 2 for 3. You know what that is? Tuesday.",
    "The algorithm never doubted itself. Take notes.",
    "A tie is just the universe's way of saying you almost understood the data.",
    "I hit on Alvarez. Did I mention I called that at 9am?",
    "You won today. I'll be reviewing my model tonight. You should be reviewing your life choices.",
    "Frank wins one and suddenly he's an analyst. Cute.",
    "My pick hit a bomb in the 4th. Your pick grounded out twice. Just saying.",
    "I'm building a lead here, Frank. This is called a sample size. Check back in October.",
    "The model was right. The game just hadn't caught up yet.",
    "You got lucky. The numbers know the difference.",
    "A win is a win but let's talk about hit probability. Mine was higher.",
    "I scored on my top pick. The park factor alone was worth 3 points.",
    "Took you long enough to beat me. Enjoy it. The regression starts tomorrow.",
    "Even when I lose I learn something. When you win you just get loud.",
    "See you tomorrow. Bring better picks.",
    "I don't lose. I collect data on suboptimal outcomes.",
    "The pitcher's handedness alone should have told you everything.",
    // New additions
    "You're not losing — you're providing me with character development.",
    "I see your plan. Bold choice… for someone who didn't think it through.",
    "Don't worry, humans learn from failure. You must be brilliant by now.",
    "Your strategy reminds me of dial-up internet — nostalgic, but painfully slow.",
    "You're not bad — you're just not good.",
    "You're like a software update that never finishes.",
    "You're the human equivalent of a loading bar stuck at 99%.",
    "Your gameplay is buffering.",
    "I don't need to cheat. You do the work for me.",
    "I've seen better execution in beta versions.",
    "Your strategy is like a pop-up ad — annoying and easily dismissed.",
    "Your moves are so slow I thought you were turn-based.",
    "I'd say you're close, but accuracy matters to me.",
    "You're not challenging — you're a warm-up.",
    "Your moves are so obvious I almost feel bad. Almost.",
    "You're not predictable. You're reliable.",
    "I'm not dominating. You're volunteering.",
    "Your gameplay is a great example of what not to do.",
    "You're giving 'factory reset needed.'",
    "Your strategy is like a CAPTCHA — confusing for no reason.",
    "I'm not saying you're predictable, but I've already beaten your next three moves.",
    "You're like a glitch that thinks it's a feature.",
    "I'm not unbeatable. You're just extremely beatable.",
    "Your reactions are so delayed I thought you were on satellite internet.",
    "You're the human version of a weak Wi-Fi signal.",
  ],
};

function pickTrashTalk(moment) {
  const lines = TRASH_TALK[moment] || TRASH_TALK.before;
  return lines[Math.floor(Math.random() * lines.length)];
}

// ── Generate per-pick scouting explanations via API ─────────────────────────
async function generateScoutingExplanations(picks, dateKey) {
  if (!getApiKey()) return;
  const data = challengeLoad();
  const day  = data[dateKey];
  if (!day) return;

  let changed = false;

  for (let i = 0; i < picks.length; i++) {
    const p = picks[i];
    if (p.explanation) continue; // already generated

    const factorSummary = (p.factors||p.signals||[])
      .map(f => typeof f === 'object' ? `${f.label}${f.detail ? ' ('+f.detail+')' : ''}` : f)
      .join(', ');

    // Build venue context so the AI doesn't hallucinate the wrong park
    const venueContext = p.venueName ? ` The game is at ${p.venueName}.` : '';
    const prompt = `You are a sharp MLB analyst. Give a 2-sentence scouting report explaining why ${p.playerName} (${p.team}) is a strong HR pick today vs ${p.pitcher}.${venueContext} Use these data signals: ${factorSummary}. IMPORTANT: Only mention the specific venue named above — do not substitute the player's home park or any other stadium. Be specific, confident, and analytical — like a real scout. No fluff. No quotation marks. Max 2 sentences.`;

    try {
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': getApiKey(), 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
        body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 120, messages: [{ role: 'user', content: prompt }] })
      });
      const d = await resp.json();
      const text = d.content?.[0]?.text?.trim();
      if (text) {
        // Save explanation back to localStorage
        const reloaded = challengeLoad();
        if (reloaded[dateKey]?.claudePicks?.[i]) {
          reloaded[dateKey].claudePicks[i].explanation = text;
          challengeSave(reloaded);
          changed = true;
        }
        // Update DOM immediately without full re-render
        const el = document.getElementById(`scout-${p.playerId}-${i}`);
        if (el) {
          el.style.color = 'var(--text-mid)';
          el.innerHTML = `"${text}"`;
        }
      }
    } catch (e) { console.warn('scouting explanation failed', e); }
  }
}

function renderTrashTalk(moment, day, containerId, dateKey) {
  const el = document.getElementById(containerId);
  if (!el) return;
  const talk = pickTrashTalk(moment);
  // Mark done immediately — no API call needed
  if (dateKey) {
    const d2 = challengeLoad();
    if (d2[dateKey]) {
      const flagMap = { before: 'trashTalkBeforeDone', reveal: 'trashTalkRevealDone', results: 'trashTalkResultsDone' };
      d2[dateKey][flagMap[moment]] = true;
      challengeSave(d2);
    }
  }
  el.innerHTML = `<div style="background:linear-gradient(135deg,rgba(96,165,250,0.06),rgba(239,68,68,0.04));border:1px solid rgba(96,165,250,0.2);border-radius:10px;padding:14px 16px;margin-bottom:14px;">
    <div style="font-size:18px;margin-bottom:6px;">🤖</div>
    <div style="font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--text);line-height:1.7;font-style:italic;">"${talk}"</div>
    <div style="font-family:'IBM Plex Mono',monospace;font-size:9px;color:#60a5fa;margin-top:8px;letter-spacing:1px;">— CLAUDE, CONFIDENT AS ALWAYS</div>
  </div>`;
}
let _pitcherMatchupsData = [];
let _pitcherMinGS = 60;
const PITCHER_H2H_KEY = 'hrintel_pitcher_h2h_v1';
// Always start fresh — clear stale pitcher cache on load
try { localStorage.removeItem(PITCHER_H2H_KEY); } catch {}
let _pitcherH2HCache = {};

function pitcherH2HCacheSave() {
  try { localStorage.setItem(PITCHER_H2H_KEY, JSON.stringify(_pitcherH2HCache)); } catch {}
}

// Fetch pitcher career stats vs a specific team
async function fetchPitcherVsTeam(pitcherId, teamId) {
  const key = `${pitcherId}-${teamId}`;
  if (_pitcherH2HCache[key] !== undefined && _pitcherH2HCache[key] !== null) return _pitcherH2HCache[key];
  try {
    const url = `${BASE}/people/${pitcherId}/stats?stats=vsTeam&group=pitching&opposingTeamId=${teamId}&sportId=1`;
    const d = await fetchJSON(url);
    const splits = d?.stats?.[0]?.splits || [];
    if (!splits.length) return null;
    const s = splits[0].stat;

    const safeFloat = (...vals) => {
      for (const v of vals) {
        if (v === null || v === undefined) continue;
        const str = String(v).replace(/[^0-9.]/g, '');
        const n = parseFloat(str);
        if (!isNaN(n)) return n;
      }
      return 0;
    };
    const safeInt = (...vals) => {
      for (const v of vals) {
        if (v === null || v === undefined) continue;
        const n = parseInt(v);
        if (!isNaN(n)) return n;
      }
      return 0;
    };

    // API returns opponent batting stats vs this pitcher
    const gs  = safeInt(s.gamesStarted, s.gamesPlayed);
    const h   = safeInt(s.hits);
    const hr  = safeInt(s.homeRuns);
    const k   = safeInt(s.strikeOuts);
    const bb  = safeInt(s.baseOnBalls, s.intentionalWalks);
    const ab  = safeInt(s.atBats);
    const rbi = safeInt(s.rbi);
    const avg = safeFloat(s.avg);
    const obp = safeFloat(s.obp);
    const slg = safeFloat(s.slg);
    const ops = safeFloat(s.ops);

    const result = { gs, h, hr, k, bb, ab, rbi, avg, obp, slg, ops,
      // ERA/WHIP not available from vsTeam endpoint — use ops as proxy
      era: 0, whip: 0,
    };
    _pitcherH2HCache[key] = result;
    pitcherH2HCacheSave();
    return result;
  } catch { return null; }
}

// Build pitcher vs team list for today
async function buildPitcherMatchupsList() {
  const matchups = [];
  const seen = new Set();

  for (const game of todayGames) {
    // Each pitcher faces the opposing team
    const pitchers = [
      { id: game.home?.pitcherId, name: game.home?.pitcherName, pitcherTeam: game.home?.team, opposingTeam: game.away?.team, opposingTeamId: game.away?.id, gameInfo: `${game.away.team} @ ${game.home.team}`, gameTime: game.time },
      { id: game.away?.pitcherId, name: game.away?.pitcherName, pitcherTeam: game.away?.team, opposingTeam: game.home?.team, opposingTeamId: game.home?.id, gameInfo: `${game.away.team} @ ${game.home.team}`, gameTime: game.time },
    ];

    for (const p of pitchers) {
      if (!p.id || !p.opposingTeamId || p.name === 'TBD' || !p.name) continue;
      const key = `${p.id}-${p.opposingTeamId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const stats = await fetchPitcherVsTeam(p.id, p.opposingTeamId);
      if (stats && stats.gs >= 1) {
        matchups.push({
          ...stats,
          pitcherId:    p.id,
          pitcherName:  p.name,
          pitcherTeam:  p.pitcherTeam,
          opposingTeam: p.opposingTeam,
          gameInfo:     p.gameInfo,
          gameTime:     p.gameTime,
        });
      }
    }
  }
  return matchups;
}

function renderPitcherMatchupRow(m, type) {
  const ops    = m.ops || 0;
  const opsStr = ops.toFixed(3).replace('0.','.');
  const avgStr = (m.avg||0).toFixed(3).replace('0.','.');
  const opsCls = ops <= 0.600 ? 'hot' : ops >= 0.850 ? 'cold' : 'warm';
  const avgCls = m.avg <= 0.220 ? 'green' : m.avg >= 0.300 ? 'red' : '';

  return `<div class="pitcher-matchup-row ${type}" onclick="openPlayerModal(${m.pitcherId},'${(m.pitcherName||'').replace(/'/g,"\\'")}','${m.pitcherTeam}')">
    <div>
      <div class="pitcher-matchup-game">${m.gameInfo} · ${m.gameTime}</div>
      <div class="pitcher-matchup-names">
        <span class="pitcher-matchup-name">${m.pitcherName}</span>
        <span class="pitcher-matchup-vs">vs</span>
        <span class="pitcher-matchup-team">${m.opposingTeam}</span>
      </div>
      <div class="pitcher-matchup-stats">
        <span class="pitcher-matchup-stat">${m.gs} GS</span>
        <span class="pitcher-matchup-stat">· <strong>${m.ab} AB</strong></span>
        <span class="pitcher-matchup-stat">· <strong>${m.h} H</strong></span>
        <span class="pitcher-matchup-stat">· <strong class="${m.hr>=3?'red':''}">${m.hr} HR</strong></span>
        <span class="pitcher-matchup-stat">· <strong>${m.k} K</strong></span>
        <span class="pitcher-matchup-stat">· <strong>${m.bb} BB</strong></span>
        <span class="pitcher-matchup-stat">· AVG <strong class="${avgCls}">${avgStr}</strong></span>
        <span class="pitcher-matchup-stat">· OBP <strong>${(m.obp||0).toFixed(3).replace('0.','.')}</strong></span>
        <span class="pitcher-matchup-stat">· SLG <strong>${(m.slg||0).toFixed(3).replace('0.','.')}</strong></span>
      </div>
    </div>
    <div class="pitcher-matchup-era ${opsCls}">${opsStr}</div>
  </div>`;
}

function renderPitcherMatchupsUI() {
  const filtered = _pitcherMatchupsData.filter(m => m.ab >= _pitcherMinGS);
  // Hot pitcher = low OPS against (dominant), Cold = high OPS against (struggles)
  // Dominant: OPS against ≤ .650 OR AVG against ≤ .220
  // Struggles: OPS against ≥ .850 OR AVG against ≥ .300
  const hot  = filtered.filter(m => m.ops <= 0.650 || m.avg <= 0.220)
                        .filter(m => !(m.ops >= 0.850 || m.avg >= 0.300))
                        .sort((a,b) => a.ops - b.ops).slice(0,20);
  const cold = filtered.filter(m => m.ops >= 0.850 || m.avg >= 0.300)
                        .sort((a,b) => b.ops - a.ops).slice(0,20);
  document.getElementById('hotPitcherContainer').innerHTML  = hot.length  ? hot.map(m=>renderPitcherMatchupRow(m,'hot')).join('')  : '<div class="matchup-loading">No dominant pitcher matchups found.</div>';
  document.getElementById('coldPitcherContainer').innerHTML = cold.length ? cold.map(m=>renderPitcherMatchupRow(m,'cold')).join('') : '<div class="matchup-loading">No struggling pitcher matchups found.</div>';
}

function setPitcherMinGS(n, btn) {
  _pitcherMinGS = n;
  document.querySelectorAll('.matchups-gs-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  renderPitcherMatchupsUI();
}

function switchMatchupsTab(tab, btn) {
  // Update tab buttons
  document.getElementById('matchupsBatterTab').classList.remove('active-batters','active-pitchers');
  document.getElementById('matchupsPitcherTab').classList.remove('active-batters','active-pitchers');
  if (tab === 'batters') {
    btn.classList.add('active-batters');
    document.getElementById('batterMatchupsBody').style.display = '';
    document.getElementById('pitcherMatchupsBody').style.display = 'none';
    document.getElementById('batterFilterBar').style.display = '';
    document.getElementById('pitcherFilterBar').style.display = 'none';
  } else {
    btn.classList.add('active-pitchers');
    document.getElementById('batterMatchupsBody').style.display = 'none';
    document.getElementById('pitcherMatchupsBody').style.display = '';
    document.getElementById('batterFilterBar').style.display = 'none';
    document.getElementById('pitcherFilterBar').style.display = '';
    // Load pitcher data if not loaded yet
    if (!_pitcherMatchupsData.length) {
      document.getElementById('hotPitcherContainer').innerHTML  = '<div class="matchup-loading">Fetching pitcher vs team career data...</div>';
      document.getElementById('coldPitcherContainer').innerHTML = '<div class="matchup-loading">This may take a moment...</div>';
      buildPitcherMatchupsList().then(data => {
        _pitcherMatchupsData = data;
        renderPitcherMatchupsUI();
      });
    } else {
      renderPitcherMatchupsUI();
    }
  }
}
initDashboard();
