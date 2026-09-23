// test/chain.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GENESIS_DIGEST,
  HASH_SCHEME,
  canonicalize,
  canonicalContent,
  createBlock,
  digestInput,
  findByOpId,
  normalizeContent,
  verifyChain,
} from '../lib/chain.js';

const base = { instrument: ' ACC-01 ', dose: 25, operator: '张工', opId: 'op-1' };

test('规范化：去空白、剂量必须是非负安全整数', () => {
  assert.deepEqual(normalizeContent(base), {
    instrument: 'ACC-01', dose: 25, operator: '张工', opId: 'op-1',
  });
  assert.throws(() => normalizeContent({ ...base, instrument: '   ' }));
  assert.throws(() => normalizeContent({ ...base, dose: -1 }));
  assert.throws(() => normalizeContent({ ...base, dose: 2.5 }));
  assert.throws(() => normalizeContent({ ...base, dose: '25' }));
  assert.throws(() => normalizeContent({ ...base, dose: Number.MAX_SAFE_INTEGER + 1 }));
  assert.doesNotThrow(() => normalizeContent({ ...base, dose: 0 }));
});

test('规范化 JSON 键排序，保证字节确定', () => {
  const a = canonicalize({ opId: 'x', dose: 1, instrument: 'i', operator: 'o' });
  const b = canonicalize({ dose: 1, operator: 'o', instrument: 'i', opId: 'x' });
  assert.equal(a, b);
  assert.equal(a, '{"dose":1,"instrument":"i","opId":"x","operator":"o"}');
  // 空白差异在规范化阶段消除
  assert.equal(canonicalContent({ ...base }), canonicalContent({ ...base, instrument: 'ACC-01' }));
});

test('出块：摘要由规范化内容、序号、前序摘要决定', async () => {
  const block = await createBlock(1, GENESIS_DIGEST, base);
  assert.equal(block.seq, 1);
  assert.equal(block.prevDigest, GENESIS_DIGEST);
  assert.match(block.digest, /^[0-9a-f]{64}$/);
  // 输入首尾空白不影响摘要
  const block2 = await createBlock(1, GENESIS_DIGEST, { ...base, operator: '  张工 ' });
  assert.equal(block2.digest, block.digest);
  // 序号不同 -> 摘要不同
  const block3 = await createBlock(2, block.digest, base);
  assert.notEqual(block3.digest, block.digest);
  // 剂量不同 -> 摘要不同
  const block4 = await createBlock(1, GENESIS_DIGEST, { ...base, dose: 26 });
  assert.notEqual(block4.digest, block.digest);
});

test('摘要输入格式固定', async () => {
  const block = await createBlock(1, GENESIS_DIGEST, base);
  const input = digestInput(1, GENESIS_DIGEST, normalizeContent(base));
  assert.ok(input.startsWith(`${HASH_SCHEME}\n1\n${GENESIS_DIGEST}\n`));
  const { webcrypto } = await import('node:crypto');
  const expect = await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  const hex = [...new Uint8Array(expect)].map((b) => b.toString(16).padStart(2, '0')).join('');
  assert.equal(hex, block.digest);
});

test('verifyChain：合法链从创世复算通过并返回链头', async () => {
  const b1 = await createBlock(1, GENESIS_DIGEST, { ...base, opId: 'a' });
  const b2 = await createBlock(2, b1.digest, { ...base, opId: 'b' });
  const b3 = await createBlock(3, b2.digest, { ...base, opId: 'c' });
  const r = await verifyChain([b1, b2, b3], { seq: 3, digest: b3.digest });
  assert.equal(r.ok, true);
  assert.equal(r.head.seq, 3);

  // 空链 + 无锚点也算合法（尚未有创世记录）
  const r0 = await verifyChain([], null);
  assert.equal(r0.ok, true);
  assert.equal(r0.head, null);
});

test('verifyChain：定位首个坏序号 - 内容被改', async () => {
  const b1 = await createBlock(1, GENESIS_DIGEST, { ...base, opId: 'a' });
  const b2 = await createBlock(2, b1.digest, { ...base, opId: 'b' });
  const b3 = await createBlock(3, b2.digest, { ...base, opId: 'c' });
  const tampered = { ...b2, dose: 999 };
  const r = await verifyChain([b1, tampered, b3]);
  assert.equal(r.ok, false);
  assert.equal(r.firstBadSeq, 2);
  assert.equal(r.reason, 'digest-mismatch');
  assert.equal(r.trustedIndex, 1);
  assert.equal(r.head.seq, 1);
});

test('verifyChain：定位首个坏序号 - 摘要被改导致后继分叉', async () => {
  const b1 = await createBlock(1, GENESIS_DIGEST, { ...base, opId: 'a' });
  const b2 = await createBlock(2, b1.digest, { ...base, opId: 'b' });
  const evil = { ...b2, digest: 'a'.repeat(64) };
  const r = await verifyChain([b1, evil]);
  assert.equal(r.firstBadSeq, 2);
  assert.equal(r.reason, 'digest-mismatch');
});

test('verifyChain：中间删除一条 -> seq-gap', async () => {
  const b1 = await createBlock(1, GENESIS_DIGEST, { ...base, opId: 'a' });
  const b2 = await createBlock(2, b1.digest, { ...base, opId: 'b' });
  const b3 = await createBlock(3, b2.digest, { ...base, opId: 'c' });
  const r = await verifyChain([b1, b3]);
  assert.equal(r.ok, false);
  assert.equal(r.firstBadSeq, 2);
  assert.equal(r.reason, 'seq-gap');
  assert.equal(r.trustedIndex, 1);
});

test('verifyChain：前序摘要被改 -> prev-digest-mismatch', async () => {
  const b1 = await createBlock(1, GENESIS_DIGEST, { ...base, opId: 'a' });
  const b2 = await createBlock(2, b1.digest, { ...base, opId: 'b' });
  const forked = { ...b2, prevDigest: 'f'.repeat(64) };
  const r = await verifyChain([b1, forked]);
  assert.equal(r.firstBadSeq, 2);
  assert.equal(r.reason, 'prev-digest-mismatch');
});

test('verifyChain：尾部记录整体删除由锚点察觉', async () => {
  const b1 = await createBlock(1, GENESIS_DIGEST, { ...base, opId: 'a' });
  const b2 = await createBlock(2, b1.digest, { ...base, opId: 'b' });
  // 链上只有 1 条，锚点却指向 2
  const r = await verifyChain([b1], { seq: 2, digest: b2.digest });
  assert.equal(r.ok, false);
  assert.equal(r.firstBadSeq, 2);
  assert.equal(r.reason, 'tail-missing');
  assert.equal(r.head.seq, 1);
});

test('verifyChain：锚点摘要不符', async () => {
  const b1 = await createBlock(1, GENESIS_DIGEST, { ...base, opId: 'a' });
  const r = await verifyChain([b1], { seq: 1, digest: '9'.repeat(64) });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'anchor-digest-mismatch');
  assert.equal(r.firstBadSeq, 1);
  assert.equal(r.trustedIndex, 0);
});

test('findByOpId', async () => {
  const b1 = await createBlock(1, GENESIS_DIGEST, { ...base, opId: 'find-me' });
  assert.equal(findByOpId([b1], 'find-me').seq, 1);
  assert.equal(findByOpId([b1], 'nope'), null);
});
