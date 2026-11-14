// Standalone rating-card server — Node standard library only, no dependencies, no build step.
// Serves public/ and a JSON API backed by ./houses.json on disk.
// Run: node server.js   (env: PORT, HOST, HOUSES_FILE)
// Access: http://<VPS-IP>:3000  (no domain, no HTTPS by design for the simplest IP deployment)

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const HOUSES_FILE = process.env.HOUSES_FILE || path.join(__dirname, 'houses.json');
const ADD_REQUESTS_FILE = process.env.ADD_REQUESTS_FILE || path.join(__dirname, 'add-requests.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

const STATUSES = ['保留', '排除', '售出/下架/过期', '新增', '新盘'];
// 售出/下架/过期：挂牌已不在市（Sold / Terminated / Expired / Pending 的合一状态，Pending 自 2026-10-28 起归入此类）。
// 与排除不同：它不强制 rating=1、不清备注/看房记录，只表示这套已不可选；
// 小区颜色计算时忽略它的评分，避免一套已售出的 6 分还让小区保持绿色。
// 新增：新抓取进卡、还没筛选的房子。未评分、不能直接打分，须先改成
// 保留（再走看房、评分）或排除；小区颜色不受它影响（评分本来就是空）。
// 新盘：开发商新盘/预售项目，单独分类（2026-10-31 所有者要求）。规则同新增：
// 在新盘状态下不能打分，须先改成保留或排除；已有评分保留但不计入小区颜色。
const EXCLUSION_REASONS = ['中间户型', '小区环境（含社区小）', '年代太久', '街角', '路冲', '路边', '朝向', '2房', '2000年前', '早于2015', '其他'];
const MAX_NOTE = 2000;

function readHouses() {
  try {
    const raw = fs.readFileSync(HOUSES_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data.houses)) return data.houses;
    return [];
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

// Atomic write: tmp file + rename, so a crash mid-write does not corrupt houses.json.
function writeHouses(houses) {
  const tmp = HOUSES_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(houses, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, HOUSES_FILE);
}

// Manual add-by-address requests (from the card's 手动加房 box). The server
// itself cannot verify listings: REW/Zolo/Realtor all put this VPS's IP
// behind a Cloudflare check, so verification is done by Muse (the same
// workflow as addresses given in chat) and the result is written back here.
// This file only records the queue: 待核实 -> 已添加 / 查不到 / 已有.
function readAddRequests() {
  try {
    const data = JSON.parse(fs.readFileSync(ADD_REQUESTS_FILE, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

function writeAddRequests(list) {
  const tmp = ADD_REQUESTS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, ADD_REQUESTS_FILE);
}

function normForMatch(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/[\s,\-_./#]+/g, '');
}

// Duplicate check for a typed address: an MLS-looking token matches by MLS;
// otherwise every typed token must appear in the house's address text and a
// shared street number must be present (avoids street-name-only collisions).
function findDuplicateHouse(houses, query) {
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
    const hay = normForMatch([h.address, h.city, h.postalCode].join(' '));
    const addrNumbers = (String(h.address).match(/\d+/g) || []);
    if (!numbers.some((n) => addrNumbers.includes(n))) continue;
    if (tokens.every((t) => hay.includes(normForMatch(t)))) return h;
  }
  return null;
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (urlPath === '/') urlPath = '/index.html';
  // Prevent directory traversal.
  const filePath = path.join(PUBLIC_DIR, path.normalize(urlPath).replace(/^(\.\.[\/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    const ext = path.extname(filePath).toLowerCase();
    // No-cache for page/script/style so a frontend fix reaches the phone
    // without a manual hard refresh; images are still cheap to re-fetch.
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

// Simple password gate (optional, enabled only when env is set).
// Set RATING_CARD_PASSWORD_SHA256 to the SHA-256 hex of the password.
// The plain password is never stored in code or in this repo.
// Session cookie is stateless: "<expiry>.<HMAC-SHA256(expiry)>" keyed by the
// stored password hash, with a 30-day Max-Age. Nothing is kept in server
// memory, so restarting the service no longer logs anyone out (that was
// the old in-memory token design, and it forced a re-login after every
// server.js update). Changing the password invalidates all old cookies.
const crypto = require('crypto');
const PASSWORD_HASH = (process.env.RATING_CARD_PASSWORD_SHA256 || '').trim().toLowerCase();
const HOOK_TOKEN = (process.env.HOOK_TOKEN || '').trim();

const BRIDGE_TOKEN = (process.env.BRIDGE_HOOK_TOKEN || '').trim();
const BRIDGE_DIR = path.join(__dirname, '..', 'discord-bridge');
function bridgeTokenOk(req) {
  const given = String(req.headers['x-bridge-token'] || '');
  try {
    return BRIDGE_TOKEN.length > 0 && given.length === BRIDGE_TOKEN.length &&
      crypto.timingSafeEqual(Buffer.from(given), Buffer.from(BRIDGE_TOKEN));
  } catch (e) { return false; }
}
function readBridgeInbox() {
  try {
    return fs.readFileSync(path.join(BRIDGE_DIR, 'inbox.jsonl'), 'utf-8')
      .split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } })
      .filter(Boolean);
  } catch (e) { return []; }
}
function readBridgeReplied() {
  try { return JSON.parse(fs.readFileSync(path.join(BRIDGE_DIR, 'replied.json'), 'utf-8')); }
  catch (e) { return {}; }
}
const AUTH_ENABLED = /^[0-9a-f]{64}$/.test(PASSWORD_HASH);
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

function signExpiry(exp) {
  return crypto.createHmac('sha256', PASSWORD_HASH).update(String(exp), 'utf8').digest('hex');
}

function makeSessionToken() {
  const exp = Date.now() + SESSION_TTL_MS;
  return `${exp}.${signExpiry(exp)}`;
}

function validSessionToken(token) {
  if (!token || typeof token !== 'string') return false;
  const dot = token.indexOf('.');
  if (dot <= 0) return false;
  const exp = Number(token.slice(0, dot));
  const sig = token.slice(dot + 1);
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  try {
    const expected = signExpiry(exp);
    return sig.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch (e) { return false; }
}

function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function isAuthed(req) {
  if (!AUTH_ENABLED) return true;
  return validSessionToken(parseCookies(req).rating_auth);
}

function loginPage(msg) {
  const note = msg ? `<p style="color:#b91c1c">${msg}</p>` : '';
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>评分卡登录</title></head><body style="font-family:system-ui;padding:40px;max-width:360px;margin:auto"><h1>评分卡</h1>${note}<form method="POST" action="/login"><label>密码：<input type="password" name="password" autofocus style="width:100%;padding:8px;margin:8px 0"></label><button type="submit" style="padding:8px 16px">进入</button></form></body></html>`;
}

async function handleLogin(req, res) {
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 10000) req.destroy(); });
  req.on('end', () => {
    const params = new URLSearchParams(body);
    const pw = params.get('password') || '';
    const hash = crypto.createHash('sha256').update(pw, 'utf8').digest('hex');
    let ok = false;
    try {
      ok = hash.length === PASSWORD_HASH.length &&
        crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(PASSWORD_HASH));
    } catch (e) { ok = false; }
    if (!ok) {
      res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(loginPage('密码不对，请重试。'));
    }
    const token = makeSessionToken();
    res.writeHead(302, {
      'Set-Cookie': `rating_auth=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
      Location: '/',
    });
    res.end();
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;

    if (AUTH_ENABLED && pathname === '/login') {
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(loginPage(''));
      }
      if (req.method === 'POST') return handleLogin(req, res);
      res.writeHead(405); return res.end('Method not allowed');
    }
    if (pathname === '/api/add-requests/pending' && req.method === 'GET') {
      const given = String(req.headers['x-hook-token'] || '');
      let ok = false;
      try {
        ok = HOOK_TOKEN.length > 0 && given.length === HOOK_TOKEN.length &&
          crypto.timingSafeEqual(Buffer.from(given), Buffer.from(HOOK_TOKEN));
      } catch (e) { ok = false; }
      if (!ok) return sendJson(res, 401, { error: 'bad hook token' });
      const pending = readAddRequests().filter((r) => r.status === '待核实').map((r) => ({ id: r.id, query: r.query }));
      return sendJson(res, 200, { pending: pending.length, requests: pending });
    }

    

if (AUTH_ENABLED && !isAuthed(req)) {
      if (pathname.startsWith('/api/')) return sendJson(res, 401, { error: '需要登录' });
      res.writeHead(302, { Location: '/login' });
      return res.end();
    }

    if (pathname === '/api/houses' && req.method === 'GET') {
      return sendJson(res, 200, readHouses());
    }

    if (pathname === '/api/add-requests' && req.method === 'GET') {
      return sendJson(res, 200, readAddRequests());
    }

    if (pathname === '/api/add-requests' && req.method === 'POST') {
      let body;
      try { body = await readBody(req); } catch (e) {
        return sendJson(res, 400, { error: 'invalid JSON body' });
      }
      const query = String(body.query || '').trim();
      if (!query || query.length > 200) {
        return sendJson(res, 400, { error: '地址不能为空（最长 200 字）' });
      }
      const dup = findDuplicateHouse(readHouses(), query);
      if (dup) {
        return sendJson(res, 200, { ok: true, duplicate: { id: dup.id, address: dup.address, city: dup.city, status: dup.status } });
      }
      const requests = readAddRequests();
      const samePending = requests.find((r) => r.status === '待核实' && normForMatch(r.query) === normForMatch(query));
      if (samePending) return sendJson(res, 200, { ok: true, request: samePending, alreadyQueued: true });
      const item = {
        id: 'r' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36),
        query,
        status: '待核实',
        createdAt: new Date().toISOString(),
        houseId: null,
        note: '',
      };
      requests.push(item);
      writeAddRequests(requests);
      return sendJson(res, 200, { ok: true, request: item });
    }

    const m = pathname.match(/^\/api\/houses\/(\d+)$/);
    if (m && req.method === 'POST') {
      const id = Number(m[1]);
      const houses = readHouses();
      const house = houses.find((h) => Number(h.id) === id);
      if (!house) return sendJson(res, 404, { error: 'house not found' });
      let body;
      try { body = await readBody(req); } catch (e) {
        return sendJson(res, 400, { error: 'invalid JSON body' });
      }

      const prevStatus = house.status;

      // Status: 保留 / 排除 / 售出/下架/过期.
      if (body.status !== undefined) {
        if (!STATUSES.includes(body.status)) {
          return sendJson(res, 400, { error: 'status must be 保留, 排除, 售出/下架/过期, 新增 or 新盘' });
        }
        house.status = body.status;
        if (house.status === '排除') {
          // Excluded = rating 1, always.
          house.rating = 1;
          if (body.exclusionReason !== undefined) {
            if (body.exclusionReason !== null && !EXCLUSION_REASONS.includes(body.exclusionReason)) {
              return sendJson(res, 400, { error: 'invalid exclusionReason' });
            }
            house.exclusionReason = body.exclusionReason;
          }
        } else if (house.status === '售出/下架/过期') {
          // Sold/delisted/expired: preserve rating, note and viewed history.
          // It only marks the listing as no longer available; it is not a
          // user exclusion and does not force rating to 1.
        } else if (prevStatus === '排除' && (house.status === '保留' || house.status === '新增' || house.status === '新盘')) {
          // Excluded -> retained/new clears the old 1, unless a new rating is
          // explicitly supplied together with viewed=true below.
          if (body.rating === undefined) house.rating = null;
        }
      }

      // Exclusion reason: only from the list. It must also be changeable
      // AFTER a house is already excluded — the old condition
      // (status !== '排除') silently dropped reason changes on excluded
      // houses, leaving them stuck on the default first reason.
      if (body.exclusionReason !== undefined) {
        if (body.exclusionReason !== null && !EXCLUSION_REASONS.includes(body.exclusionReason)) {
          return sendJson(res, 400, { error: 'invalid exclusionReason' });
        }
        house.exclusionReason = body.exclusionReason;
      }

      // Viewed: boolean. The UI only shows it for retained houses, but the
      // server accepts it so history is not silently erased.
      if (body.viewed !== undefined) {
        if (typeof body.viewed !== 'boolean') {
          return sendJson(res, 400, { error: 'viewed must be boolean' });
        }
        house.viewed = body.viewed;
      }

      // Note: one editable field, max 2000 chars.
      if (body.note !== undefined) {
        if (typeof body.note !== 'string' || body.note.length > MAX_NOTE) {
          return sendJson(res, 400, { error: 'note must be a string up to 2000 chars' });
        }
        house.note = body.note;
      }

      // Rating: final decision after viewing. Unviewed retained houses cannot rate.
      // Sold/delisted/expired houses keep their previous rating; rating
      // changes while in that status are ignored, not applied.
      if (body.rating !== undefined) {
        if (body.rating !== null && (!Number.isInteger(body.rating) || body.rating < 1 || body.rating > 10)) {
          return sendJson(res, 400, { error: 'rating must be an integer 1-10 or null' });
        }
        if (house.status === '排除') {
          house.rating = 1; // excluded is always 1, whatever the client sent
        } else if (house.status === '售出/下架/过期' || house.status === '新增' || house.status === '新盘') {
          // preserve previous rating (sold keeps it; new has none yet)
        } else if (house.status === '保留' && house.viewed !== true && body.rating !== null) {
          return sendJson(res, 400, { error: '未看的保留房不能打分：先把看房改成已看' });
        } else {
          house.rating = body.rating;
        }
      }

      writeHouses(houses);
      return sendJson(res, 200, house);
    }

    if (pathname.startsWith('/api/')) {
      return sendJson(res, 404, { error: 'unknown api route' });
    }
    if (req.method !== 'GET') {
      res.writeHead(405); return res.end('Method not allowed');
    }
    return serveStatic(req, res);
  } catch (err) {
    console.error(err);
    return sendJson(res, 500, { error: 'server error' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`rating-card listening on http://${HOST}:${PORT}  (houses file: ${HOUSES_FILE})`);
});
