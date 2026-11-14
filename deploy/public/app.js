// Rating card frontend — plain JS, no framework, no <select> elements (tap buttons only).
// Community score = highest rating in that community (matches the previous over-5 green rule).
// Gradient, light to deep with rising score:
//   1 palest red, 2 light red-orange, 3 light orange, 4 pale orange-yellow,
//   5 pale yellow-green, 6 light green, 7 medium green, 8 green, 9 deep green, 10 darkest green.
// Unrated = neutral grey. Poor environment = red border only, never covering the fill.

const GRADIENT = {
  1: '#fde8e8', 2: '#fbe3d3', 3: '#fdecc8', 4: '#f9e7b8', 5: '#eef3c2',
  6: '#c6e8b8', 7: '#8fd694', 8: '#4caf50', 9: '#2e7d32', 10: '#1b5e20',
};
const NEUTRAL = '#e5e7eb';
const REASONS = ['中间户型', '小区环境（含社区小）', '年代太久', '街角', '路冲', '路边', '朝向', '2房', '2000年前', '早于2015', '其他'];

let houses = [];
let selectedCommunity = null;
let selectedId = null;
// Status filter restored (was clickable in the earlier card): null = all,
// otherwise 保留 / 排除 / 售出/下架/过期 / 新增 / 新盘. Applies to the house list.
// Property-type filter: null = all, otherwise 双拼 / Townhouse. It works
// together with the status filter, and like it, it narrows the community
// list first (two-level navigation).
let statusFilter = null;
let typeFilter = null;
// Fuzzy search over 门牌/街道/地址/城市/MLS/邮编: searches the whole card
// (ignores the status/type filters), results are a flat cross-community list.
let searchQuery = '';
// Nearby search: geocode a postal code / address, then rank the whole card
// by driving distance from it (OSRM table). Houses carry lat/lon in the data.
let nearbyMode = false;
let nearbyQuery = '';
let nearbyResults = [];
let nearbyNote = '';
// Community map (Leaflet/OSM): one marker per community that matches the
// current status/type filters, at the centroid of its matching houses.
// Google Maps cannot take 100+ pins through a plain link (directions caps
// at ~10 stops and the KML-overlay trick no longer renders), so the map
// lives in the card; each marker popup still links out to Google Maps.
// Marker colour encodes the community's built years (of the filtered
// houses): red = all known years before 2000, blue = all 2000 or later,
// orange = spans both sides, grey = year unknown.
let mapObj = null;
let mapLayer = null;
let mapVisible = false;

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function money(n) {
  if (n == null || n === '') return '—';
  return '$' + Number(n).toLocaleString('en-US');
}

function communityOf(h) {
  return h.community || '未分组';
}

function communities() {
  const map = new Map();
  for (const h of houses) {
    const c = communityOf(h);
    if (!map.has(c)) map.set(c, []);
    map.get(c).push(h);
  }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

function communityScore(list) {
  // Sold/delisted/expired houses do not count toward the community colour,
  // so a sold 6 does not keep its community green. An excluded house's 1
  // is a disposal marker, not a merit score: it still drives the palest
  // red colour, but callers must not present it as a rating.
  const pool = list.filter((h) => h.status !== '售出/下架/过期' && h.status !== '新盘');
  const scored = pool.filter((h) => h.status !== '排除').map((h) => h.rating).filter((r) => Number.isInteger(r));
  if (scored.length) return { score: Math.max(...scored), excludedOnly: false };
  if (pool.some((h) => h.status === '排除')) return { score: 1, excludedOnly: true };
  return { score: null, excludedOnly: false };
}

function communityPoor(list) {
  return list.some((h) => h.poorEnv === true);
}

function clientDuplicate(query) {
  const mlsTok = String(query).toUpperCase().match(/R\d{7}/);
  if (mlsTok) {
    const byMls = houses.find((h) => String(h.mls || '').toUpperCase() === mlsTok[0]);
    if (byMls) return byMls;
  }
  const stop = new Set(['bc', 'canada', 'b', 'c']);
  const tokens = String(query).toLowerCase().split(/[\s,]+/).filter((t) => t && !stop.has(t));
  const numbers = tokens.filter((t) => /^\d+$/.test(t));
  if (!tokens.length || !numbers.length) return null;
  for (const h of houses) {
    const hay = normText([h.address, h.city, h.postalCode].join(' '));
    const addrNumbers = (String(h.address).match(/\d+/g) || []);
    if (!numbers.some((n) => addrNumbers.includes(n))) continue;
    if (tokens.every((t) => hay.includes(normText(t)))) return h;
  }
  return null;
}

function renderAddRequests(list) {
  const el = document.getElementById('add-requests');
  if (!el) return;
  el.innerHTML = '';
  if (!list || !list.length) return;
  const title = document.createElement('p');
  title.className = 'msg';
  title.textContent = '最近提交的核实记录：';
  el.appendChild(title);
  for (const r of list.slice(-8).reverse()) {
    const p = document.createElement('p');
    p.className = 'msg';
    let extra = '';
    if (r.status === '已添加' && r.houseId) extra = `（新 id ${r.houseId}，刷新/等待自动刷新后在“新增”里看）`;
    if (r.note) extra += ` · ${r.note}`;
    p.textContent = `${r.query} —— ${r.status}${extra}`;
    el.appendChild(p);
  }
}

async function refreshData() {
  const [hRes, rRes] = await Promise.all([fetch('/api/houses'), fetch('/api/add-requests')]);
  houses = await hRes.json();
  const requests = await rRes.json();
  renderStats();
  renderTypeFilter();
  renderCommunities();
  renderHouses();
  // Do not rebuild the detail panel while the user is typing a note in it.
  const noteEl = document.getElementById('note');
  if (!(noteEl && document.activeElement === noteEl)) renderDetail();
  renderAddRequests(requests);
}

async function submitAdd() {
  const input = document.getElementById('add-input');
  const msg = document.getElementById('add-msg');
  const btn = document.getElementById('add-btn');
  const q = (input.value || '').trim();
  if (!q) { msg.textContent = '先输入地址，比如 9 181 Ravine Drive, Port Moody，或带门牌的完整地址。'; return; }
  const dup = clientDuplicate(q);
  if (dup) {
    msg.textContent = `VPS 已有这套：${dup.address}，${dup.city}（${dup.status}），已经帮你打开它。`;
    selectedCommunity = communityOf(dup);
    selectedId = dup.id;
    renderCommunities(); renderHouses(); renderDetail();
    return;
  }
  btn.disabled = true;
  msg.textContent = '正在提交核实…';
  try {
    const res = await fetch('/api/add-requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: q }),
    });
    const data = await res.json();
    if (!res.ok) { msg.textContent = data.error || '提交失败，再试一次。'; return; }
    if (data.duplicate) {
      msg.textContent = `VPS 已有这套：${data.duplicate.address}，${data.duplicate.city}（${data.duplicate.status}）。`;
      const h = houses.find((x) => x.id === data.duplicate.id);
      if (h) { selectedCommunity = communityOf(h); selectedId = h.id; renderCommunities(); renderHouses(); renderDetail(); }
      return;
    }
    msg.textContent = data.alreadyQueued
      ? '已收到：这个地址已经在核实队列里了，处理完就会出现在下面的记录里。'
      : '已收到你的加房请求，60 秒内开始核实。按 REW 现挂牌核对（价格/面积/MLS 对上才加，封面图和链接用它自己的），查到就以“新增”加进卡，查不到会在下面的记录里写明。';
    input.value = '';
    await refreshData();
  } catch (e) {
    msg.textContent = '提交失败（网络问题），再试一次。';
  } finally {
    btn.disabled = false;
  }
}

