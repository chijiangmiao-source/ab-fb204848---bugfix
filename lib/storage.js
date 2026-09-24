// lib/storage.js
// 浏览器本地持久化层：跨标签页互斥锁 + 意图日志两段提交 + 崩溃恢复 + 断链隔离。
// 仅依赖 lib/chain.js 与注入的 Storage 接口（localStorage 或测试内存实现）。

import {
  GENESIS_DIGEST,
  canonicalContent,
  createBlock,
  findByOpId,
  sameContent,
  verifyChain,
} from './chain.js';

const K_CHAIN = 'irrad.ledger.chain.v1';
const K_ANCHOR = 'irrad.ledger.anchor.v1';
const K_LOCK = 'irrad.ledger.lock.v1';
const K_INTENTS = 'irrad.ledger.intents.v1';
const K_QUARANTINE = 'irrad.ledger.quarantine.v1';
const K_SUFFIX = 'irrad.ledger.suffix.v1';

export const STORAGE_KEYS = {
  K_CHAIN, K_ANCHOR, K_LOCK, K_INTENTS, K_QUARANTINE, K_SUFFIX,
};

const DEFAULT_TIMING = {
  lockTtlMs: 2500,
  heartbeatMs: 600,
  stabilizeMs: 40,
  pollMs: 80,
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomToken() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `tok-${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

function readJson(storage, key, fallback) {
  const raw = storage.getItem(key);
  if (raw === null || raw === undefined) return fallback;
  return JSON.parse(raw);
}

function safeAnchor(storage) {
  try {
    return readJson(storage, K_ANCHOR, null);
  } catch {
    return null;
  }
}

/** 终态冻结标记：已完成的隔离，只有结论，不再携带计划数据。 */
function isValidQuarantine(marker) {
  return Boolean(marker)
    && typeof marker === 'object'
    && !Array.isArray(marker)
    && Number.isSafeInteger(marker.firstBadSeq)
    && marker.firstBadSeq >= 1
    && typeof marker.reason === 'string'
    && marker.phase !== 'isolating';
}

/**
 * “隔离中”计划标记：隔离是崩溃安全的状态机，第一步就把完整裁决落盘：
 * snapshot 为发现损坏时的完整链（含坏后缀），prefixLength 为可信前缀切点。
 * 任一步骤被打断后，仅凭该计划就能幂等续作出同一结果，不依赖当时的主链内容。
 */
function isIsolatingPlan(marker) {
  if (!marker
    || typeof marker !== 'object'
    || Array.isArray(marker)
    || marker.phase !== 'isolating'
    || !Number.isSafeInteger(marker.firstBadSeq)
    || marker.firstBadSeq < 1
    || typeof marker.reason !== 'string'
    || !Array.isArray(marker.snapshot)
    || !Number.isSafeInteger(marker.prefixLength)
    || marker.prefixLength < 0
    || marker.prefixLength > marker.snapshot.length) {
    return false;
  }
  const expectedHead = marker.prefixLength
    ? marker.snapshot[marker.prefixLength - 1]
    : null;
  const head = marker.trustedHead;
  if (expectedHead) {
    return head && head.seq === expectedHead.seq && head.digest === expectedHead.digest;
  }
  return head === null;
}

/** 按隔离计划投影出最终视图：主表只含可信前缀，后缀完整保留在隔离区。 */
function projectPlan(marker) {
  const chain = marker.snapshot.slice(0, marker.prefixLength);
  const suffix = marker.snapshot.slice(marker.prefixLength);
  return { chain, suffix, head: marker.trustedHead || null };
}

export class LedgerError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
    this.details = details;
  }
}

export class LedgerStorage {
  /**
   * @param {object} opts
   * @param {Storage} opts.storage   localStorage 兼容对象
   * @param {string} opts.peerId     标签页标识
   * @param {Function} [opts.onExternalChange] 其它标签页落库 / 状态变化后的回调
   * @param {object} [opts.timing]   注入的锁时序（测试用）
   * @param {Function} [opts.now]
   */
  constructor(opts = {}) {
    const { storage, peerId, onExternalChange, timing, now } = opts;
    if (!storage) throw new Error('缺少 storage');
    if (!peerId) throw new Error('缺少 peerId');
    this.storage = storage;
    this.peerId = peerId;
    this.onExternalChange = onExternalChange || (() => {});
    this.timing = { ...DEFAULT_TIMING, ...(timing || {}) };
    this.now = now || (() => Date.now());

    this._token = null;
    this._heartbeat = null;
    this._dead = false;
    this._callMutex = Promise.resolve();
    this._snapshot = null;
    this._watcher = null;
    // 测试钩子：在某次落盘写完成后返回 'die' 可模拟标签页当场崩溃关闭。
    this.onAfterWrite = opts.onAfterWrite || null;
  }

  // ---------- 读视图 ----------

  /** 不加锁读取当前持久化状态（只读，供视图刷新与监听使用）。 */
  readState() {
    let rawMarker = null;
    if (this.storage.getItem(K_QUARANTINE)) {
      try {
        rawMarker = readJson(this.storage, K_QUARANTINE, null);
      } catch {
        rawMarker = null; // 标记损坏：_reconcile 持锁重建
      }
    }

    if (isIsolatingPlan(rawMarker)) {
      // 隔离可能在任一步骤被打断：即使主链尚未截断、后缀尚未落库，
      // 视图也必须投影计划的最终结果，绝不能把坏后缀留在主表展示。
      const { chain, suffix, head } = projectPlan(rawMarker);
      return {
        status: 'frozen',
        chain,
        suffix,
        quarantine: {
          firstBadSeq: rawMarker.firstBadSeq,
          reason: rawMarker.reason,
          at: rawMarker.at,
          trustedHead: head,
        },
        anchor: safeAnchor(this.storage),
        head,
        nextSeq: (head ? head.seq : 0) + 1,
        prevDigest: head ? head.digest : GENESIS_DIGEST,
      };
    }

    if (isValidQuarantine(rawMarker)) {
      let chain = [];
      try { chain = readJson(this.storage, K_CHAIN, []); } catch { chain = []; }
      let suffix = [];
      try { suffix = readJson(this.storage, K_SUFFIX, []); } catch { suffix = []; }
      return {
        status: 'frozen',
        chain,
        suffix,
        quarantine: rawMarker,
        anchor: safeAnchor(this.storage),
        head: rawMarker.trustedHead || null,
        nextSeq: (rawMarker.trustedHead ? rawMarker.trustedHead.seq : 0) + 1,
        prevDigest: rawMarker.trustedHead ? rawMarker.trustedHead.digest : GENESIS_DIGEST,
      };
    }
    let chain;
    try {
      chain = readJson(this.storage, K_CHAIN, []);
      if (!Array.isArray(chain)) throw new Error('chain 不是数组');
    } catch {
      // 存储层损坏、尚未被 _reconcile 冻结前：按不可读处理，禁止据此追加。
      return {
        status: 'unreadable',
        chain: [],
        suffix: [],
        quarantine: null,
        anchor: safeAnchor(this.storage),
        head: null,
        nextSeq: 1,
        prevDigest: GENESIS_DIGEST,
      };
    }
    const head = chain.length ? chain[chain.length - 1] : null;
    return {
      status: 'ready',
      chain,
      suffix: [],
      quarantine: null,
      anchor: safeAnchor(this.storage),
      head,
      nextSeq: chain.length + 1,
      prevDigest: head ? head.digest : GENESIS_DIGEST,
    };
  }

  getSnapshot() {
    return this._snapshot;
  }

  /** 启动：监听外部变化并做一次带裁决的复算。 */
  async start() {
    if (typeof this.storage.addListener === 'function') {
      this._watcher = (event) => this._handleStorageEvent(event);
      this.storage.addListener(this._watcher);
    } else if (typeof addEventListener === 'function') {
      this._watcher = (event) => this._handleStorageEvent(event);
      addEventListener('storage', this._watcher);
    }
    await this._exclusive(async () => {
      await this._reconcile();
    });
    this._snapshot = this.readState();
    return this._snapshot;
  }

  stop() {
    if (this._watcher) {
      if (typeof this.storage.removeListener === 'function') {
        this.storage.removeListener(this._watcher);
      } else if (typeof removeEventListener === 'function') {
        removeEventListener('storage', this._watcher);
      }
      this._watcher = null;
    }
    if (this._heartbeat) clearInterval(this._heartbeat);
  }

  _handleStorageEvent(event) {
    const watched = [K_CHAIN, K_ANCHOR, K_QUARANTINE, K_SUFFIX, K_INTENTS];
    if (!event || !watched.includes(event.key)) return;
    // 仅刷新视图；冻结裁决交给串行队列，避免与持锁提交者抢写。
    this._snapshot = this.readState();
    if (event.key === K_CHAIN || event.key === K_ANCHOR || event.key === K_QUARANTINE) {
      this._callMutex = this._callMutex
        .then(() => this._detectAndFreeze())
        .catch(() => {})
        .then(() => this.onExternalChange(this._snapshot));
    } else {
      this.onExternalChange(this._snapshot);
    }
  }

  // ---------- 对外提交 ----------

  /**
   * 幂等提交：
   *  - 同一 opId + 同内容（规范化后）-> 返回原记录 {reused:true}，链头不变
   *  - 同一 opId + 异内容         -> 稳定拒绝 OPID_CONFLICT，链头不变
   *  - 断链冻结                   -> FROZEN，链头不变
   */
  async submit(input) {
    return this._serialize(() => this._submitInner(input));
  }

  /** 主动从创世记录复算一次；发现损坏即隔离后缀并冻结。 */
  async reverify() {
    return this._serialize(() => this._exclusive(async () => {
      await this._reconcile();
      this._snapshot = this.readState();
      return this._snapshot;
    }));
  }

  _serialize(task) {
    const run = this._callMutex.then(() => task());
    // 队列本身不因单个任务失败而断裂
    this._callMutex = run.then(() => {}, () => {});
    return run;
  }

  async _submitInner(input) {
    let content;
    try {
      content = JSON.parse(canonicalContent(input));
    } catch (err) {
      throw new LedgerError('VALIDATION', err.message);
    }

    return this._exclusive(async () => {
      await this._reconcile();
      const state = this.readState();
      if (state.status === 'frozen') {
        throw new LedgerError('FROZEN', '见证台账已断链冻结，禁止继续追加', {
          firstBadSeq: state.quarantine.firstBadSeq,
        });
      }
      if (state.status === 'unreadable') {
        throw new LedgerError('STORAGE_UNREADABLE', '本地持久化数据无法读取，请先复算隔离后再操作');
      }

      const existing = findByOpId(state.chain, content.opId);
      if (existing) {
        if (sameContent(existing, content)) {
          this._snapshot = state;
          return { block: existing, reused: true };
        }
        throw new LedgerError('OPID_CONFLICT', '同一操作标识提交了不同业务内容', {
          opId: content.opId,
          existing,
        });
      }

      const seq = state.chain.length + 1;
      const prevDigest = state.prevDigest;
      const intent = {
        id: randomToken(),
        peerId: this.peerId,
        at: this.now(),
        opId: content.opId,
        content,
        seq,
        prevDigest,
      };
      const intents = readJson(this.storage, K_INTENTS, []);
      intents.push(intent);
      this._guardedSet(K_INTENTS, JSON.stringify(intents));

      const block = await createBlock(seq, prevDigest, content);

      // 出块期间若锁被判死抢占，立刻中止：本次落盘窗口由新持锁者恢复裁决。
      this._assertLocked();
      const chain = readJson(this.storage, K_CHAIN, []);
      if (chain.length !== seq - 1) {
        throw new LedgerError('RETRY', '链长度在提交窗口内发生变化，请重试');
      }
      chain.push(block);
      this._guardedSet(K_CHAIN, JSON.stringify(chain));
      this._assertLocked();
      this._guardedSet(K_ANCHOR, JSON.stringify({ seq: block.seq, digest: block.digest }));

      this._removeIntent(intent.id);
      this._snapshot = this.readState();
      return { block, reused: false };
    });
  }

  // ---------- 锁与恢复（持锁区间） ----------

  async _exclusive(task) {
    await this._acquireLock();
    try {
      return await task();
    } finally {
      await this._releaseLock();
    }
  }

  async _acquireLock() {
    const token = randomToken();
    for (;;) {
      await this._waitForLockRelease();
      this.storage.setItem(K_LOCK, JSON.stringify({
        peerId: this.peerId, token, at: this.now(),
      }));
      // 稳定窗口：等待其它进程上的竞争写入落地后再确认自己是最终持有者。
      await sleep(this.timing.stabilizeMs);
      let cur = null;
      try {
        cur = readJson(this.storage, K_LOCK, null);
      } catch {
        cur = null;
      }
      if (cur && cur.token === token) {
        this._token = token;
        this._startHeartbeat();
        return;
      }
      // 竞争失败：随机退避后重夺，避免两个标签页在稳定窗口上活锁。
      await sleep(this.timing.stabilizeMs + Math.floor(Math.random() * this.timing.stabilizeMs * 3) + 1);
    }
  }

  _waitForLockRelease() {
    return new Promise((resolve) => {
      const isFree = () => {
        let cur = null;
        try {
          cur = readJson(this.storage, K_LOCK, null);
        } catch {
          cur = null;
        }
        if (!cur) return true;
        return this.now() - Number(cur.at || 0) > this.timing.lockTtlMs;
      };
      if (isFree()) {
        resolve();
        return;
      }
      const timer = setInterval(() => {
        if (isFree()) {
          clearInterval(timer);
          if (typeof this.storage.removeListener === 'function') {
            this.storage.removeListener(onLock);
          } else if (typeof removeEventListener === 'function') {
            removeEventListener('storage', onLock);
          }
          resolve();
        }
      }, this.timing.pollMs);
      const onLock = (event) => {
        if (event.key === K_LOCK && isFree()) {
          clearInterval(timer);
          if (typeof this.storage.removeListener === 'function') {
            this.storage.removeListener(onLock);
          } else if (typeof removeEventListener === 'function') {
            removeEventListener('storage', onLock);
          }
          resolve();
        }
      };
      if (typeof this.storage.addListener === 'function') {
        this.storage.addListener(onLock);
      } else if (typeof addEventListener === 'function') {
        addEventListener('storage', onLock);
      }
    });
  }

  _startHeartbeat() {
    if (this._heartbeat) clearInterval(this._heartbeat);
    this._heartbeat = setInterval(() => {
      let cur = null;
      try {
        cur = readJson(this.storage, K_LOCK, null);
      } catch {
        cur = null;
      }
      if (!cur || cur.token !== this._token) {
        this._token = null;
        clearInterval(this._heartbeat);
        this._heartbeat = null;
        return;
      }
      this.storage.setItem(K_LOCK, JSON.stringify({
        peerId: this.peerId, token: this._token, at: this.now(),
      }));
    }, this.timing.heartbeatMs);
  }

  _maybeDie(info) {
    if (!this.onAfterWrite || this._dead) return;
    const verdict = this.onAfterWrite(info);
    if (verdict !== 'die') return;
    // 模拟标签页当场关闭：停止心跳，锁只能靠 TTL 失效；本实例拒绝后续操作。
    this._dead = true;
    if (this._heartbeat) {
      clearInterval(this._heartbeat);
      this._heartbeat = null;
    }
    this._token = null;
    throw new LedgerError('TAB_CLOSED', '标签页已在写入窗口中关闭（模拟）');
  }

  _assertLocked() {
    if (this._dead) {
      throw new LedgerError('TAB_CLOSED', '标签页已关闭（模拟）');
    }
    let cur = null;
    try {
      cur = readJson(this.storage, K_LOCK, null);
    } catch {
      cur = null;
    }
    if (!cur || cur.token !== this._token) {
      throw new LedgerError('LOCK_LOST', '持锁在提交窗口内丢失，本次写入已放弃');
    }
  }

  _guardedSet(key, value) {
    this._assertLocked();
    this.storage.setItem(key, value);
    this._maybeDie({ op: 'setItem', key });
  }

  async _releaseLock() {
    if (this._heartbeat) {
      clearInterval(this._heartbeat);
      this._heartbeat = null;
    }
    let cur = null;
    try {
      cur = readJson(this.storage, K_LOCK, null);
    } catch {
      cur = null;
    }
    if (cur && cur.token === this._token) {
      this.storage.removeItem(K_LOCK);
    }
    this._token = null;
  }

  _removeIntent(intentId) {
    const intents = readJson(this.storage, K_INTENTS, []).filter((i) => i.id !== intentId);
    this._guardedSet(K_INTENTS, JSON.stringify(intents));
  }

  /**
   * 持锁状态下的恢复与裁决，必须幂等：
   *  1. 已冻结 -> 保持冻结
   *  2. 全链复算 -> 异常则定位首个坏序号、隔离后缀、冻结
   *  3. 清理/认领孤儿意图（上次持锁者崩溃的唯一痕迹）
   */
  async _reconcile() {
    if (this.storage.getItem(K_QUARANTINE)) {
      let marker = null;
      try {
        marker = readJson(this.storage, K_QUARANTINE, null);
      } catch {
        marker = null;
      }

      if (isIsolatingPlan(marker)) {
        // 上次隔离在某个持久化边界被打断：仅凭计划幂等续作，
        // 主链当前内容不影响结果（计划自带损坏链的完整快照）。
        this._resumeIsolation(marker);
        this._snapshot = this.readState();
        return;
      }

      if (isValidQuarantine(marker)) {
        this._snapshot = this.readState();
        return;
      }

      // 标记无法解析或字段不完整（损坏，或旧版本遗留的无计划“隔离中”标记）：
      // 绝不能据此自动解冻。有隔离后缀副本则按可信前缀重建终态；
      // 后缀为空则移除标记，交全链复算重新裁决（会再次发现损坏并隔离）。
      let suffix = [];
      try {
        suffix = readJson(this.storage, K_SUFFIX, []);
      } catch {
        suffix = [];
      }
      let prefix = [];
      try {
        prefix = readJson(this.storage, K_CHAIN, []);
        if (!Array.isArray(prefix)) prefix = [];
      } catch {
        prefix = [];
      }
      if (Array.isArray(suffix) && suffix.length) {
        // 用“可信前缀 + 隔离后缀副本”重建快照后，走同一套崩溃安全状态机，
        // 宁可重新隔离也绝不放出坏记录、绝不丢失后缀。
        this._beginIsolation({
          chain: [...prefix, ...suffix],
          firstBadSeq: prefix.length + 1,
          reason: 'quarantine-rebuilt',
        });
        this._snapshot = this.readState();
        return;
      }
      // 后缀为空且标记不可解析：移除标记，交由全链复算重新裁决。
      this.storage.removeItem(K_QUARANTINE);
    }

    let chain;
    let anchor;
    try {
      chain = readJson(this.storage, K_CHAIN, []);
    } catch {
      // 链序列化层损坏：没有任何记录可通过复算，冻结在第 1 号。
      // 走同一套崩溃安全状态机（快照为空，坏后缀为空）。
      this._beginIsolation({ chain: [], firstBadSeq: 1, reason: 'storage-corrupt' });
      this._snapshot = this.readState();
      return;
    }
    try {
      anchor = readJson(this.storage, K_ANCHOR, null);
    } catch {
      // 锚点序列化层损坏：链上记录全部保留为可信前缀，冻结在下一序号，
      // 同样走崩溃安全状态机（坏后缀为空）。
      this._beginIsolation({
        chain,
        firstBadSeq: chain.length + 1,
        reason: 'anchor-corrupt',
      });
      this._snapshot = this.readState();
      return;
    }
    const result = await verifyChain(chain, anchor);

    if (!result.ok) {
      if (result.reason === 'anchor-behind' && anchor
        && chain.length - anchor.seq === 1
        && chain[anchor.seq - 1]
        && anchor.digest === chain[anchor.seq - 1].digest) {
        // 唯一合法的在途窗口：记录已落库、锚点未推进（锁保证至多落后 1 条），
        // 且锚点指向的记录摘要一致。补推进，记录完整有效。
        const head = chain[chain.length - 1];
        this._guardedSet(K_ANCHOR, JSON.stringify({ seq: head.seq, digest: head.digest }));
        this._resolveIntents();
        this._snapshot = this.readState();
        return;
      }
      this._quarantine(chain, result);
      this._snapshot = this.readState();
      return;
    }

    this._resolveIntents();

    // 链已从创世逐条复算通过：把链头锚点对齐到真实链头。
    // 覆盖“记录已落库、锚点未推进/未写”的崩溃窗口，也恢复尾部缺失检测能力。
    const head = chain.length ? chain[chain.length - 1] : null;
    const aligned = head ? { seq: head.seq, digest: head.digest } : null;
    if (JSON.stringify(aligned) !== JSON.stringify(anchor)) {
      if (aligned) {
        this._guardedSet(K_ANCHOR, JSON.stringify(aligned));
      } else {
        this.storage.removeItem(K_ANCHOR);
      }
    }
    this._snapshot = this.readState();
  }

  /**
   * 孤儿意图裁决（持锁、链已复算通过）：
   * 能持锁说明没有任何标签页正在提交。意图日志里剩下的只能是
   * 上次持锁者在两步窗口内崩溃留下的痕迹：
   *  - 槽位上存在同 opId 同内容记录 -> 已完整提交，丢弃意图
   *  - 否则 -> 记录从未落库，按“完全无记录”回滚，丢弃意图。
   *    半截链内容若存在，verifyChain 已在前面冻结隔离，不会走到这里。
   * 用户若重试，submit 会按当前链头重新出块或返回已存在的原记录。
   */
  _resolveIntents() {
    // 能持锁说明没有在途提交。意图键里若还有内容，只可能是崩溃残留：
    // 对应槽位记录已验证（完整提交）或不存在（完全无记录），两种结论都无需
    // 意图继续存在，清空即可。没有意图时不产生写入。
    const intents = readJson(this.storage, K_INTENTS, []);
    if (!intents.length) return;
    this._guardedSet(K_INTENTS, JSON.stringify([]));
  }

  /**
   * 断链隔离入口：把全链复算的裁决交给崩溃安全的状态机。
   */
  _quarantine(chain, result) {
    this._beginIsolation({
      chain,
      firstBadSeq: result.firstBadSeq,
      reason: result.reason,
    });
  }

  /**
   * 启动隔离（崩溃安全的状态机，每个边界都是幂等写）：
   *   P0 写隔离计划：含发现损坏时的完整链快照与可信前缀切点，此后任何时刻
   *      崩溃都能仅凭计划续作，不依赖当时主链的内容；
   *   P1 坏后缀完整落盘 K_SUFFIX（先于主链截断，绝不丢失原始坏后缀）；
   *   P2 主链截断为可信前缀；
   *   P3 清空在途意图；
   *   P4 计划改写为终态冻结标记 —— 最后一步即提交点：标记一旦成为终态，
   *      其余所有写入必然已完成，重开看到终态即可直接保持冻结。
   * 任一步后标签页关闭，重开时 _reconcile 发现计划即从该步续作，
   * 最终持久化结果与一次完成完全一致。
   */
  _beginIsolation({ chain, firstBadSeq, reason }) {
    const prefixLength = Math.max(0, firstBadSeq - 1);
    const trustedHead = prefixLength ? chain[prefixLength - 1] : null;
    const plan = {
      phase: 'isolating',
      firstBadSeq,
      reason,
      at: this.now(),
      trustedHead,
      prefixLength,
      snapshot: chain,
    };
    // P0：计划先落盘（自带完整快照）。
    this._guardedSet(K_QUARANTINE, JSON.stringify(plan));
    this._resumeIsolation(plan);
  }

  /** 按计划幂等续作剩余步骤；计划不可变，重复执行得到同一终态。 */
  _resumeIsolation(plan) {
    const { chain: prefix, suffix } = projectPlan(plan);
    // P1：坏后缀先完整落盘。
    this._guardedSet(K_SUFFIX, JSON.stringify(suffix));
    // P2：主表截断为可信前缀。
    this._guardedSet(K_CHAIN, JSON.stringify(prefix));
    // P3：冻结后不再可能有合法在途意图。
    this._guardedSet(K_INTENTS, JSON.stringify([]));
    // P4：提交点 —— 计划改写为终态冻结标记（去掉快照，隔离完成）。
    this._guardedSet(K_QUARANTINE, JSON.stringify({
      firstBadSeq: plan.firstBadSeq,
      reason: plan.reason,
      at: plan.at,
      trustedHead: plan.trustedHead,
    }));
  }

  async _detectAndFreeze() {
    // 事件驱动的检测：终态冻结无需再抢锁；隔离中计划或损坏标记则持锁接管，
    // 把上次持锁者（可能已关闭）未完成的隔离幂等续作到终态。
    let marker = null;
    try {
      marker = readJson(this.storage, K_QUARANTINE, null);
    } catch {
      marker = null;
    }
    if (isValidQuarantine(marker)) {
      this._snapshot = this.readState();
      return;
    }
    await this._exclusive(async () => {
      await this._reconcile();
    });
    this._snapshot = this.readState();
  }
}
