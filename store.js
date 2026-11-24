'use strict';
// 외부 라이브러리 없이 만든 작은 DB.
// - 모든 데이터는 메모리(Map)에 두고 조회한다.
// - 변경은 changes.log 에 한 줄씩 먼저 기록(fsync)한 뒤 메모리에 반영한다.
// - 일정 건수마다 snapshot.json 으로 전체를 저장하고 로그를 비운다.
// - 쓰기는 이 프로세스 하나에서만 일어나므로(단일 writer) 동시 요청이 섞이지 않는다.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class StoreError extends Error {
  constructor(code, message, current) {
    super(message);
    this.code = code; // 'NOT_FOUND' | 'CONFLICT'
    this.current = current;
  }
}

class Store {
  constructor(dir, options) {
    options = options || {};
    this.dir = dir;
    this.logPath = path.join(dir, 'changes.log');
    this.snapPath = path.join(dir, 'snapshot.json');
    this.snapshotEvery = options.snapshotEvery || 1000;
    this.fsync = options.fsync !== false;
    this.data = new Map(); // 컬렉션 이름 -> Map(id -> 레코드)
    this.seq = 0;
    this.opsSinceSnapshot = 0;
    this.fd = null;
    this.listeners = [];
  }

  open() {
    fs.mkdirSync(this.dir, { recursive: true });

    if (fs.existsSync(this.snapPath)) {
      const snap = JSON.parse(fs.readFileSync(this.snapPath, 'utf8'));
      this.seq = snap.seq;
      for (const col of Object.keys(snap.collections)) {
        const m = this._col(col);
        for (const rec of snap.collections[col]) m.set(rec.id, rec);
      }
    }

    let replayed = 0;
    let droppedPartial = false;
    if (fs.existsSync(this.logPath)) {
      const lines = fs.readFileSync(this.logPath, 'utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i]) continue;
        let entry;
        try {
          entry = JSON.parse(lines[i]);
        } catch (err) {
          // 기록 도중 전원이 꺼지면 마지막 줄만 잘릴 수 있다. 그 경우만 버린다.
          const isLast = lines.slice(i + 1).every((l) => !l);
          if (isLast) { droppedPartial = true; continue; }
          throw new Error(`changes.log ${i + 1}번째 줄이 손상되었습니다`);
        }
        if (entry.seq <= this.seq) continue; // 이미 스냅샷에 들어간 변경
        this._apply(entry);
        this.seq = entry.seq;
        replayed++;
      }
    }

    this.fd = fs.openSync(this.logPath, 'a');
    this.opsSinceSnapshot = replayed;
    // 잘린 줄이 남아 있으면 다음 기록이 그 뒤에 붙어버리므로 바로 스냅샷으로 정리한다.
    if (droppedPartial || replayed >= this.snapshotEvery) this.snapshot();

    let records = 0;
    for (const m of this.data.values()) records += m.size;
    return { records, replayed, droppedPartial };
  }

  close() {
    if (this.fd === null) return;
    this.snapshot();
    fs.closeSync(this.fd);
    this.fd = null;
  }

  onChange(fn) { this.listeners.push(fn); }

  list(col) { return Array.from(this._col(col).values()); }

  get(col, id) { return this._col(col).get(id) || null; }

  insert(col, data, user) {
    const now = new Date().toISOString();
    const rec = Object.assign({}, data, {
      id: crypto.randomUUID(), version: 1, createdAt: now, updatedAt: now, updatedBy: user || null,
    });
    this._commit('insert', col, rec.id, rec, user);
    return rec;
  }

  // expectedVersion 을 주면 낙관적 잠금: 그 사이 다른 사람이 고쳤으면 CONFLICT
  update(col, id, patch, expectedVersion, user) {
    const cur = this._mustGet(col, id, expectedVersion);
    const rec = Object.assign({}, cur, patch, {
      id, version: cur.version + 1, createdAt: cur.createdAt,
      updatedAt: new Date().toISOString(), updatedBy: user || null,
    });
    this._commit('update', col, id, rec, user);
    return rec;
  }

  remove(col, id, expectedVersion, user) {
    this._mustGet(col, id, expectedVersion);
    this._commit('delete', col, id, null, user);
  }

  snapshot() {
    const collections = {};
    for (const [col, m] of this.data) collections[col] = Array.from(m.values());
    const tmp = this.snapPath + '.tmp';
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, JSON.stringify({ seq: this.seq, savedAt: new Date().toISOString(), collections }));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    // rename 은 원자적이라 중간에 꺼져도 옛 스냅샷 또는 새 스냅샷 중 하나가 온전히 남는다.
    fs.renameSync(tmp, this.snapPath);
    // 로그를 비우기 전에 꺼져도, 재시작 시 seq 비교로 중복 적용을 건너뛴다.
    if (this.fd !== null) fs.ftruncateSync(this.fd, 0);
    this.opsSinceSnapshot = 0;
  }

  _mustGet(col, id, expectedVersion) {
    const cur = this.get(col, id);
    if (!cur) throw new StoreError('NOT_FOUND', '대상을 찾을 수 없습니다');
    if (expectedVersion !== undefined && expectedVersion !== cur.version) {
      throw new StoreError('CONFLICT', '다른 사용자가 먼저 수정했습니다', cur);
    }
    return cur;
  }

  _commit(op, col, id, rec, user) {
    const entry = { seq: this.seq + 1, ts: new Date().toISOString(), op, col, id, user: user || null, rec };
    // 디스크 기록이 먼저. 여기서 실패하면 메모리도 바뀌지 않는다.
    fs.appendFileSync(this.fd, JSON.stringify(entry) + '\n');
    if (this.fsync) fs.fsyncSync(this.fd);
    this._apply(entry);
    this.seq = entry.seq;
    this.opsSinceSnapshot++;
    for (const fn of this.listeners) {
      try { fn(entry); } catch (err) { console.error('변경 알림 처리 실패:', err); }
    }
    if (this.opsSinceSnapshot >= this.snapshotEvery) this.snapshot();
  }

  _apply(entry) {
    const m = this._col(entry.col);
    if (entry.op === 'delete') m.delete(entry.id);
    else m.set(entry.id, entry.rec);
  }

  _col(name) {
    let m = this.data.get(name);
    if (!m) { m = new Map(); this.data.set(name, m); }
    return m;
  }
}

module.exports = { Store, StoreError };