let wired = false;
async function load() {
  if (!wired) {
    wired = true;
    const addBtn = document.getElementById('add-btn');
    if (addBtn) addBtn.addEventListener('click', () => { submitAdd().catch(() => {}); });
    const mapBtn = document.getElementById('map-toggle');
    if (mapBtn) mapBtn.addEventListener('click', () => {
      mapVisible = !mapVisible;
      const wrap = document.getElementById('map-wrap');
      if (wrap) wrap.hidden = !mapVisible;
      mapBtn.textContent = mapVisible ? '收起地图' : '地图';
      if (mapVisible) setTimeout(() => renderMap(), 50);
    });
    const addInput = document.getElementById('add-input');
    if (addInput) addInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submitAdd().catch(() => {}); } });
    // Pick up processed add-requests (and their new houses) while the page stays open.
    setInterval(() => { refreshData().catch(() => {}); }, 60000);
  }
  const input = document.getElementById('search-input');
  if (input) {
    input.addEventListener('input', () => { nearbyMode = false; searchQuery = input.value.trim(); renderHouses(); });
  }
  const nBtn = document.getElementById('nearby-btn');
  if (nBtn) nBtn.addEventListener('click', () => { doNearby().catch(() => {}); });
  const nInput = document.getElementById('nearby-input');
  if (nInput) nInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doNearby().catch(() => {}); } });
  const nClear = document.getElementById('nearby-clear');
  if (nClear) {
    nClear.addEventListener('click', () => {
      clearSearch();
      selectedCommunity = null;
      selectedId = null;
      renderCommunities(); renderHouses(); renderDetail();
    });
  }
  const clearBtn = document.getElementById('search-clear');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      clearSearch();
      selectedCommunity = null;
      selectedId = null;
      renderCommunities(); renderHouses(); renderDetail();
    });
  }
  const res = await fetch('/api/houses');
  houses = await res.json();
  renderStats();
  renderTypeFilter();
  renderCommunities();
  renderHouses();
  renderDetail();
}

