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
    // 单调递增的落盘序号 + 当前所处的隔离步骤（测试钩子据此在精确边界模拟关页）。
    this._writeSeq = 0;
    this._writeBoundary = null;
    // 测试钩子：在某次落盘写完成后返回 'die' 可模拟标签页当场崩溃关闭。
    // info 含 { op, key, writeSeq, boundary }，boundary 标识隔离协议的具体步骤。
    this.onAfterWrite = opts.onAfterWrite || null;
  }

  // ---------- 读视图 ----------

  /** 不加锁读取当前持久化状态（只读，供视图刷新与监听使用）。 */
  readState() {
    let quarantine = null;
    if (this.storage.getItem(K_QUARANTINE)) {
      try {
        quarantine = readJson(this.storage, K_QUARANTINE, null);
      } catch {
        quarantine = null; // 标记损坏：按未冻结处理，_reconcile 会重建
      }
    }
    if (quarantine) {
      let chain = [];
      try { chain = readJson(this.storage, K_CHAIN, []); } catch { chain = []; }
      let suffix = [];
      try { suffix = readJson(this.storage, K_SUFFIX, []); } catch { suffix = []; }
      const isolating = quarantine.phase === 'isolating';
      return {
        // 隔离尚未走完落库协议时不得谎报为已完成冻结；但同样禁止追加。
        status: isolating ? 'isolating' : 'frozen',
        chain,
        suffix,
        quarantine,
        anchor: safeAnchor(this.storage),
        head: quarantine.trustedHead || null,
        nextSeq: (quarantine.trustedHead ? quarantine.trustedHead.seq : 0) + 1,
        prevDigest: quarantine.trustedHead ? quarantine.trustedHead.digest : GENESIS_DIGEST,
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
      if (state.status === 'frozen' || state.status === 'isolating') {
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
    return this._guardedSetAt(key, value, this._writeBoundary);
  }

  _guardedSetAt(key, value, boundary) {
    this._assertLocked();
    this.storage.setItem(key, value);
    this._writeSeq += 1;
    this._maybeDie({ op: 'setItem', key, writeSeq: this._writeSeq, boundary: boundary || null });
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
   *  1. 已完成冻结 -> 保持冻结
   *  2. 冻结标记显示“隔离中” -> 按计划续做隔离（上次隔离在落库窗口中被中断）
   *  3. 冻结标记损坏 -> 依据主链/后缀重建冻结态，绝不自动解冻
   *  4. 全链复算 -> 异常则定位首个坏序号、隔离后缀、冻结
   *  5. 清理/认领孤儿意图（上次持锁者崩溃的唯一痕迹）
   */
  async _reconcile() {
    if (this.storage.getItem(K_QUARANTINE)) {
      let marker = null;
      try {
        marker = readJson(this.storage, K_QUARANTINE, null);
      } catch {
        marker = null;
      }
      if (marker && typeof marker === 'object') {
        if (marker.phase === 'isolating') {
          // 上次隔离在多段落库窗口中被关闭：按计划续做到同一结果。
          this._resumeIsolation(marker);
          this._snapshot = this.readState();
          return;
        }
        // 无 phase（最终冻结标记）：隔离已完成，保持冻结。
        this._snapshot = this.readState();
        return;
      }

      // 冻结标记本身损坏：不能自动解冻。不把锚点纳入判断——隔离截断主链后
      // 锚点本就可能领先于前缀，用它复算会误报 tail-missing 并冲掉已存后缀。
      let chain = [];
      try {
        chain = readJson(this.storage, K_CHAIN, []);
        if (!Array.isArray(chain)) chain = [];
      } catch {
        chain = [];
      }
      let suffix = [];
      try {
        suffix = readJson(this.storage, K_SUFFIX, []);
        if (!Array.isArray(suffix)) suffix = [];
      } catch {
        suffix = [];
      }
      // 仅按块内容（不看锚点）复算现存主链：
      //  - 主链自身仍损坏 -> 截断前崩溃，完整坏链仍在，按复算结果重新隔离；
      //  - 主链自身健康 -> 它就是可信前缀，保留现存后缀副本重建最终冻结。
      const blockResult = await verifyChain(chain, null);
      if (!blockResult.ok) {
        this._isolate(chain, blockResult);
        this._snapshot = this.readState();
        return;
      }
      if (suffix.length) {
        // 主链已是健康前缀、后缀副本仍在：重建最终冻结（坏位置在前缀之后），绝不丢后缀。
        const trustedHead = chain.length ? chain[chain.length - 1] : null;
        this._freezePlan({
          firstBadSeq: chain.length + 1,
          reason: 'quarantine-rebuilt',
          prefix: chain,
          suffix,
          trustedHead,
        });
        this._snapshot = this.readState();
        return;
      }
      // 主链健康且后缀为空：移除损坏标记，交由下面的全链复算重新裁决。
      this.storage.removeItem(K_QUARANTINE);
    }

    let chain;
    let anchor;
    try {
      chain = readJson(this.storage, K_CHAIN, []);
    } catch {
      // 链序列化层损坏：没有任何记录可通过复算，冻结在第 1 号。
      // 原始字节无法解析，无可保留的坏后缀；同样走可恢复隔离协议。
      this._freezePlan({
        firstBadSeq: 1,
        reason: 'storage-corrupt',
        prefix: [],
        suffix: [],
        trustedHead: null,
      });
      this._snapshot = this.readState();
      return;
    }
    try {
      anchor = readJson(this.storage, K_ANCHOR, null);
    } catch {
      // 锚点损坏：现存链上的记录逐条复算均仍有效，全部保留为可信前缀。
      this._freezePlan({
        firstBadSeq: chain.length + 1,
        reason: 'anchor-corrupt',
        prefix: chain,
        suffix: [],
        trustedHead: chain.length ? chain[chain.length - 1] : null,
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
      this._isolate(chain, result);
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
   * 断链隔离的崩溃安全协议。
   *
   * 关键约束：绝不能先把主链截断再保存坏后缀（否则中途关闭会永久丢失坏后缀），
   * 也不能把“隔离中”的计划误当成“已完成”的冻结。落库顺序固定为：
   *   1. 写“隔离中”计划标记（含 firstBadSeq / 前缀与后缀长度 / 可信链头）；
   *   2. 写隔离后缀（完整坏后缀先落库，且不覆盖已有的更长副本）；
   *   3. 截断主链为可信前缀（坏后缀此前已安全保存，不会丢失）；
   *   4. 写最终冻结标记（无 phase，覆盖计划标记）；
   *   5. 清空意图日志。
   * 任一步之后标签页被关闭，重开时 _reconcile 看到“隔离中”标记，
   * 按同一计划幂等续做到同一结果。
   */
  _isolate(chain, result) {
    const cut = Math.max(0, result.firstBadSeq - 1);
    const prefix = chain.slice(0, cut);
    const suffix = chain.slice(cut);
    const trustedHead = prefix.length ? prefix[prefix.length - 1] : null;
    this._freezePlan({
      firstBadSeq: result.firstBadSeq,
      reason: result.reason,
      prefix,
      suffix,
      trustedHead,
    });
  }

  /** 按既定计划执行（或续做）隔离，幂等。 */
  _freezePlan({ firstBadSeq, reason, prefix, suffix, trustedHead }) {
    const at = this.now();
    const plan = {
      firstBadSeq,
      reason,
      at,
      trustedHead,
      phase: 'isolating',
      prefixLength: prefix.length,
      suffixLength: suffix.length,
    };
    this._guardedSetAt(K_QUARANTINE, JSON.stringify(plan), 'isolate-plan');
    // 全新隔离：suffix 直接来自刚复算出损坏的原始坏链，是权威副本，强制落库。
    this._writePlannedSuffix(plan, suffix, { boundary: 'isolate-suffix', force: true });
    this._writePlannedChain(plan, prefix, { boundary: 'isolate-chain' });
    // 先清意图，再落最终冻结标记：否则崩溃在两步之间会留下永久无法裁决的孤儿意图。
    this._guardedSetAt(K_INTENTS, JSON.stringify([]), 'isolate-intents');
    this._writePlannedFreeze(plan, { boundary: 'isolate-final' });
  }

  /**
   * 从持久化现状续做未完成的隔离。suffix 必须完整保留原始坏后缀：
   * 优先用计划 + 现存后缀副本重建；副本缺失/不完整时仅当主链仍是未经截断的
   * 原始坏链（长度 === 计划总长）才从主链补全，否则拒绝据不完整数据截断。
   */
  _resumeIsolation(plan) {
    const total = Number(plan.prefixLength) + Number(plan.suffixLength);
    let chain = [];
    try {
      chain = readJson(this.storage, K_CHAIN, []);
      if (!Array.isArray(chain)) chain = [];
    } catch {
      chain = [];
    }
    let suffix = [];
    try {
      suffix = readJson(this.storage, K_SUFFIX, []);
      if (!Array.isArray(suffix)) suffix = [];
    } catch {
      suffix = [];
    }

    const needSuffix = Number(plan.suffixLength);
    const chainIntact = chain.length === total;
    if (suffix.length !== needSuffix) {
      if (chainIntact) {
        // 主链尚未截断：坏后缀仍完整在主链上，先落后缀。
        suffix = chain.slice(Number(plan.prefixLength));
      } else if (suffix.length < needSuffix) {
        // 主链已截断、后缀副本却不完整：数据不足以还原坏后缀。
        // 不能把未完成的隔离当作完成，保留现存副本并停在“隔离中”，等待完整数据/人工。
        throw new LedgerError('ISOLATION_INCOMPLETE',
          '隔离在落库窗口中被中断，且坏后缀副本不完整，暂不完成冻结');
      }
    }
    // 续做时保留已落库的后缀副本，仅在缺失/不足时补写。
    this._writePlannedSuffix(plan, suffix, { boundary: 'isolate-suffix' });
    const prefix = chainIntact
      ? chain.slice(0, Number(plan.prefixLength))
      : chain;
    this._writePlannedChain(plan, prefix, { boundary: 'isolate-chain' });
    // 与 _freezePlan 同一顺序：先清意图，再落最终冻结标记。
    this._guardedSetAt(K_INTENTS, JSON.stringify([]), 'isolate-intents');
    this._writePlannedFreeze(plan, { boundary: 'isolate-final' });
  }

  _writePlannedSuffix(plan, suffix, { boundary, force = false } = {}) {
    if (!force) {
      let existing = null;
      try {
        existing = readJson(this.storage, K_SUFFIX, null);
      } catch {
        existing = null;
      }
      // 续做时不覆盖已存在的、长度足够的副本（它可能就是更完整的原始坏后缀）。
      if (Array.isArray(existing) && existing.length >= suffix.length) return;
    }
    this._guardedSetAt(K_SUFFIX, JSON.stringify(suffix), boundary);
  }

  _writePlannedChain(plan, prefix, { boundary } = {}) {
    const want = Number(plan.prefixLength);
    let cur = null;
    try {
      cur = readJson(this.storage, K_CHAIN, null);
    } catch {
      cur = null;
    }
    // 仅在主链仍长于可信前缀时截断；已是目标前缀则不动。
    if (!Array.isArray(cur) || cur.length > want) {
      this._guardedSetAt(K_CHAIN, JSON.stringify(prefix.slice(0, want)), boundary);
    }
  }

  _writePlannedFreeze(plan, { boundary } = {}) {
    const finalMarker = {
      firstBadSeq: plan.firstBadSeq,
      reason: plan.reason,
      at: plan.at,
      trustedHead: plan.trustedHead,
    };
    this._guardedSetAt(K_QUARANTINE, JSON.stringify(finalMarker), boundary);
  }

  async _detectAndFreeze() {
    // 事件驱动的检测：已完成的冻结只刷新视图；隔离中/标记损坏则持锁裁决，
    // 以便在原持锁标签页崩溃后由仍然开着的标签页把隔离续做完。
    if (this.storage.getItem(K_QUARANTINE)) {
      let marker = null;
      try {
        marker = readJson(this.storage, K_QUARANTINE, null);
      } catch {
        marker = null;
      }
      if (marker && typeof marker === 'object' && marker.phase !== 'isolating') {
        this._snapshot = this.readState();
        return;
      }
    }
    await this._exclusive(async () => {
      await this._reconcile();
    });
    this._snapshot = this.readState();
  }
}
