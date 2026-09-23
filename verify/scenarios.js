// verify/scenarios.js
// verify 单次服务的场景复算：并发幂等、异参冲突、断链边界、崩溃原子性。
// 其中独立复算使用 node:crypto 按文档化配方重新实现一遍，不复用业务代码的 verifyChain。

import { createHash } from 'node:crypto';
import { LedgerStorage, LedgerError, STORAGE_KEYS } from '../lib/storage.js';
import { GENESIS_DIGEST } from '../lib/chain.js';
import { MemoryTabStorage } from '../test/helpers/memory-store.js';

const FAST = { lockTtlMs: 500, heartbeatMs: 120, stabilizeMs: 2, pollMs: 4 };

function rec(opId, dose = 25) {
  return { instrument: 'ACC-01', dose, operator: '张工', opId };
}

function newBackend() {
  return { map: new Map(), tabs: new Set() };
}

function tab(backend, peerId, extra = {}) {
  return new LedgerStorage({ storage: new MemoryTabStorage(backend), peerId, timing: FAST, ...extra });
}

function read(backend, key, fallback) {
  const raw = backend.map.get(key);
  return raw === undefined ? fallback : JSON.parse(raw);
}

// 独立复算：严格按“sha256-v1 / seq / prev / 排序键 JSON”配方，不 import 业务复算逻辑。
function independentRecompute(chain) {
  let prev = GENESIS_DIGEST;
  for (let i = 0; i < chain.length; i += 1) {
    const b = chain[i];
    if (b.seq !== i + 1) return { ok: false, firstBadSeq: i + 1, reason: 'seq-gap' };
    const canonical = JSON.stringify({
      dose: b.dose,
      instrument: b.instrument,
      opId: b.opId,
      operator: b.operator,
    });
    const expect = createHash('sha256')
      .update(`sha256-v1\n${b.seq}\n${prev}\n${canonical}`)
      .digest('hex');
    if (b.prevDigest !== prev) return { ok: false, firstBadSeq: b.seq, reason: 'prev-digest-mismatch' };
    if (b.digest !== expect) return { ok: false, firstBadSeq: b.seq, reason: 'digest-mismatch' };
    prev = b.digest;
  }
  return { ok: true };
}

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, ok: Boolean(cond), detail });
}

async function scenarioConcurrentIdempotency() {
  const backend = newBackend();
  const tabs = [];
  for (let i = 0; i < 8; i += 1) {
    const t = tab(backend, `idem-${i}`);
    tabs.push(t);
    await t.start();
  }
  const rs = await Promise.allSettled(tabs.map((t) => t.submit(rec('OP-IDEM', 50))));
  const fulfilled = rs.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  const rejected = rs.filter((r) => r.status === 'rejected');
  const committed = fulfilled.filter((r) => !r.reused);
  const chain = read(backend, STORAGE_KEYS.K_CHAIN, []);
  check('并发幂等：无拒绝', rejected.length === 0,
    rejected.map((r) => String(r.reason)).join('; '));
  check('并发幂等：恰好一条新记录', committed.length === 1, `committed=${committed.length}`);
  check('并发幂等：链长度为 1', chain.length === 1, `len=${chain.length}`);
  check('并发幂等：所有响应指向同一原记录',
    new Set(fulfilled.map((r) => `${r.block.seq}:${r.block.digest}`)).size === 1);
  check('并发幂等：独立复算通过', independentRecompute(chain).ok);
  for (const t of tabs) t.stop();
}

async function scenarioConflict() {
  const backend = newBackend();
  const t1 = tab(backend, 'c1');
  const t2 = tab(backend, 'c2');
  await Promise.all([t1.start(), t2.start()]);
  await t1.submit(rec('OP-X', 10));
  const headBefore = backend.map.get(STORAGE_KEYS.K_CHAIN);
  const anchorBefore = backend.map.get(STORAGE_KEYS.K_ANCHOR);

  let errCode = null;
  try {
    await t2.submit(rec('OP-X', 20));
  } catch (e) {
    errCode = e instanceof LedgerError ? e.code : 'OTHER';
  }
  check('异参冲突：返回 OPID_CONFLICT', errCode === 'OPID_CONFLICT', `got=${errCode}`);
  check('异参冲突：链头字节不变',
    backend.map.get(STORAGE_KEYS.K_CHAIN) === headBefore
    && backend.map.get(STORAGE_KEYS.K_ANCHOR) === anchorBefore);

  // 再连拒两次确认稳定性
  const codes = await Promise.all([1, 2, 3].map(async () => {
    try { await t1.submit(rec('OP-X', 30)); return null; }
    catch (e) { return e.code; }
  }));
  check('异参冲突：稳定拒绝', codes.every((c) => c === 'OPID_CONFLICT'), codes.join(','));
  check('异参冲突：拒绝后链仍只有一条',
    read(backend, STORAGE_KEYS.K_CHAIN, []).length === 1);
  t1.stop();
  t2.stop();
}