function normText(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/[\s,\-_./#]+/g, '');
}

function clearSearch() {
  searchQuery = '';
  nearbyMode = false;
  nearbyResults = [];
  nearbyNote = '';
  const input = document.getElementById('search-input');
  if (input) input.value = '';
  const nInput = document.getElementById('nearby-input');
  if (nInput) nInput.value = '';
}

function haversineKm(aLat, aLon, bLat, bLon) {
  const R = 6371;
  const dLat = (bLat - aLat) * Math.PI / 180;
  const dLon = (bLon - aLon) * Math.PI / 180;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * Math.PI / 180) * Math.cos(bLat * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function matchesSearch(h, query) {
  const hay = normText([h.address, h.label, h.community, h.city, h.mls, h.postalCode, h.status, h.propertyType].join(' '));
  const tokens = String(query).toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return false;
  // Every typed token must appear somewhere in the house text, and spaces /
  // punctuation do not matter, so "181 ravine", "181Ravine" and "R3178552"
  // all match the same house.
  return tokens.every((t) => hay.includes(normText(t)));
}

function matchesFilters(h) {
  return (statusFilter == null || h.status === statusFilter) &&
    (typeFilter == null || h.propertyType === typeFilter);
}

function renderTypeFilter() {
  const el = document.getElementById('type-filter');
  if (!el) return;
  el.innerHTML = '';
  const mk = (label, filter) => {
    const b = document.createElement('button');
    b.textContent = label;
    if (typeFilter === filter) b.classList.add('active');
    b.addEventListener('click', () => {
      typeFilter = filter;
      clearSearch();
      selectedCommunity = null;
      selectedId = null;
      renderTypeFilter(); renderCommunities(); renderHouses(); renderDetail();
    });
    return b;
  };
  const counts = {
    '双拼': houses.filter((h) => h.propertyType === '双拼').length,
    'Townhouse': houses.filter((h) => h.propertyType === 'Townhouse').length,
    '独栋': houses.filter((h) => h.propertyType === '独栋').length,
  };
  el.appendChild(mk(`全部类型 ${houses.length} 套`, null));
  el.appendChild(mk(`双拼 ${counts['双拼']}`, '双拼'));
  el.appendChild(mk(`Townhouse ${counts['Townhouse']}`, 'Townhouse'));
  el.appendChild(mk(`独栋 ${counts['独栋']}`, '独栋'));
}

function renderStats() {
  const total = houses.length;
  const kept = houses.filter((h) => h.status === '保留').length;
  const excluded = houses.filter((h) => h.status === '排除').length;
  const sold = houses.filter((h) => h.status === '售出/下架/过期').length;
  const added = houses.filter((h) => h.status === '新增').length;
  const presale = houses.filter((h) => h.status === '新盘').length;
  const rated = houses.filter((h) => Number.isInteger(h.rating)).length;
  const over5 = houses.filter((h) => Number.isInteger(h.rating) && h.rating > 5).length;
  const viewed = houses.filter((h) => h.viewed === true).length;
  const el = document.getElementById('stats');
  // The five status counts are tap buttons that filter the house list,
  // like the earlier card; the other counts stay as plain text.
  el.innerHTML = '';
  const mk = (label, filter) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.className = 'stat-btn' + (statusFilter === filter ? ' active' : '');
    b.addEventListener('click', () => {
      // Filter resets to the community level: clicking 保留/排除 first
      // shows only the communities that have such houses; the user then
      // taps a community to see its houses. This is why a filter click
      // clears the current community and house selection.
      statusFilter = filter;
      clearSearch();
      selectedCommunity = null;
      selectedId = null;
      renderStats(); renderCommunities(); renderHouses(); renderDetail();
    });
    return b;
  };
  el.appendChild(mk(`共 ${total} 套`, null));
  el.appendChild(mk(`保留 ${kept}`, '保留'));
  el.appendChild(mk(`排除 ${excluded}`, '排除'));
  el.appendChild(mk(`售出/下架/过期 ${sold}`, '售出/下架/过期'));
  el.appendChild(mk(`新增 ${added}`, '新增'));
  el.appendChild(mk(`新盘 ${presale}`, '新盘'));
  const rest = document.createElement('span');
  rest.textContent = ` · 已评分 ${rated} · 超过 5 分 ${over5} · 已看过 ${viewed}`;
  el.appendChild(rest);
}

function renderCommunities() {
  const el = document.getElementById('communities');
  el.innerHTML = '';
  for (const [name, list] of communities()) {
    // With a filter on, only communities that actually contain
    // a house matching all active filters are shown at all.
    const visible = list.filter(matchesFilters);
    if (!visible.length) continue;
    const cs = communityScore(visible);
    const score = cs.score;
    const btn = document.createElement('button');
    btn.textContent = `${name}（${cs.excludedOnly ? '排除' : score == null ? '未评分' : score + '分'}）`;
    btn.style.background = score == null ? NEUTRAL : GRADIENT[score];
    if (communityPoor(visible)) btn.classList.add('poor');
    if (selectedCommunity === name) btn.classList.add('active');
    btn.addEventListener('click', () => {
      clearSearch();
      selectedCommunity = name;
      const filtered = list.filter(matchesFilters);
      const first = filtered.slice().sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || String(a.address).localeCompare(String(b.address)))[0];
      selectedId = first ? first.id : null;
      renderCommunities(); renderHouses(); renderDetail();
    });
    el.appendChild(btn);
  }
  if (mapVisible) renderMap();
}

function gotoCommunity(name) {
  clearSearch();
  selectedCommunity = name;
  const list = houses
    .filter((h) => communityOf(h) === name)
    .filter(matchesFilters)
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || String(a.address).localeCompare(String(b.address)));
  selectedId = list.length ? list[0].id : null;
  renderCommunities(); renderHouses(); renderDetail();
  const t = document.getElementById('houses-title');
  if (t) t.scrollIntoView({ behavior: 'smooth' });
}

