// test/storage.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LedgerStorage, LedgerError, STORAGE_KEYS } from '../lib/storage.js';
import { verifyChain, GENESIS_DIGEST } from '../lib/chain.js';
import { MemoryTabStorage } from './helpers/memory-store.js';

// 测试时序：远短于浏览器默认值，TTL 仍远大于单次提交耗时。
const FAST = { lockTtlMs: 500, heartbeatMs: 120, stabilizeMs: 2, pollMs: 4 };
const CRASH_TTL = { lockTtlMs: 60, heartbeatMs: 20, stabilizeMs: 1, pollMs: 3 };

function rec(opId, dose = 25) {
  return { instrument: 'ACC-01', dose, operator: '张工', opId };
}

function makeTab(backend, peerId, opts = {}) {
  return new LedgerStorage({ storage: new MemoryTabStorage(backend), peerId, timing: opts.timing || FAST, ...opts });
}

async function assertChainHealthy(backend) {
  const chain = JSON.parse(backend.map.get(STORAGE_KEYS.K_CHAIN) || '[]');
  const anchor = JSON.parse(backend.map.get(STORAGE_KEYS.K_ANCHOR) || 'null');
  const r = await verifyChain(chain, anchor);
  assert.equal(r.ok, true, `链复算失败: ${r.ok === false ? r.reason : ''}`);
  return { chain, anchor };
}

test('基本提交：连续序号、前序链接、锚点推进', async () => {
  const backend = { map: new Map(), tabs: new Set() };
  const tab = makeTab(backend, 't1');
  await tab.start();
  const r1 = await tab.submit(rec('op-1', 10));
  const r2 = await tab.submit(rec('op-2', 20));
  assert.equal(r1.reused, false);
  assert.equal(r1.block.seq, 1);
  assert.equal(r1.block.prevDigest, GENESIS_DIGEST);
  assert.equal(r2.block.seq, 2);
  assert.equal(r2.block.prevDigest, r1.block.digest);

  const state = tab.readState();
  assert.equal(state.nextSeq, 3);
  assert.equal(state.head.digest, r2.block.digest);
  const { chain, anchor } = await assertChainHealthy(backend);
  assert.equal(chain.length, 2);
  assert.deepEqual(anchor, { seq: 2, digest: r2.block.digest });
  tab.stop();
});

test('同一操作标识同内容重试返回原记录，链头不变', async () => {
  const backend = { map: new Map(), tabs: new Set() };
  const tab = makeTab(backend, 't1');
  await tab.start();
  const first = await tab.submit(rec('dup', 10));
  const headAfterFirst = JSON.parse(backend.map.get(STORAGE_KEYS.K_CHAIN));
  const again = await tab.submit({ ...rec('dup', 10), instrument: '  ACC-01  ' });
  assert.equal(again.reused, true);
  assert.equal(again.block.seq, first.block.seq);
  assert.equal(again.block.digest, first.block.digest);
  // 链存储字节不变
  assert.equal(backend.map.get(STORAGE_KEYS.K_CHAIN), JSON.stringify(headAfterFirst));
  assert.equal(JSON.parse(backend.map.get(STORAGE_KEYS.K_CHAIN)).length, 1);
  tab.stop();
});

test('异参复用稳定拒绝，不改变可信链头', async () => {
  const backend = { map: new Map(), tabs: new Set() };
  const tab = makeTab(backend, 't1');
  await tab.start();
  await tab.submit(rec('x', 10));
  const chainBefore = backend.map.get(STORAGE_KEYS.K_CHAIN);
  const anchorBefore = backend.map.get(STORAGE_KEYS.K_ANCHOR);
  for (let i = 0; i < 3; i += 1) {
    await assert.rejects(
      () => tab.submit(rec('x', 11)),
      (err) => err instanceof LedgerError && err.code === 'OPID_CONFLICT',
    );
  }
  assert.equal(backend.map.get(STORAGE_KEYS.K_CHAIN), chainBefore);
  assert.equal(backend.map.get(STORAGE_KEYS.K_ANCHOR), anchorBefore);
  // 合法的新 opId 仍可追加
  const ok = await tab.submit(rec('y', 10));
  assert.equal(ok.block.seq, 2);
  tab.stop();
});

test('校验失败不落任何痕迹', async () => {
  const backend = { map: new Map(), tabs: new Set() };
  const tab = makeTab(backend, 't1');
  await tab.start();
  await assert.rejects(() => tab.submit({ ...rec('bad'), dose: -3 }),
    (err) => err.code === 'VALIDATION');
  await assert.rejects(() => tab.submit({ ...rec('bad'), operator: '   ' }),
    (err) => err.code === 'VALIDATION');
  assert.equal(backend.map.has(STORAGE_KEYS.K_INTENTS), false);
  assert.deepEqual(JSON.parse(backend.map.get(STORAGE_KEYS.K_CHAIN) || '[]'), []);
  tab.stop();
});

