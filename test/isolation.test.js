// test/isolation.test.js
// 断链隔离的崩溃安全验收：
//  五条连续记录、第三条损坏后，在隔离状态机的每个本地持久化边界模拟标签页终止，
//  新实例启动后必须收敛到同一结果：可信前缀 #1#2、坏后缀完整隔离、
//  首坏序号 3、可信链头 #2、持续禁止追加；覆盖内容被改 / 记录缺失 / 摘要不符三类断链。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LedgerStorage, LedgerError, STORAGE_KEYS } from '../lib/storage.js';
import { MemoryTabStorage } from './helpers/memory-store.js';

const CRASH_TTL = { lockTtlMs: 60, heartbeatMs: 20, stabilizeMs: 1, pollMs: 3 };

function rec(opId, dose = 25) {
  return { instrument: 'ACC-01', dose, operator: '张工', opId };
}

function makeTab(backend, peerId, opts = {}) {
  return new LedgerStorage({ storage: new MemoryTabStorage(backend), peerId, timing: CRASH_TTL, ...opts });
}

// 隔离状态机的全部落盘边界（顺序即写入顺序）。
const ISO_BOUNDARIES = [
  ['P0-隔离计划', { key: STORAGE_KEYS.K_QUARANTINE, occurrence: 1 }],
  ['P1-后缀落盘', { key: STORAGE_KEYS.K_SUFFIX, occurrence: 1 }],
  ['P2-主链截断', { key: STORAGE_KEYS.K_CHAIN, occurrence: 1 }],
  ['P3-意图清空', { key: STORAGE_KEYS.K_INTENTS, occurrence: 1 }],
  ['P4-终态标记', { key: STORAGE_KEYS.K_QUARANTINE, occurrence: 2 }],
];

/** 建立五条可复算的连续记录，返回后端与五个原始块。 */
async function seedFive() {
  const backend = { map: new Map(), tabs: new Set() };
  const seeder = makeTab(backend, 'seed');
  await seeder.start();
  for (let i = 0; i < 5; i += 1) {
    await seeder.submit(rec(`seed-${i}`, i + 1));
  }
  seeder.stop();
  backend.map.delete(STORAGE_KEYS.K_LOCK);
  const blocks = JSON.parse(backend.map.get(STORAGE_KEYS.K_CHAIN));
  assert.equal(blocks.length, 5);
  return { backend, blocks };
}

/**
 * 三类断链：返回损坏后的链数组与期望隔离后缀（原样字节，不得丢失/被“修复”）。
 *  - content  内容被改：第三条剂量改动而不更新摘要
 *  - missing  记录缺失：整体删除第三条（后续序号前移 -> seq-gap）
 *  - digest   摘要不符：第三条摘要被改，业务内容不动
 */
function corrupt(blocks, kind) {
  const chain = JSON.parse(JSON.stringify(blocks));
  if (kind === 'content') {
    chain[2] = { ...chain[2], dose: 888 };
    return { chain, expectedSuffix: chain.slice(2), expectedReason: 'digest-mismatch' };
  }
  if (kind === 'missing') {
    chain.splice(2, 1);
    return { chain, expectedSuffix: chain.slice(2), expectedReason: 'seq-gap' };
  }
  if (kind === 'digest') {
    chain[2] = { ...chain[2], digest: 'f'.repeat(64) };
    return { chain, expectedSuffix: chain.slice(2), expectedReason: 'digest-mismatch' };
  }
  throw new Error(`未知断链类型: ${kind}`);
}

function crashHook(target) {
  const seen = Object.create(null);
  return (info) => {
    seen[info.key] = (seen[info.key] || 0) + 1;
    if (info.key === target.key && seen[info.key] === target.occurrence) {
      return 'die';
    }
    return undefined;
  };
}