function renderMap() {
  if (!mapVisible) return;
  const note = document.getElementById('map-note');
  if (typeof L === 'undefined') {
    if (note) note.textContent = '地图库没有加载出来（网络问题），刷新页面再试。';
    return;
  }
  if (!mapObj) {
    mapObj = L.map('map');
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(mapObj);
    mapLayer = L.layerGroup().addTo(mapObj);
    mapObj.on('popupopen', (e) => {
      const btn = e.popup.getElement() && e.popup.getElement().querySelector('.map-goto');
      if (btn) btn.addEventListener('click', () => gotoCommunity(btn.getAttribute('data-community')));
    });
  }
  mapObj.invalidateSize();
  mapLayer.clearLayers();
  const pts = [];
  let skipped = 0;
  for (const [name, list] of communities()) {
    const visible = list.filter(matchesFilters);
    if (!visible.length) continue;
    const withCoords = visible.filter((h) => typeof h.lat === 'number' && typeof h.lon === 'number');
    if (!withCoords.length) { skipped++; continue; }
    const lat = withCoords.reduce((s, h) => s + h.lat, 0) / withCoords.length;
    const lon = withCoords.reduce((s, h) => s + h.lon, 0) / withCoords.length;
    const years = visible.map((h) => h.builtYear).filter((y) => Number.isInteger(y));
    const allPresale = visible.every((h) => h.status === '新盘');
    let color;
    let ageClass;
    if (allPresale) { color = '#7b1fa2'; ageClass = '新盘项目（开发商在售）'; }
    else if (years.length && Math.max(...years) < 2015) { color = '#d93025'; ageClass = '2015年前小区'; }
    else if (years.length && Math.min(...years) >= 2015) { color = '#1a73e8'; ageClass = '2015年及以后小区'; }
    else if (years.length) { color = '#f29900'; ageClass = '跨 2015 年（新老都有）'; }
    else { color = '#80868b'; ageClass = '年代未知'; }
    const yearText = years.length
      ? (Math.min(...years) === Math.max(...years) ? `${Math.min(...years)} 年` : `${Math.min(...years)}–${Math.max(...years)} 年`)
      : '年代未知';
    const cs = communityScore(visible);
    const score = cs.score;
    const byStatus = {};
    for (const h of visible) byStatus[h.status] = (byStatus[h.status] || 0) + 1;
    const statusText = Object.entries(byStatus).map(([k, v]) => `${k}${v}`).join('、');
    const priced = visible.filter((h) => h.price != null || h.sqft != null);
    const priceHtml = priced.length
      ? `<div class="map-prices"><b>价格</b>${priced.map((h) => {
          const bits = [];
          if (h.price != null) bits.push('$' + Number(h.price).toLocaleString('en-CA'));
          if (h.sqft != null) bits.push(`${h.sqft} 尺`);
          const ppsf = (h.price != null && h.sqft) ? `（$${Math.round(h.price / h.sqft)}/尺）` : '';
          return `<div class="map-price-item">${esc(h.label || h.address)}：${bits.join(' · ')}${ppsf}</div>`;
        }).join('')}</div>`
      : '';
    const noted = visible.filter((h) => h.note && String(h.note).trim());
    const notesHtml = noted.length
      ? `<div class="map-notes"><b>备注</b>${noted.map((h) => `<div class="map-note-item">${esc(h.label || h.address)}：${esc(h.note)}</div>`).join('')}</div>`
      : '';
    // Unified popup template (2026-11-07, Dong): the 安全·环境·灾害 block is
    // always rendered, one line per house, and every line always carries the
    // same three slots — a missing field shows 未核实 instead of the line or
    // the whole block silently vanishing.
    const safetyHtml = `<div class="map-notes"><b>安全·环境·灾害</b>${visible.map((h) => {
        const parts = [
          '治安' + (h.safety || '未核实'),
          h.env || '环境未核实',
          h.hazard || '灾害未核实',
        ];
        return `<div class="map-note-item">${esc(h.label || h.address)}：${esc(parts.join('；'))}</div>`;
      }).join('')}</div>`;
    const buildersSeen = new Map();
    for (const h of visible) if (h.builder && !buildersSeen.has(h.builder)) buildersSeen.set(h.builder, h.builderInfo || '');
    const builderHtml = buildersSeen.size
      ? `<div class="map-notes"><b>建筑商</b>${[...buildersSeen.entries()].map(([b, info]) => `<div class="map-note-item">${esc(b)}${info ? '：' + esc(info) : ''}</div>`).join('')}</div>`
      : '';
    const marker = L.circleMarker([lat, lon], {
      radius: 10, color: '#ffffff', weight: 2, fillColor: color, fillOpacity: 0.9,
    });
    marker.bindPopup(`<div class="map-pop"><b>${esc(name)}</b><br>当前筛选下 ${visible.length} 套（${esc(statusText)}）<br>${allPresale ? esc(ageClass) : `建筑年代：${esc(yearText)} · ${esc(ageClass)}`}<br>小区最高分：${cs.excludedOnly ? '无（房源已排除，1 分是排除标记）' : score == null ? '未评分' : score + ' 分'}${priceHtml}${builderHtml}${notesHtml}${safetyHtml}<br><button type="button" class="map-goto" data-community="${esc(name)}">进入小区 →</button> <a href="https://www.google.com/maps/search/?api=1&query=${lat},${lon}" target="_blank" rel="noopener">谷歌地图 ↗</a></div>`, { maxHeight: 300 });
    marker.addTo(mapLayer);
    pts.push([lat, lon]);
  }
  if (pts.length) mapObj.fitBounds(pts, { padding: [24, 24] });
  if (note) {
    note.textContent = `标注 = 当前状态/类型筛选下的小区，共 ${pts.length} 个${skipped ? `；另有 ${skipped} 个小区没有坐标、未标注` : ''}。紫点 = 新盘项目（开发商在售，弹窗有建筑商背景），红点 = 2015年前小区（该小区房子全部建于 2015 年前），蓝点 = 2015 年及以后，橙点 = 两边都有，灰点 = 年代未知。点标注可直接进入小区，或跳谷歌地图看那个点。`;
  }
}