test('多标签页并发不同 opId：串行裁决，无重号无分叉', async () => {
  const backend = { map: new Map(), tabs: new Set() };
  const N_TABS = 5;
  const PER_TAB = 10;
  const tabs = [];
  for (let i = 0; i < N_TABS; i += 1) {
    const tab = makeTab(backend, `tab-${i}`);
    tabs.push(tab);
    await tab.start();
  }
  const tasks = [];
  for (let i = 0; i < N_TABS; i += 1) {
    for (let j = 0; j < PER_TAB; j += 1) {
      tasks.push(tabs[i].submit(rec(`op-${i}-${j}`, j)));
    }
  }
  const results = await Promise.all(tasks);
  const seqs = results.map((r) => r.block.seq).sort((a, b) => a - b);
  assert.deepEqual(seqs, Array.from({ length: N_TABS * PER_TAB }, (_, k) => k + 1));
  const digests = new Set(results.map((r) => r.block.digest));
  assert.equal(digests.size, seqs.length);
  await assertChainHealthy(backend);
  for (const t of tabs) t.stop();
});

test('多标签页并发同 opId 同内容：只有一条记录，其余幂等返回原记录', async () => {
  const backend = { map: new Map(), tabs: new Set() };
  const tabs = [];
  for (let i = 0; i < 6; i += 1) {
    const tab = makeTab(backend, `same-${i}`);
    tabs.push(tab);
    await tab.start();
  }
  const results = await Promise.allSettled(tabs.map((t) => t.submit(rec('same-op', 42))));
  const fulfilled = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  const rejected = results.filter((r) => r.status === 'rejected');
  assert.equal(rejected.length, 0, rejected.map((r) => String(r.reason)).join('; '));
  assert.equal(fulfilled.length, 6);
  const committed = fulfilled.filter((r) => !r.reused);
  assert.equal(committed.length, 1);
  const seqDigest = new Set(fulfilled.map((r) => `${r.block.seq}:${r.block.digest}`));
  assert.equal(seqDigest.size, 1);
  const { chain } = await assertChainHealthy(backend);
  assert.equal(chain.length, 1);
  assert.equal(chain[0].opId, 'same-op');
  for (const t of tabs) t.stop();
});

test('多标签页并发同 opId 异内容：仅一方落库，同内容同伴幂等，异参方冲突', async () => {
  const backend = { map: new Map(), tabs: new Set() };
  const tabs = [];
  for (let i = 0; i < 6; i += 1) {
    const tab = makeTab(backend, `conf-${i}`);
    tabs.push(tab);
    await tab.start();
  }
  const results = await Promise.allSettled(
    tabs.map((t, i) => t.submit(rec('race-op', i < 3 ? 10 : 20))),
  );
  const fulfilled = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  const conflicts = results.filter(
    (r) => r.status === 'rejected' && r.reason instanceof LedgerError && r.reason.code === 'OPID_CONFLICT',
  );
  const committed = fulfilled.filter((r) => !r.reused);
  const reused = fulfilled.filter((r) => r.reused);
  // 6 个竞争者分两个内容阵营（3:3）：赢方 1 条落库 + 2 个幂等，输方 3 个冲突
  assert.equal(committed.length, 1);
  assert.equal(reused.length, 2);
  assert.equal(conflicts.length, 3);
  const winningDose = committed[0].block.dose;
  assert.ok(winningDose === 10 || winningDose === 20);
  for (const r of reused) {
    assert.equal(r.block.digest, committed[0].block.digest);
  }
  const { chain } = await assertChainHealthy(backend);
  assert.equal(chain.length, 1);
  assert.equal(chain[0].dose, winningDose);
  // 后续再来的异参提交仍被拒绝，链头稳定
  await assert.rejects(() => tabs[0].submit(rec('race-op', 99)),
    (err) => err.code === 'OPID_CONFLICT');
  assert.equal(JSON.parse(backend.map.get(STORAGE_KEYS.K_CHAIN)).length, 1);
  for (const t of tabs) t.stop();
});

// ---------- 崩溃窗口 ----------