async function assertConverged(tab, backend, state, { blocks, expectedSuffix, expectedReason }) {
  assert.equal(state.status, 'frozen');
  assert.equal(state.quarantine.firstBadSeq, 3, '首个坏序号必须为 3');
  assert.equal(state.quarantine.reason, expectedReason);
  assert.equal(state.quarantine.phase, undefined, '终态标记不得再带 isolating 阶段');
  assert.ok(!('snapshot' in state.quarantine), '终态标记不得残留快照');

  // 可信前缀只含第一、第二条，且字节与原始记录一致。
  assert.equal(state.chain.length, 2);
  assert.deepEqual(state.chain, blocks.slice(0, 2));
  assert.equal(state.head.seq, 2, '最后可信链头必须为 #2');
  assert.equal(state.head.digest, blocks[1].digest);

  // 坏后缀完整进入隔离区，保留原始（损坏）字节。
  assert.equal(state.suffix.length, expectedSuffix.length);
  assert.deepEqual(state.suffix, expectedSuffix);

  // 磁盘上真实收敛，而非仅视图投影。
  assert.deepEqual(JSON.parse(backend.map.get(STORAGE_KEYS.K_CHAIN)), blocks.slice(0, 2));
  assert.deepEqual(JSON.parse(backend.map.get(STORAGE_KEYS.K_SUFFIX)), expectedSuffix);
  const marker = JSON.parse(backend.map.get(STORAGE_KEYS.K_QUARANTINE));
  assert.equal(marker.phase, undefined);
  assert.equal(marker.firstBadSeq, 3);
  assert.equal(backend.map.get(STORAGE_KEYS.K_INTENTS), '[]');

  // 持续禁止追加，且拒绝不改变任何持久化字节。
  const chainBytes = backend.map.get(STORAGE_KEYS.K_CHAIN);
  const suffixBytes = backend.map.get(STORAGE_KEYS.K_SUFFIX);
  await assert.rejects(() => tab.submit(rec('after', 1)), (err) => err.code === 'FROZEN');
  assert.equal(backend.map.get(STORAGE_KEYS.K_CHAIN), chainBytes);
  assert.equal(backend.map.get(STORAGE_KEYS.K_SUFFIX), suffixBytes);
}

for (const [label, target] of ISO_BOUNDARIES) {
  for (const kind of ['content', 'missing', 'digest']) {
    test(`断链[${kind}]：隔离崩溃于 ${label}，新实例重开收敛到同一冻结结果`, async () => {
      const { backend, blocks } = await seedFive();
      const { chain, expectedSuffix, expectedReason } = corrupt(blocks, kind);
      backend.map.set(STORAGE_KEYS.K_CHAIN, JSON.stringify(chain));

      const dying = makeTab(backend, 'dying', { onAfterWrite: crashHook(target) });
      const crash = await dying.start().then(() => null, (err) => err);
      assert.ok(crash instanceof LedgerError && crash.code === 'TAB_CLOSED',
        `预期在 ${label} 后模拟关闭，实际: ${crash}`);

      // 关闭后、任何持锁复算发生前：只读视图也必须投影计划终态，
      // 不得出现“主表仍是 1..5、隔离后缀为空”的自相矛盾冻结态。
      const viewer = makeTab(backend, 'viewer');
      const projected = viewer.readState();
      assert.equal(projected.status, 'frozen');
      assert.equal(projected.chain.length, 2);
      assert.deepEqual(projected.suffix, expectedSuffix);
      assert.equal(projected.quarantine.firstBadSeq, 3);
      assert.equal(projected.head.seq, 2);
      viewer.stop();

      // 新实例启动：持锁复算应幂等续作未完成的隔离。
      const reopened = makeTab(backend, 'reopen-1');
      const state = await reopened.start();
      await assertConverged(reopened, backend, state, { blocks, expectedSuffix, expectedReason });

      // 再次主动复算：结论稳定。
      const reverified = await reopened.reverify();
      assert.equal(reverified.status, 'frozen');
      assert.equal(reverified.quarantine.firstBadSeq, 3);
      assert.equal(reverified.head.digest, blocks[1].digest);
      assert.deepEqual(reverified.suffix, expectedSuffix);

      // 第二次重新打开（又一个新实例）：仍然收敛，禁止追加。
      const again = makeTab(backend, 'reopen-2');
      const state2 = await again.start();
      assert.equal(state2.status, 'frozen');
      assert.deepEqual(state2.chain, blocks.slice(0, 2));
      assert.deepEqual(state2.suffix, expectedSuffix);
      assert.equal(state2.head.digest, blocks[1].digest);
      await assert.rejects(() => again.submit(rec('after', 1)), (err) => err.code === 'FROZEN');
      reopened.stop();
      again.stop();
    });
  }
}