async function scenarioBreakBoundary() {
  const backend = newBackend();
  const seeder = tab(backend, 'seed');
  await seeder.start();
  for (let i = 0; i < 5; i += 1) await seeder.submit(rec(`b-${i}`, i + 1));
  seeder.stop();
  backend.map.delete(STORAGE_KEYS.K_LOCK);

  // 外部改坏第 3 条内容（不重算摘要）
  const chain = read(backend, STORAGE_KEYS.K_CHAIN, []);
  chain[2] = { ...chain[2], dose: 888 };
  backend.map.set(STORAGE_KEYS.K_CHAIN, JSON.stringify(chain));

  const independent = independentRecompute(chain);
  check('断链边界：独立复算定位 #3',
    !independent.ok && independent.firstBadSeq === 3 && independent.reason === 'digest-mismatch',
    JSON.stringify(independent));

  const repair = tab(backend, 'repair');
  const state = await repair.start();
  check('断链边界：状态冻结', state.status === 'frozen');
  check('断链边界：首个坏序号为 3', state.quarantine.firstBadSeq === 3);
  check('断链边界：最后可信链头为 #2', state.head && state.head.seq === 2);
  check('断链边界：后缀隔离 3 条', state.suffix.length === 3);
  check('断链边界：可信前缀独立复算通过', independentRecompute(state.chain).ok && state.chain.length === 2);

  let frozenCode = null;
  try {
    await repair.submit(rec('after-break', 1));
  } catch (e) {
    frozenCode = e.code;
  }
  check('断链边界：禁止继续追加', frozenCode === 'FROZEN', `got=${frozenCode}`);
  check('断链边界：隔离后仍无法追加，链长度停留 2',
    read(backend, STORAGE_KEYS.K_CHAIN, []).length === 2);

  // 再次打开：冻结态与可信链头保持
  const reopen = tab(backend, 'reopen');
  const again = await reopen.start();
  check('断链边界：重开仍冻结且链头一致',
    again.status === 'frozen' && again.head.seq === 2 && again.head.digest === state.head.digest);
  repair.stop();
  reopen.stop();
}

async function scenarioTailMissing() {
  const backend = newBackend();
  const s = tab(backend, 'seed');
  await s.start();
  for (let i = 0; i < 4; i += 1) await s.submit(rec(`t-${i}`, i));
  s.stop();
  backend.map.delete(STORAGE_KEYS.K_LOCK);
  const chain = read(backend, STORAGE_KEYS.K_CHAIN, []);
  chain.pop(); // 整体删除尾部记录，锚点仍指向 #4
  backend.map.set(STORAGE_KEYS.K_CHAIN, JSON.stringify(chain));

  const t = tab(backend, 'tail');
  const state = await t.start();
  check('尾部缺失：冻结在 #4', state.status === 'frozen' && state.quarantine.firstBadSeq === 4);
  check('尾部缺失：保留可信链头 #3', state.head && state.head.seq === 3);
  t.stop();
}

async function scenarioCrashAtomicity() {
  const backend = newBackend();
  const s = tab(backend, 'seed', {
    timing: { lockTtlMs: 60, heartbeatMs: 20, stabilizeMs: 1, pollMs: 3 },
  });
  await s.start();
  await s.submit(rec('pre', 1));
  s.stop();
  backend.map.delete(STORAGE_KEYS.K_LOCK);

  const dying = tab(backend, 'dying', {
    timing: { lockTtlMs: 60, heartbeatMs: 20, stabilizeMs: 1, pollMs: 3 },
    onAfterWrite: ({ key }) => (key === STORAGE_KEYS.K_INTENTS ? 'die' : undefined),
  });
  await dying.start();
  let died = null;
  try {
    await dying.submit(rec('inflight', 77));
  } catch (e) {
    died = e.code;
  }
  check('崩溃原子性：意图后崩溃被识别', died === 'TAB_CLOSED', `got=${died}`);

  const reopened = tab(backend, 'reopened', {
    timing: { lockTtlMs: 60, heartbeatMs: 20, stabilizeMs: 1, pollMs: 3 },
  });
  await reopened.start();
  check('崩溃原子性：重开后链上完全无该记录',
    read(backend, STORAGE_KEYS.K_CHAIN, []).length === 1);
  check('崩溃原子性：孤儿意图已清空',
    backend.map.get(STORAGE_KEYS.K_INTENTS) === '[]');
  const retry = await reopened.submit(rec('inflight', 77));
  check('崩溃原子性：重试在 #2 重新出块', retry.block.seq === 2 && !retry.reused);
  check('崩溃原子性：最终链独立复算通过',
    independentRecompute(read(backend, STORAGE_KEYS.K_CHAIN, [])).ok);
  reopened.stop();
}

export async function runScenarios() {
  await scenarioConcurrentIdempotency();
  await scenarioConflict();
  await scenarioBreakBoundary();
  await scenarioTailMissing();
  await scenarioCrashAtomicity();
  return results;
}