async function crashAndReopen({ dieAfter, expectCommitted, seed = 0 }) {
  const backend = { map: new Map(), tabs: new Set() };
  // seed 条已有记录
  const seedTab = makeTab(backend, 'seed', { timing: CRASH_TTL });
  await seedTab.start();
  for (let i = 0; i < seed; i += 1) {
    await seedTab.submit(rec(`seed-${i}`, i));
  }
  seedTab.stop();
  // 等锁自然释放（stop 会主动删锁，这里模拟真实关闭：直接弃用实例）
  backend.map.delete(STORAGE_KEYS.K_LOCK);

  const seen = [];
  const dying = makeTab(backend, 'dying', {
    timing: CRASH_TTL,
    onAfterWrite: ({ key }) => {
      seen.push(key);
      return key === dieAfter ? 'die' : undefined;
    },
  });
  await dying.start();
  const crash = await dying.submit(rec('inflight', 77)).then(
    () => null,
    (err) => err,
  );
  assert.ok(crash instanceof LedgerError && crash.code === 'TAB_CLOSED', `预期模拟崩溃，实际: ${crash}`);
  assert.ok(seen.includes(dieAfter));
  // 锁因心跳停止而残留，直到 TTL 过期，与真实标签页关闭一致

  // 重新打开（新实例 = 新标签页）
  const reopened = makeTab(backend, 'reopened', { timing: CRASH_TTL });
  await reopened.start();
  const state = reopened.readState();
  const chainLen = state.chain.length;
  assert.equal(chainLen, seed + (expectCommitted ? 1 : 0));
  await assertChainHealthy(backend);
  assert.equal(backend.map.get(STORAGE_KEYS.K_INTENTS), '[]');

  // 同一 opId 重试：完整则返回原记录，无记录则重新出块为同序号
  const retry = await reopened.submit(rec('inflight', 77));
  assert.equal(retry.block.seq, seed + 1);
  const finalState = reopened.readState();
  assert.equal(finalState.chain.length, seed + 1);
  assert.equal(finalState.chain[seed].opId, 'inflight');
  await assertChainHealthy(backend);
  reopened.stop();
  return { state, retry };
}

test('崩溃于意图写入后：完全无记录，重试重新出块', async () => {
  await crashAndReopen({ dieAfter: STORAGE_KEYS.K_INTENTS, expectCommitted: false });
});

test('崩溃于链写入后（锚点未推进，第 1 条）：重新打开恢复为完整记录', async () => {
  await crashAndReopen({ dieAfter: STORAGE_KEYS.K_CHAIN, expectCommitted: true, seed: 0 });
});

test('崩溃于链写入后（锚点落后，第 3 条）：重新打开补齐锚点，记录完整', async () => {
  const { retry } = await crashAndReopen({
    dieAfter: STORAGE_KEYS.K_CHAIN, expectCommitted: true, seed: 2,
  });
  assert.equal(retry.reused, true);
});

test('崩溃于锚点推进后、意图清理前：记录完整，重试幂等', async () => {
  const { retry } = await crashAndReopen({
    dieAfter: STORAGE_KEYS.K_ANCHOR, expectCommitted: true, seed: 1,
  });
  assert.equal(retry.reused, true);
});

// ---------- 断链检测与隔离 ----------

async function seedChain(n = 3) {
  const backend = { map: new Map(), tabs: new Set() };
  const tab = makeTab(backend, 'seed', { timing: CRASH_TTL });
  await tab.start();
  for (let i = 0; i < n; i += 1) {
    await tab.submit(rec(`seed-${i}`, i + 1));
  }
  tab.stop();
  backend.map.delete(STORAGE_KEYS.K_LOCK);
  return backend;
}

test('内容被改：定位首个坏序号、隔离后缀、保留最后可信链头', async () => {
  const backend = await seedChain(4);
  const chain = JSON.parse(backend.map.get(STORAGE_KEYS.K_CHAIN));
  chain[1] = { ...chain[1], dose: 999 };
  backend.map.set(STORAGE_KEYS.K_CHAIN, JSON.stringify(chain));

  const tab = makeTab(backend, 'repair', { timing: CRASH_TTL });
  const state0 = await tab.start();
  assert.equal(state0.status, 'frozen');
  assert.equal(state0.quarantine.firstBadSeq, 2);
  assert.equal(state0.quarantine.reason, 'digest-mismatch');
  assert.equal(state0.chain.length, 1);
  assert.equal(state0.head.seq, 1);
  assert.equal(state0.suffix.length, 3);

  // 禁止继续追加
  await assert.rejects(() => tab.submit(rec('new', 1)),
    (err) => err.code === 'FROZEN');
  assert.equal(JSON.parse(backend.map.get(STORAGE_KEYS.K_CHAIN)).length, 1);
  assert.equal(JSON.parse(backend.map.get(STORAGE_KEYS.K_SUFFIX)).length, 3);

  // 重新打开仍是冻结态，链头不变
  const again = makeTab(backend, 'repair2', { timing: CRASH_TTL });
  const state1 = await again.start();
  assert.equal(state1.status, 'frozen');
  assert.equal(state1.head.seq, 1);
  assert.equal(state1.head.digest, state0.head.digest);
  tab.stop();
  again.stop();
});