test('内容被改：隔离一次完成（无中断）结果与各中断点一致', async () => {
  const { backend, blocks } = await seedFive();
  const { chain, expectedSuffix, expectedReason } = corrupt(blocks, 'content');
  backend.map.set(STORAGE_KEYS.K_CHAIN, JSON.stringify(chain));

  const tab = makeTab(backend, 'clean');
  const state = await tab.start();
  assert.equal(state.status, 'frozen');
  assert.equal(state.quarantine.firstBadSeq, 3);
  assert.equal(state.quarantine.reason, expectedReason);
  assert.deepEqual(state.chain, blocks.slice(0, 2));
  assert.deepEqual(state.suffix, expectedSuffix);
  assert.equal(state.head.seq, 2);
  await assert.rejects(() => tab.submit(rec('after', 1)), (err) => err.code === 'FROZEN');
  tab.stop();
});

test('记录缺失：在隔离计划边界（P0）中断后重开，定位缺失序号并保留剩余后缀', async () => {
  const { backend, blocks } = await seedFive();
  const { chain, expectedSuffix, expectedReason } = corrupt(blocks, 'missing');
  backend.map.set(STORAGE_KEYS.K_CHAIN, JSON.stringify(chain));

  const dying = makeTab(backend, 'dying', {
    onAfterWrite: crashHook(ISO_BOUNDARIES[0][1]),
  });
  await dying.start().catch(() => {});

  const reopened = makeTab(backend, 'reopen');
  const state = await reopened.start();
  assert.equal(state.status, 'frozen');
  assert.equal(state.quarantine.firstBadSeq, 3);
  assert.equal(state.quarantine.reason, expectedReason);
  assert.deepEqual(state.chain, blocks.slice(0, 2));
  // 删除的第三条无法找回，隔离区保留尚存的原第四、第五条。
  assert.equal(state.suffix.length, 2);
  assert.deepEqual(state.suffix, expectedSuffix);
  assert.equal(state.suffix[0].seq, 4);
  assert.equal(state.suffix[1].seq, 5);
  assert.equal(state.head.seq, 2);
  await assert.rejects(() => reopened.submit(rec('after', 1)), (err) => err.code === 'FROZEN');
  reopened.stop();
});

test('摘要不符：在后缀落盘边界（P1）中断后重开，被改摘要原样隔离不丢失', async () => {
  const { backend, blocks } = await seedFive();
  const { chain, expectedSuffix, expectedReason } = corrupt(blocks, 'digest');
  backend.map.set(STORAGE_KEYS.K_CHAIN, JSON.stringify(chain));

  const dying = makeTab(backend, 'dying', {
    onAfterWrite: crashHook(ISO_BOUNDARIES[1][1]),
  });
  await dying.start().catch(() => {});

  const reopened = makeTab(backend, 'reopen');
  const state = await reopened.start();
  assert.equal(state.status, 'frozen');
  assert.equal(state.quarantine.firstBadSeq, 3);
  assert.equal(state.quarantine.reason, expectedReason);
  assert.deepEqual(state.chain, blocks.slice(0, 2));
  assert.equal(state.suffix.length, 3);
  assert.deepEqual(state.suffix, expectedSuffix);
  // 坏后缀是原始损坏字节：被改的摘要不得被悄悄重算或丢弃。
  assert.equal(state.suffix[0].digest, 'f'.repeat(64));
  assert.equal(state.suffix[0].dose, blocks[2].dose);
  assert.equal(state.head.seq, 2);
  await assert.rejects(() => reopened.submit(rec('after', 1)), (err) => err.code === 'FROZEN');
  reopened.stop();
});

test('中断窗口内另一存活标签页观察到冻结并禁止追加，持锁后续作完成隔离', async () => {
  const { backend, blocks } = await seedFive();
  const { chain, expectedSuffix } = corrupt(blocks, 'content');
  backend.map.set(STORAGE_KEYS.K_CHAIN, JSON.stringify(chain));

  const dying = makeTab(backend, 'dying', {
    onAfterWrite: crashHook(ISO_BOUNDARIES[0][1]), // P0 后关闭
  });
  await dying.start().catch(() => {});

  // 新实例先读视图（锁尚未过期），随后 start 持锁续作。
  const watcher = makeTab(backend, 'watcher');
  const before = watcher.readState();
  assert.equal(before.status, 'frozen');
  assert.equal(before.chain.length, 2);
  const state = await watcher.start();
  assert.equal(state.status, 'frozen');
  assert.deepEqual(state.chain, blocks.slice(0, 2));
  assert.deepEqual(state.suffix, expectedSuffix);
  await assert.rejects(() => watcher.submit(rec('after', 1)), (err) => err.code === 'FROZEN');
  watcher.stop();
});
