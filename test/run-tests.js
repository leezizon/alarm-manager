'use strict';
// 동시쓰기 / 장애 복구 검증 테스트. 실행: node test/run-tests.js
// 임시 데이터 폴더로 서버를 띄워서 실제 HTTP 요청으로 확인한다.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawn } = require('child_process');

const PORT = parseInt(process.env.TEST_PORT || '3999', 10);
const SERVER = path.join(__dirname, '..', 'server.js');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'alarm-test-'));
const agent = new http.Agent({ maxSockets: 100 });
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function request(method, p, body, user) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: p, method, agent,
      headers: Object.assign({ 'X-User': encodeURIComponent(user || '테스터') },
        data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function start() {
  const child = spawn(process.execPath, [SERVER], {
    env: Object.assign({}, process.env, { PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR }),
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  for (let i = 0; i < 50; i++) {
    try {
      const r = await request('GET', '/api/health');
      if (r.status === 200) return child;
    } catch (e) { /* 아직 시작 전 */ }
    await delay(100);
  }
  child.kill('SIGKILL');
  throw new Error('서버가 시작되지 않았습니다');
}

function stop(child, signal) {
  return new Promise((resolve) => { child.once('exit', resolve); child.kill(signal); });
}

let passed = 0;
let failed = 0;
async function test(name, fn) {
  const t = Date.now();
  try {
    await fn();
    passed++;
    console.log(`  ✔ ${name} (${Date.now() - t}ms)`);
  } catch (err) {
    failed++;
    console.log(`  ✘ ${name}\n      ${err.message}`);
  }
}

const getDefs = async () => (await request('GET', '/api/definitions')).body.items;
const getEvents = async (status) => (await request('GET', '/api/events?status=' + status)).body.items;

async function main() {
  console.log(`Node ${process.version} / 임시 데이터 폴더 ${DATA_DIR}\n`);
  let server = await start();
  let def;

  try {
    await test('알람 정의 생성', async () => {
      const r = await request('POST', '/api/definitions', { name: 'CPU 사용률 높음', system: '결제 API', severity: 'critical' });
      assert.strictEqual(r.status, 201);
      assert.strictEqual(r.body.version, 1);
      def = r.body;
    });

    await test('같은 시스템에 같은 이름 정의는 거절(409)', async () => {
      const r = await request('POST', '/api/definitions', { name: 'CPU 사용률 높음', system: '결제 API' });
      assert.strictEqual(r.status, 409);
    });

    await test('같은 알람 200건 동시 발생 → 알람 1건, 횟수 200', async () => {
      const rs = await Promise.all(Array.from({ length: 200 }, (_, i) =>
        request('POST', '/api/events', { definitionId: def.id, message: `발생 ${i}` })));
      assert.ok(rs.every((r) => r.status === 200 || r.status === 201), '실패한 요청이 있습니다');
      assert.strictEqual(rs.filter((r) => r.status === 201).length, 1, '새 알람은 1건만 만들어져야 합니다');
      const active = await getEvents('active');
      assert.strictEqual(active.length, 1);
      assert.strictEqual(active[0].count, 200);
    });

    await test('서로 다른 정의 100건 동시 생성 → 누락 없이 101건', async () => {
      const rs = await Promise.all(Array.from({ length: 100 }, (_, i) =>
        request('POST', '/api/definitions', { name: `디스크 사용률 ${i}`, system: `서버-${i % 10}` }, `사용자${i}`)));
      assert.ok(rs.every((r) => r.status === 201), '실패한 요청이 있습니다');
      const defs = await getDefs();
      assert.strictEqual(defs.length, 101);
      assert.strictEqual(new Set(defs.map((d) => d.id)).size, 101, 'ID 중복');
    });

    await test('같은 정의를 20명이 동시에 수정 → 1명만 성공, 19명은 충돌(409)', async () => {
      const target = (await getDefs()).find((d) => d.name === '디스크 사용률 0');
      const rs = await Promise.all(Array.from({ length: 20 }, (_, i) =>
        request('PUT', `/api/definitions/${target.id}`,
          { name: target.name, system: target.system, owner: `담당자${i}`, version: target.version }, `사용자${i}`)));
      assert.strictEqual(rs.filter((r) => r.status === 200).length, 1);
      assert.strictEqual(rs.filter((r) => r.status === 409).length, 19);
      const after = (await getDefs()).find((d) => d.id === target.id);
      assert.strictEqual(after.version, 2);
    });

    await test('상태 전이: 발생 → 인지 → 종료, 종료 후 되돌리기는 거절(422)', async () => {
      let ev = (await getEvents('active'))[0];
      let r = await request('POST', `/api/events/${ev.id}/transition`, { status: 'ack', version: ev.version }, '김운영');
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.body.ackBy, '김운영');
      r = await request('POST', `/api/events/${ev.id}/transition`, { status: 'resolved', note: '프로세스 재시작', version: r.body.version });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.body.history.length, 3);
      r = await request('POST', `/api/events/${ev.id}/transition`, { status: 'ack', version: r.body.version });
      assert.strictEqual(r.status, 422);
    });

    await test('강제 종료(전원 차단 상황) 후 재시작 → 데이터 유지', async () => {
      await stop(server, 'SIGKILL');
      server = await start();
      assert.strictEqual((await getDefs()).length, 101);
      const resolved = await getEvents('resolved');
      assert.strictEqual(resolved.length, 1);
      assert.strictEqual(resolved[0].count, 200);
    });

    await test('정상 종료 시 스냅샷 저장, 로그 비움 → 재시작 후 데이터 유지', async () => {
      await stop(server, 'SIGTERM');
      assert.ok(fs.existsSync(path.join(DATA_DIR, 'snapshot.json')));
      assert.strictEqual(fs.statSync(path.join(DATA_DIR, 'changes.log')).size, 0);
      server = await start();
      assert.strictEqual((await getDefs()).length, 101);
    });

    await test('로그 마지막 줄이 쓰다 만 상태여도 복구 후 정상 동작', async () => {
      const r = await request('POST', '/api/definitions', { name: '메모리 부족', system: 'DB' });
      assert.strictEqual(r.status, 201);
      await stop(server, 'SIGKILL');
      fs.appendFileSync(path.join(DATA_DIR, 'changes.log'), '{"seq":99999,"op":"ins');
      server = await start();
      assert.strictEqual((await getDefs()).length, 102);
      const r2 = await request('POST', '/api/definitions', { name: '네트워크 지연', system: 'DB' });
      assert.strictEqual(r2.status, 201);
      await stop(server, 'SIGKILL');
      server = await start();
      assert.strictEqual((await getDefs()).length, 103);
    });
  } finally {
    await stop(server, 'SIGTERM');
    fs.rmdirSync(DATA_DIR, { recursive: true });
  }

  console.log(`\n결과: ${passed}개 통과, ${failed}개 실패`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