test('中间删除记录：seq-gap 定位缺失序号', async () => {
  const backend = await seedChain(3);
  const chain = JSON.parse(backend.map.get(STORAGE_KEYS.K_CHAIN));
  chain.splice(1, 1);
  backend.map.set(STORAGE_KEYS.K_CHAIN, JSON.stringify(chain));
  const tab = makeTab(backend, 'gap', { timing: CRASH_TTL });
  const state = await tab.start();
  assert.equal(state.status, 'frozen');
  assert.equal(state.quarantine.firstBadSeq, 2);
  assert.equal(state.quarantine.reason, 'seq-gap');
  assert.equal(state.chain.length, 1);
  tab.stop();
});

test('尾部记录整体删除：锚点察觉 tail-missing', async () => {
  const backend = await seedChain(3);
  const chain = JSON.parse(backend.map.get(STORAGE_KEYS.K_CHAIN));
  chain.pop();
  backend.map.set(STORAGE_KEYS.K_CHAIN, JSON.stringify(chain));
  const tab = makeTab(backend, 'tail', { timing: CRASH_TTL });
  const state = await tab.start();
  assert.equal(state.status, 'frozen');
  assert.equal(state.quarantine.firstBadSeq, 3);
  assert.equal(state.quarantine.reason, 'tail-missing');
  assert.equal(state.head.seq, 2);
  tab.stop();
});

test('前序摘要被改：prev-digest-mismatch', async () => {
  const backend = await seedChain(3);
  const chain = JSON.parse(backend.map.get(STORAGE_KEYS.K_CHAIN));
  chain[2] = { ...chain[2], prevDigest: 'a'.repeat(64) };
  backend.map.set(STORAGE_KEYS.K_CHAIN, JSON.stringify(chain));
  const tab = makeTab(backend, 'fork', { timing: CRASH_TTL });
  const state = await tab.start();
  assert.equal(state.quarantine.reason, 'prev-digest-mismatch');
  assert.equal(state.quarantine.firstBadSeq, 3);
  assert.equal(state.head.seq, 2);
  tab.stop();
});

test('其它标签页实时损坏时，本标签页经 storage 事件冻结', async () => {  const backend = { map: new Map(), tabs: new Set() };
  const a = makeTab(backend, 'live-a');
  const b = makeTab(backend, 'live-b');
  await Promise.all([a.start(), b.start()]);
  await a.submit(rec('a1', 1));
  await a.submit(rec('a2', 2));

  let resolveB;
  const bFrozen = new Promise((res) => { resolveB = res; });
  const bWatch = makeTab(backend, 'live-c', {
    onExternalChange: (s) => { if (s.status === 'frozen') resolveB(); },
  });
  await bWatch.start();

  // 外部通过一个真实的 Storage 句柄篡改持久化（模拟数据被改并广播事件）
  const writer = new MemoryTabStorage(backend);
  const chain = JSON.parse(backend.map.get(STORAGE_KEYS.K_CHAIN));
  chain[0] = { ...chain[0], dose: 123 };
  writer.setItem(STORAGE_KEYS.K_CHAIN, JSON.stringify(chain));

  await bFrozen;
  assert.equal(bWatch.readState().status, 'frozen');
  assert.equal(bWatch.readState().quarantine.firstBadSeq, 1);
  a.stop(); b.stop(); bWatch.stop();
});

test('链 JSON 损坏：冻结在 #1，禁止追加', async () => {
  const backend = { map: new Map(), tabs: new Set() };
  backend.map.set(STORAGE_KEYS.K_CHAIN, '{not-json');
  const tab = makeTab(backend, 'corrupt', { timing: CRASH_TTL });
  const state = await tab.start();
  assert.equal(state.status, 'frozen');
  assert.equal(state.quarantine.firstBadSeq, 1);
  assert.equal(state.quarantine.reason, 'storage-corrupt');
  await assert.rejects(() => tab.submit(rec('x', 1)), (e) => e.code === 'FROZEN');
  tab.stop();
});

test('锚点 JSON 损坏：冻结在下一序号，保留全部可信记录', async () => {
  const backend = await seedChain(3);
  backend.map.set(STORAGE_KEYS.K_ANCHOR, 'broken');
  const tab = makeTab(backend, 'acorrupt', { timing: CRASH_TTL });
  const state = await tab.start();
  assert.equal(state.status, 'frozen');
  assert.equal(state.quarantine.firstBadSeq, 4);
  assert.equal(state.quarantine.reason, 'anchor-corrupt');
  assert.equal(state.head.seq, 3);
  tab.stop();
});
