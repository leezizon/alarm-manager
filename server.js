'use strict';
// 알람 관리 서버 (Node 14 내장 모듈만 사용)
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { URL } = require('url');
const { Store, StoreError } = require('./store');

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY = 1024 * 1024;

const SEVERITIES = ['critical', 'major', 'minor', 'info'];
const STATUS_LABEL = { open: '발생', ack: '인지', in_progress: '조치중', resolved: '종료' };
const TRANSITIONS = {
  open: ['ack', 'in_progress', 'resolved'],
  ack: ['in_progress', 'resolved'],
  in_progress: ['resolved'],
  resolved: [],
};

const store = new Store(DATA_DIR, { fsync: process.env.FSYNC !== '0' });
const openInfo = store.open();

// ---------- 공통 도우미 ----------
class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size <= MAX_BODY) chunks.push(c);
    });
    req.on('end', () => {
      if (size > MAX_BODY) return reject(new HttpError(413, '요청 본문이 너무 큽니다'));
      if (!size) return resolve({});
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error();
        resolve(v);
      } catch (e) {
        reject(new HttpError(400, 'JSON 형식이 올바르지 않습니다'));
      }
    });
    req.on('error', reject);
  });
}

function getUser(req) {
  const raw = req.headers['x-user'];
  if (raw) {
    try {
      const v = decodeURIComponent(String(raw)).trim().slice(0, 50);
      if (v) return v;
    } catch (e) { /* 잘못 인코딩된 이름은 익명 처리 */ }
  }
  return '익명(' + (req.socket.remoteAddress || '?') + ')';
}

function text(v, field, max, required) {
  if (v === undefined || v === null || v === '') {
    if (required) throw new HttpError(400, `${field}은(는) 필수입니다`);
    return '';
  }
  if (typeof v !== 'string' && typeof v !== 'number') throw new HttpError(400, `${field} 형식이 올바르지 않습니다`);
  const s = String(v).trim();
  if (required && !s) throw new HttpError(400, `${field}은(는) 필수입니다`);
  if (s.length > max) throw new HttpError(400, `${field}은(는) ${max}자 이하여야 합니다`);
  return s;
}

function requireVersion(v) {
  const n = Number(v);
  if (v === undefined || v === null || v === '' || !Number.isInteger(n)) {
    throw new HttpError(400, 'version 값이 필요합니다 (동시 수정 확인용)');
  }
  return n;
}

// ---------- 알람 정의 ----------
function parseDefinition(body) {
  const severity = body.severity || 'major';
  if (!SEVERITIES.includes(severity)) throw new HttpError(400, '등급은 critical/major/minor/info 중 하나여야 합니다');
  return {
    name: text(body.name, '알람명', 100, true),
    system: text(body.system, '대상 시스템', 100, true),
    severity,
    threshold: text(body.threshold, '임계치', 200),
    owner: text(body.owner, '담당자', 100),
    manual: text(body.manual, '조치 매뉴얼', 5000),
    enabled: body.enabled === undefined ? true : Boolean(body.enabled),
  };
}

function assertUniqueName(def, exceptId) {
  const dup = store.list('definitions').find((d) => d.id !== exceptId && d.system === def.system && d.name === def.name);
  if (dup) throw new HttpError(409, `'${def.system}' 시스템에 '${def.name}' 알람이 이미 있습니다`);
}

function activeEventOf(definitionId) {
  return store.list('events').find((e) => e.definitionId === definitionId && e.status !== 'resolved');
}

function listDefinitions(req, res) {
  const items = store.list('definitions').sort((a, b) => a.system.localeCompare(b.system) || a.name.localeCompare(b.name));
  sendJson(res, 200, { items });
}

async function createDefinition(req, res) {
  const def = parseDefinition(await readJson(req));
  // 중복 확인과 저장 사이에 await 가 없으므로 다른 요청이 끼어들 수 없다.
  assertUniqueName(def);
  sendJson(res, 201, store.insert('definitions', def, getUser(req)));
}

async function updateDefinition(req, res, [id]) {
  const body = await readJson(req);
  const version = requireVersion(body.version);
  const def = parseDefinition(body);
  assertUniqueName(def, id);
  sendJson(res, 200, store.update('definitions', id, def, version, getUser(req)));
}