// Nearby geocoding, layered and validated. The first version trusted the
// first Nominatim hit blindly, and for a postcode OSM does not know
// (e.g. V3B 6M7) it returned a sign in Alberta, producing 1200+ km nonsense.
// Rules now: a result is accepted only if it lands within 60 km of the
// card's area, a postcode result must actually carry that postcode/FSA in
// its name, and the BC Geocoder's known fallback point is rejected.
const CARD_CENTER = { lat: 49.27, lon: -122.82 };
const FSA_CITY = {
  V3B: 'Coquitlam', V3C: 'Port Coquitlam', V3E: 'Coquitlam', V3H: 'Port Moody',
  V3J: 'Coquitlam', V3K: 'Coquitlam', V3L: 'Port Coquitlam', V3M: 'Port Moody',
  V3N: 'Burnaby', V5A: 'Burnaby', V5B: 'Burnaby', V5C: 'Burnaby', V5E: 'Burnaby',
  V5G: 'Burnaby', V5H: 'Burnaby', V5J: 'Burnaby', V5K: 'Vancouver', V7G: 'North Vancouver',
};

function regionOk(lat, lon) {
  return haversineKm(CARD_CENTER.lat, CARD_CENTER.lon, lat, lon) <= 60;
}

async function geocodeNearby(q) {
  const compact = q.replace(/\s+/g, '').toUpperCase();
  const pcMatch = compact.match(/^[A-Z]\d[A-Z]\d[A-Z]\d$/);
  const pc = pcMatch ? pcMatch[0] : null;
  const fsaMatch = compact.match(/^[A-Z]\d[A-Z]$/);
  const fsa = pc ? pc.slice(0, 3) : (fsaMatch ? fsaMatch[0] : null);
  // Layer 0: for a postal code, the card's own verified house
  // coordinates are the most reliable local point source. External
  // geocoders do not know most Canadian postal codes: Nominatim
  // returns nothing for V3J 3W8, and the BC Geocoder fell back to the
  // bare Coquitlam locality point (~8 km east of the real Burquitlam
  // location), which ranked central-Coquitlam houses as "nearby".
  if (pc || fsa) {
    const withCoords = houses.filter((h) => typeof h.lat === 'number' && typeof h.lon === 'number' && h.postalCode);
    const norm = (h) => String(h.postalCode).replace(/\s+/g, '').toUpperCase();
    const centroid = (list) => ({
      lat: list.reduce((s, h) => s + h.lat, 0) / list.length,
      lon: list.reduce((s, h) => s + h.lon, 0) / list.length,
    });
    if (pc) {
      const exact = withCoords.filter((h) => norm(h) === pc);
      if (exact.length) return { ...centroid(exact), label: `邮编 ${pc.slice(0, 3)} ${pc.slice(3)}（按卡上同邮编的 ${exact.length} 套房源定位）`, approx: false };
    }
    const inFsa = withCoords.filter((h) => norm(h).startsWith(fsa));
    if (inFsa.length) return { ...centroid(inFsa), label: `邮编 ${fsa} 区（精确点查不到，按卡上同区 ${inFsa.length} 套房源的中心估算）`, approx: true };
  }
  // Layer 1: Nominatim, validated.
  try {
    const r = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=3&countrycodes=ca&q=' + encodeURIComponent(q + ', BC, Canada'));
    const j = await r.json();
    for (const g of (j || [])) {
      const lat = parseFloat(g.lat);
      const lon = parseFloat(g.lon);
      if (!regionOk(lat, lon)) continue;
      if (pc || fsa) {
        const disp = (g.display_name || '').replace(/\s+/g, '').toUpperCase();
        if (!disp.includes(fsa) && !(pc && disp.includes(pc))) continue;
      }
      const label = (g.display_name || q).split(',').slice(0, 3).join(',');
      return { lat, lon, label, approx: false };
    }
  } catch (e) { /* fall through */ }
  // Layer 2: BC Geocoder (strong for full street addresses; for a postcode
  // add its main city, which yields that city's area point -> approximate).
  try {
    let query = q;
    if ((pc || fsa) && FSA_CITY[fsa]) query = q + ', ' + FSA_CITY[fsa] + ', BC';
    else if (!/B\.?C\.?|British Columbia/i.test(q)) query = q + ', BC';
    const r = await fetch('https://geocoder.api.gov.bc.ca/addresses.geojson?maxResults=3&locationDescriptor=any&addressString=' + encodeURIComponent(query));
    const j = await r.json();
    for (const f of (j.features || [])) {
      const props = f.properties || {};
      const score = props.score || 0;
      const lon = f.geometry.coordinates[0];
      const lat = f.geometry.coordinates[1];
      // BC Geocoder's parse-failure fallback point (Surrey) must never pass.
      if (Math.abs(lat - 49.1002388) < 0.001 && Math.abs(lon + 122.7349695) < 0.001) continue;
      if (!regionOk(lat, lon)) continue;
      if (pc || fsa) {
        // A postal query must land on an address, never on a bare
        // locality point: "Coquitlam, BC" (score 67, no civic number)
        // is what mis-centred the V3J 3W8 search.
        const streetPart = (props.fullAddress || '').split(',')[0];
        if (!/\d/.test(streetPart)) continue;
        if (score >= 60) return { lat, lon, label: props.fullAddress || query, approx: true };
      } else if (score >= 70) {
        return { lat, lon, label: props.fullAddress || query, approx: false };
      }
    }
  } catch (e) { /* fall through */ }
  return null;
}