function deleteDefinition(req, res, [id], url) {
  const version = requireVersion(url.searchParams.get('version'));
  if (activeEventOf(id)) throw new HttpError(409, '처리 중인 알람이 있어 삭제할 수 없습니다. 먼저 종료해 주세요');
  store.remove('definitions', id, version, getUser(req));
  sendJson(res, 200, { ok: true });
}

// ---------- 알람 발생 / 처리 ----------
function listEvents(req, res, params, url) {
  const status = url.searchParams.get('status') || 'active';
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '500', 10) || 500, 5000);
  let items = store.list('events');
  if (status === 'active') items = items.filter((e) => e.status !== 'resolved');
  else if (status !== 'all') items = items.filter((e) => e.status === status);
  const key = status === 'resolved' ? 'resolvedAt' : 'lastOccurredAt';
  items.sort((a, b) => (b[key] || '').localeCompare(a[key] || ''));
  sendJson(res, 200, { items: items.slice(0, limit), total: items.length });
}

async function raiseEvent(req, res) {
  const body = await readJson(req);
  const user = getUser(req);
  let def;
  if (body.definitionId) {
    def = store.get('definitions', String(body.definitionId));
  } else if (body.name) {
    const name = String(body.name);
    const system = body.system ? String(body.system) : null;
    def = store.list('definitions').find((d) => d.name === name && (!system || d.system === system));
  } else {
    throw new HttpError(400, 'definitionId 또는 name(알람명)이 필요합니다');
  }
  if (!def) throw new HttpError(404, '알람 정의를 찾을 수 없습니다');
  if (!def.enabled) throw new HttpError(422, '비활성화된 알람입니다');

  const message = text(body.message, '메시지', 1000);
  const source = text(body.source, '발생 위치', 200);
  const now = new Date().toISOString();

  // 같은 알람이 처리 중이면 새로 만들지 않고 횟수만 올린다(중복 억제).
  const active = activeEventOf(def.id);
  if (active) {
    const rec = store.update('events', active.id, {
      count: active.count + 1,
      lastOccurredAt: now,
      message: message || active.message,
      source: source || active.source,
    }, undefined, user);
    return sendJson(res, 200, { deduplicated: true, event: rec });
  }

  const rec = store.insert('events', {
    definitionId: def.id,
    name: def.name,
    system: def.system,
    severity: def.severity,
    message,
    source,
    status: 'open',
    count: 1,
    firstOccurredAt: now,
    lastOccurredAt: now,
    history: [{ at: now, by: user, action: 'open', note: message }],
  }, user);
  sendJson(res, 201, { deduplicated: false, event: rec });
}

async function transitionEvent(req, res, [id]) {
  const body = await readJson(req);
  const version = requireVersion(body.version);
  const user = getUser(req);
  const ev = store.get('events', id);
  if (!ev) throw new HttpError(404, '알람을 찾을 수 없습니다');
  const to = body.status;
  if (!TRANSITIONS[ev.status].includes(to)) {
    throw new HttpError(422, `'${STATUS_LABEL[ev.status]}' 상태에서 '${STATUS_LABEL[to] || to}'(으)로 바꿀 수 없습니다`);
  }
  const note = text(body.note, '메모', 1000);
  const now = new Date().toISOString();
  const patch = { status: to, history: ev.history.concat([{ at: now, by: user, action: to, note }]) };
  if (to === 'ack') { patch.ackAt = now; patch.ackBy = user; }
  if (to === 'resolved') {
    patch.resolvedAt = now;
    patch.resolvedBy = user;
    patch.durationMs = Date.parse(now) - Date.parse(ev.firstOccurredAt);
  }
  sendJson(res, 200, store.update('events', id, patch, version, user));
}