async function doNearby() {
  const input = document.getElementById('nearby-input');
  const q = (input.value || '').trim();
  if (!q) return;
  searchQuery = '';
  const sInput = document.getElementById('search-input');
  if (sInput) sInput.value = '';
  nearbyMode = true;
  nearbyQuery = q;
  nearbyResults = [];
  nearbyNote = '正在查…';
  renderHouses();
  const origin = await geocodeNearby(q);
  if (!origin) {
    nearbyNote = `没有在本地区找到“${q}”的位置，已停止（不会拿外地的同名结果顶替）。邮编查不到时，加上街道名或直接输入地址再试。`;
    renderHouses();
    return;
  }
  const centerNote = origin.approx
    ? `中心点是大概位置：${origin.label}（这个邮编的精确点查不到，距离是近似的）`
    : `中心点：${origin.label}`;
  const withCoords = houses.filter((h) => typeof h.lat === 'number' && typeof h.lon === 'number');
  try {
    const coords = [[origin.lon, origin.lat]].concat(withCoords.map((h) => [h.lon, h.lat]));
    const t = await fetch('https://router.project-osrm.org/table/v1/driving/' + coords.map((c) => c.join(',')).join(';') + '?sources=0&annotations=distance,duration');
    const tj = await t.json();
    if (!tj || tj.code !== 'Ok') throw new Error('osrm');
    nearbyResults = withCoords.map((h, i) => ({
      h, km: tj.distances[0][i + 1] / 1000, mins: Math.round(tj.durations[0][i + 1] / 60), approx: false,
    })).sort((a, b) => a.km - b.km);
    nearbyNote = centerNote;
  } catch (e) {
    // Route service unavailable: fall back to straight-line distance and say so.
    nearbyResults = withCoords.map((h) => ({
      h, km: haversineKm(origin.lat, origin.lon, h.lat, h.lon), mins: null, approx: true,
    })).sort((a, b) => a.km - b.km);
    nearbyNote = centerNote + '；路线服务暂时不可用，下面是直线距离。';
  }
  renderHouses();
}

function renderHouses() {
  const el = document.getElementById('houses');
  const title = document.getElementById('houses-title');
  el.innerHTML = '';
  // Nearby view: nearest houses to a geocoded postal code / address,
  // ranked by driving distance, flat across communities.
  if (nearbyMode) {
    title.textContent = `周边 — “${nearbyQuery}”`;
    if (nearbyNote && !nearbyResults.length) {
      const p = document.createElement('p');
      p.className = 'msg';
      p.textContent = nearbyNote;
      el.appendChild(p);
      return;
    }
    if (nearbyNote) {
      const p = document.createElement('p');
      p.className = 'msg';
      p.textContent = nearbyNote;
      el.appendChild(p);
    }
    for (const r of nearbyResults.slice(0, 20)) {
      const h = r.h;
      const btn = document.createElement('button');
      const photoMark = h.photoUrl ? ' 📷' : '';
      const soldMark = h.status === '售出/下架/过期' ? ' · 已售出/下架/过期' : '';
      const newMark = h.status === '新增' ? ' · 新增' : '';
      const presaleMark = h.status === '新盘' ? ' · 新盘' : '';
      const distMark = r.approx ? `${r.km.toFixed(1)} 公里（直线）` : `${r.km.toFixed(1)} 公里 · 约 ${r.mins} 分钟`;
      btn.textContent = `${distMark} — ${h.address} · ${h.city}（${h.status}${h.rating != null ? ' ' + h.rating + '分' : ''}）${soldMark}${newMark}${presaleMark}${photoMark}`;
      if (selectedId === h.id) btn.classList.add('active');
      btn.addEventListener('click', () => { selectedCommunity = communityOf(h); selectedId = h.id; renderCommunities(); renderHouses(); renderDetail(); });
      el.appendChild(btn);
    }
    const p2 = document.createElement('p');
    p2.className = 'msg';
    p2.textContent = `显示最近 20 套（全卡共 ${houses.length} 套），按开车距离排；点上面的状态/类型/小区，或“清除”，可退出周边。`;
    el.appendChild(p2);
    return;
  }
  // Search view: a flat cross-community result list, so a 门牌/街道 search
  // finds the house without picking a community first.
  if (searchQuery) {
    title.textContent = `搜索结果 — “${searchQuery}”`;
    const list = houses
      .filter((h) => matchesSearch(h, searchQuery))
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || String(a.address).localeCompare(String(b.address)));
    if (!list.length) {
      const p = document.createElement('p');
      p.className = 'msg';
      p.textContent = `没有找到和“${searchQuery}”对上的房子，换个门牌、街道名或 MLS 号试试，或点“清除”回到全部。`;
      el.appendChild(p);
      return;
    }
    for (const h of list) {
      const btn = document.createElement('button');
      const photoMark = h.photoUrl ? ' 📷' : '';
      const soldMark = h.status === '售出/下架/过期' ? ' · 已售出/下架/过期' : '';
      const newMark = h.status === '新增' ? ' · 新增' : '';
      const presaleMark = h.status === '新盘' ? ' · 新盘' : '';
      btn.textContent = `${h.address} · ${h.city}${h.rating != null ? ' · ' + h.rating + '分' : ''}${soldMark}${newMark}${presaleMark}${photoMark}`;
      if (selectedId === h.id) btn.classList.add('active');
      btn.addEventListener('click', () => { selectedCommunity = communityOf(h); selectedId = h.id; renderCommunities(); renderHouses(); renderDetail(); });
      el.appendChild(btn);
    }
    return;
  }
  // Two-level navigation: a status filter first narrows the community
  // list (see renderCommunities); houses only appear after tapping a
  // community, so there is never a cross-community house list to get
  // stuck in after entering a house.
  if (!selectedCommunity) { title.textContent = '房子'; return; }
  title.textContent = `房子 — ${selectedCommunity}` + (statusFilter ? ` · 只看${statusFilter}` : '') + (typeFilter ? ` · 只看${typeFilter}` : '');
  const list = houses
    .filter((h) => communityOf(h) === selectedCommunity)
    .filter(matchesFilters)
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || String(a.address).localeCompare(String(b.address)));
  if (!list.length) {
    const p = document.createElement('p');
    p.className = 'msg';
    p.textContent = `该小区没有符合筛选的房子，点上面“共 ${houses.length} 套”可回到全部。`;
    el.appendChild(p);
    return;
  }
  for (const h of list) {
    const btn = document.createElement('button');
    const photoMark = h.photoUrl ? ' 📷' : '';
    const soldMark = h.status === '售出/下架/过期' ? ' · 已售出/下架/过期' : '';
    const newMark = h.status === '新增' ? ' · 新增' : '';
    const presaleMark = h.status === '新盘' ? ' · 新盘' : '';
    btn.textContent = `${h.label || h.address}${h.rating != null ? ' · ' + h.rating + '分' : ''}${soldMark}${newMark}${presaleMark}${photoMark}`;
    if (selectedId === h.id) btn.classList.add('active');
    btn.addEventListener('click', () => { selectedId = h.id; renderHouses(); renderDetail(); });
    el.appendChild(btn);
  }
}