function stats(req, res) {
  const events = store.list('events');
  const active = events.filter((e) => e.status !== 'resolved');
  const bySeverity = { critical: 0, major: 0, minor: 0, info: 0 };
  const byStatus = { open: 0, ack: 0, in_progress: 0 };
  for (const e of active) { bySeverity[e.severity]++; byStatus[e.status]++; }
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const resolvedToday = events.filter((e) => e.resolvedAt && Date.parse(e.resolvedAt) >= startOfDay.getTime());
  const avgResolveMin = resolvedToday.length
    ? Math.round(resolvedToday.reduce((s, e) => s + e.durationMs, 0) / resolvedToday.length / 60000)
    : null;
  sendJson(res, 200, {
    active: active.length, bySeverity, byStatus,
    resolvedToday: resolvedToday.length, avgResolveMin,
    definitions: store.list('definitions').length,
  });
}

function health(req, res) {
  sendJson(res, 200, { ok: true, seq: store.seq, sseClients: sseClients.size });
}

// ---------- 실시간 알림 (Server-Sent Events) ----------
const sseClients = new Set();

function stream(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(': connected\n\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
}

store.onChange((entry) => {
  const msg = `event: change\ndata: ${JSON.stringify({ op: entry.op, col: entry.col, id: entry.id, rec: entry.rec })}\n\n`;
  for (const res of sseClients) res.write(msg);
});

// 연결이 끊기지 않도록 주기적으로 빈 메시지를 보낸다.
setInterval(() => { for (const res of sseClients) res.write(': ping\n\n'); }, 25000).unref();

// ---------- 라우팅 ----------
const routes = [
  ['GET', /^\/api\/health$/, health],
  ['GET', /^\/api\/stats$/, stats],
  ['GET', /^\/api\/stream$/, stream],
  ['GET', /^\/api\/definitions$/, listDefinitions],
  ['POST', /^\/api\/definitions$/, createDefinition],
  ['PUT', /^\/api\/definitions\/([\w-]+)$/, updateDefinition],
  ['DELETE', /^\/api\/definitions\/([\w-]+)$/, deleteDefinition],
  ['GET', /^\/api\/events$/, listEvents],
  ['POST', /^\/api\/events$/, raiseEvent],
  ['POST', /^\/api\/events\/([\w-]+)\/transition$/, transitionEvent],
];

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};

function serveStatic(req, res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname); } catch (e) { rel = ''; }
  const file = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!rel || !file.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 404, { error: '없는 경로입니다' });
  fs.readFile(file, (err, buf) => {
    if (err) return sendJson(res, 404, { error: '없는 경로입니다' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(req.method === 'HEAD' ? undefined : buf);
  });
}

function handleError(res, err) {
  if (res.headersSent) return res.end();
  if (err instanceof HttpError) return sendJson(res, err.status, Object.assign({ error: err.message }, err.extra));
  if (err instanceof StoreError) {
    if (err.code === 'NOT_FOUND') return sendJson(res, 404, { error: err.message });
    if (err.code === 'CONFLICT') {
      return sendJson(res, 409, { error: err.message + '. 화면을 새로 고친 뒤 다시 시도해 주세요', current: err.current });
    }
  }
  console.error(err);
  sendJson(res, 500, { error: '서버 내부 오류' });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) {
      const matched = routes.filter((r) => r[1].test(url.pathname));
      if (!matched.length) throw new HttpError(404, '없는 API입니다');
      const route = matched.find((r) => r[0] === req.method);
      if (!route) throw new HttpError(405, '지원하지 않는 메서드입니다');
      return await route[2](req, res, route[1].exec(url.pathname).slice(1), url);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, '지원하지 않는 메서드입니다');
    serveStatic(req, res, url.pathname);
  } catch (err) {
    handleError(res, err);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`알람 관리 서버 시작 (Node ${process.version})`);
  console.log(`  데이터 폴더: ${DATA_DIR}  (레코드 ${openInfo.records}건, 로그 재적용 ${openInfo.replayed}건)`);
  if (openInfo.droppedPartial) console.log('  ※ 마지막에 잘린 로그 한 줄을 버리고 복구했습니다');
  console.log(`  이 PC:   http://localhost:${PORT}`);
  if (HOST === '0.0.0.0') {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const a of list || []) {
        if (a.family === 'IPv4' && !a.internal) console.log(`  내부망: http://${a.address}:${PORT}`);
      }
    }
  }
});

function shutdown() {
  console.log('종료 중... 스냅샷 저장');
  for (const res of sseClients) res.end();
  server.close();
  store.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