async function save(id, patch) {
  const res = await fetch('/api/houses/' + id, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  const data = await res.json();
  if (!res.ok) { alert(data.error || '保存失败'); return false; }
  const idx = houses.findIndex((h) => h.id === id);
  if (idx >= 0) houses[idx] = data;
  return true;
}

function renderDetail() {
  const el = document.getElementById('detail');
  const h = houses.find((x) => x.id === selectedId);
  if (!h) { el.innerHTML = '<p>先选小区，再选房子。</p>'; return; }
  const isRetained = h.status === '保留';
  const isSold = h.status === '售出/下架/过期';
  const isNew = h.status === '新增';
  const isPresale = h.status === '新盘';
  const canRate = isRetained && h.viewed === true;

  let html = '';
  if (h.photoUrl) {
    html += `<a href="${esc(h.photoUrl)}" target="_blank" rel="noopener"><img src="${esc(h.photoUrl)}" alt="${esc(h.address)}"></a>`;
    html += `<p class="msg">${h.photoLabel ? esc(h.photoLabel) : '挂牌照片'} · 点击图片可在新页面放大查看</p>`;
  } else {
    html += '<p class="msg">无照片</p>';
  }
  // Listing link is independent of the photo: it is shown whenever listingUrl exists.
  if (h.listingUrl) {
    html += `<a class="listing" href="${esc(h.listingUrl)}" target="_blank" rel="noopener">打开挂牌页 ↗</a>`;
  } else {
    html += '<p class="msg">无挂牌页链接（未编造）</p>';
  }
  // Google Maps link is generated from the address itself, not from a
  // listing page, so it is always available.
  const mapsQuery = [h.address, h.city, h.postalCode, 'BC'].filter(Boolean).join(', ');
  html += `<a class="listing" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(mapsQuery)}" target="_blank" rel="noopener">打开谷歌地图 ↗</a>`;
  html += `<h3>${esc(h.address)}</h3><dl>
    <dt>价格</dt><dd>${esc(money(h.price))}</dd>
    <dt>面积</dt><dd>${h.sqft != null ? esc(h.sqft) + ' 尺' : '—'}</dd>
    <dt>每尺价格</dt><dd>${h.price != null && h.sqft ? '$' + (h.price / h.sqft).toFixed(2) + '/尺' : '—'}</dd>
    <dt>房数</dt><dd>${h.beds != null ? esc(h.beds) + '房' : '—'}</dd>
    <dt>车位</dt><dd>${h.parking ? esc(h.parking) : '—'}</dd>
    <dt>位置</dt><dd>${esc([h.city, h.postalCode].filter(Boolean).join(' ')) || '—'}</dd>
    <dt>MLS</dt><dd>${esc(h.mls) || '—'}</dd>
    <dt>小区</dt><dd>${esc(communityOf(h))}</dd>
    <dt>类型</dt><dd>${esc(h.propertyType || '—')}</dd>
    <dt>建筑商</dt><dd>${h.builder ? esc(h.builder) : '—'}</dd>${h.builderInfo ? `
    <dt>建筑商背景</dt><dd>${esc(h.builderInfo)}</dd>` : ''}
    <dt>建筑年代</dt><dd>${h.builtYear != null ? esc(h.builtYear) + ' 年' : '—'}</dd>
    <dt>供暖</dt><dd>${h.heating ? esc(h.heating) : '—'}</dd>
    <dt>物业费</dt><dd>${h.strataFee != null ? esc(money(h.strataFee)) + '/月' : '—'}</dd>
    <dt>每尺物业费</dt><dd>${h.strataFee != null && h.sqft ? '$' + (h.strataFee / h.sqft).toFixed(2) + '/尺·月' : '—'}</dd>
    <dt>安全</dt><dd>${h.safety ? esc(h.safety) : '—'}</dd>
    <dt>环境</dt><dd>${h.env ? esc(h.env) : '—'}</dd>
    <dt>灾害</dt><dd>${h.hazard ? esc(h.hazard) : '—'}</dd>
  </dl>`;

  html += `<div class="status-row"><span>决策：</span>
    <button data-status="保留" class="${isRetained ? 'active' : ''}">保留</button>
    <button data-status="排除" class="${h.status === '排除' ? 'active' : ''}">排除</button>
    <button data-status="售出/下架/过期" class="${isSold ? 'active' : ''}">售出/下架/过期</button>
    <button data-status="新增" class="${isNew ? 'active' : ''}">新增</button>
    <button data-status="新盘" class="${isPresale ? 'active' : ''}">新盘</button></div>`;
  if (isSold) {
    html += '<p class="msg">这套已售出/下架/过期，不再可选；原评分和备注保留，只是不计入小区颜色。</p>';
  }
  if (isNew) {
    html += '<p class="msg">这套是新抓取的，还没筛选；先改成保留或排除，保留后才能走看房、评分流程。</p>';
  }
  if (isPresale) {
    html += '<p class="msg">这套是开发商新盘，单独分类；先改成保留或排除，保留后才能走看房、评分流程。</p>';
  }

  if (h.status === '排除') {
    html += `<div class="reason-row"><span>排除原因：</span>
      ${REASONS.map((r) => `<button data-reason="${esc(r)}" class="${h.exclusionReason === r ? 'active' : ''}">${esc(r)}</button>`).join('')}
      <span class="msg">排除 = 1 分</span></div>`;
  }

  if (isRetained) {
    html += `<div class="viewed-row"><span>看房：</span>
      <button data-viewed="false" class="${h.viewed !== true ? 'active' : ''}">未看</button>
      <button data-viewed="true" class="${h.viewed === true ? 'active' : ''}">已看</button></div>`;
  }

  html += `<div><label>备注（一个字段）：</label>
    <textarea id="note">${esc(h.note || '')}</textarea>
    <button id="save-note">保存备注</button></div>`;

  html += `<div class="rating-row"><span>评分（看后最终决策）：</span>
    ${[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) =>
      `<button data-rating="${n}" ${canRate ? '' : 'disabled'} class="${h.rating === n ? 'active' : ''}">${n}</button>`).join('')}
    <button data-rating="clear" ${canRate ? '' : 'disabled'}>清除</button>
    ${canRate ? '' : '<span class="msg">未看的保留房不能打分；排除固定 1 分；售出/下架/过期、新增和新盘不再评分。</span>'}</div>`;

  el.innerHTML = html;

  el.querySelectorAll('[data-status]').forEach((b) => b.addEventListener('click', async () => {
    const status = b.getAttribute('data-status');
    const patch = { status };
    if (status === '排除' && !h.exclusionReason) patch.exclusionReason = REASONS[0];
    if (await save(h.id, patch)) { renderStats(); renderCommunities(); renderHouses(); renderDetail(); }
  }));
  el.querySelectorAll('[data-reason]').forEach((b) => b.addEventListener('click', async () => {
    if (await save(h.id, { exclusionReason: b.getAttribute('data-reason') })) renderDetail();
  }));
  el.querySelectorAll('[data-viewed]').forEach((b) => b.addEventListener('click', async () => {
    if (await save(h.id, { viewed: b.getAttribute('data-viewed') === 'true' })) { renderStats(); renderDetail(); }
  }));
  document.getElementById('save-note').addEventListener('click', async () => {
    await save(h.id, { note: document.getElementById('note').value });
  });
  el.querySelectorAll('[data-rating]').forEach((b) => b.addEventListener('click', async () => {
    const v = b.getAttribute('data-rating');
    const patch = { rating: v === 'clear' ? null : Number(v) };
    if (await save(h.id, patch)) { renderStats(); renderCommunities(); renderHouses(); renderDetail(); }
  }));
}

load().catch((e) => {
  document.getElementById('detail').innerHTML = '<p>载入失败：' + esc(String(e)) + '</p>';
});
