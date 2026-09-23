// lib/chain.js
// 哈希链纯核心：规范化业务内容 -> SHA-256 出块 -> 全链复算。
// 浏览器与 Node 同构（仅依赖 Web Crypto，不引用任何 node:* 模块）。

export const HASH_SCHEME = 'sha256-v1';
// 创世前序摘要：64 个 0，仅作为第 1 条记录的锚点，本身不是记录。
export const GENESIS_DIGEST = '0'.repeat(64);

async function sha256Hex(input) {
  let subtle = globalThis.crypto && globalThis.crypto.subtle;
  if (!subtle) {
    // 仅在缺少 Web Crypto 的旧运行时走此分支（动态 import，浏览器端永远不会执行）
    const { webcrypto } = await import('node:crypto');
    subtle = webcrypto.subtle;
  }
  const bytes = new TextEncoder().encode(input);
  const buf = await subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function asTrimmedString(value, label) {
  if (typeof value !== 'string') {
    throw new Error(`${label} 必须是字符串`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${label} 不能为空`);
  }
  return trimmed;
}

/**
 * 规范化业务内容：字符串去首尾空白且非空，剂量为非负安全整数。
 * 规范化后的字段顺序固定，是唯一可接受的业务表示。
 */
export function normalizeContent(input) {
  if (!input || typeof input !== 'object') {
    throw new Error('业务内容不能为空');
  }
  const instrument = asTrimmedString(input.instrument, '仪器');
  const operator = asTrimmedString(input.operator, '操作人');
  const opId = asTrimmedString(input.opId, '操作标识');
  const dose = input.dose;
  if (typeof dose !== 'number' || !Number.isSafeInteger(dose) || dose < 0) {
    throw new Error('整数剂量必须是非负整数');
  }
  return { instrument, dose, operator, opId };
}

/** 规范化 JSON：键按字典序排序，无多余空白，保证跨端字节一致。 */
export function canonicalize(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }
  const inner = Object.keys(value)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`)
    .join(',');
  return `{${inner}}`;
}

export function canonicalContent(input) {
  return canonicalize(normalizeContent(input));
}

/** 摘要输入：方案号、序号、前序摘要、规范化业务内容，逐行拼接。 */
export function digestInput(seq, prevDigest, content) {
  return `${HASH_SCHEME}\n${seq}\n${prevDigest}\n${canonicalContent(content)}`;
}

export async function computeDigest(seq, prevDigest, content) {
  if (!Number.isSafeInteger(seq) || seq < 1) {
    throw new Error('序号必须是从 1 开始的正整数');
  }
  if (!/^[0-9a-f]{64}$/.test(prevDigest)) {
    throw new Error('前序摘要必须是 64 位十六进制');
  }
  return sha256Hex(digestInput(seq, prevDigest, content));
}

/** 在给定链头位置出一块（不落库）。 */
export async function createBlock(seq, prevDigest, input) {
  const content = normalizeContent(input);
  const digest = await computeDigest(seq, prevDigest, content);
  return { seq, ...content, prevDigest, digest };
}

/** 规范化后业务内容是否一致（用于幂等 / 异参冲突裁决）。 */
export function sameContent(a, b) {
  return canonicalContent(a) === canonicalContent(b);
}

export function headOf(blocks) {
  return blocks.length ? blocks[blocks.length - 1] : null;
}

/**
 * 从创世记录复算全链：从 GENESIS_DIGEST 起逐条重算 SHA-256，
 * 覆盖序号断号、前序摘要分叉、内容被改、摘要被改、记录畸形。
 *
 * @param {Array} blocks 持久化的记录块
 * @param {{seq:number,digest:string}|null} anchor 独立维护的链头锚点，
 *        用于察觉“尾部记录被整体删除”这类仅凭块内容无法自证的缺口
 * @returns {Promise<{ok:true, head:object|null} | {
 *   ok:false, firstBadSeq:number, reason:string, trustedIndex:number, head:object|null}>}
 *   trustedIndex = 可信前缀长度（blocks[0..trustedIndex) 全部可信）
 */
export async function verifyChain(blocks, anchor = null) {
  if (!Array.isArray(blocks)) {
    throw new Error('chain 必须是数组');
  }
  let prevDigest = GENESIS_DIGEST;
  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i];
    const expectedSeq = i + 1;
    const head = i > 0 ? blocks[i - 1] : null;

    if (!block || typeof block !== 'object') {
      return { ok: false, firstBadSeq: expectedSeq, reason: 'record-malformed', trustedIndex: i, head };
    }
    if (block.seq !== expectedSeq) {
      // 中间记录被整体删除时后续序号前移，缺失的正是 expectedSeq。
      return { ok: false, firstBadSeq: expectedSeq, reason: 'seq-gap', trustedIndex: i, head };
    }
    if (block.prevDigest !== prevDigest) {
      return { ok: false, firstBadSeq: expectedSeq, reason: 'prev-digest-mismatch', trustedIndex: i, head };
    }
    let content;
    try {
      content = normalizeContent(block);
    } catch {
      return { ok: false, firstBadSeq: expectedSeq, reason: 'content-malformed', trustedIndex: i, head };
    }
    let digest;
    try {
      digest = await sha256Hex(digestInput(block.seq, block.prevDigest, content));
    } catch {
      return { ok: false, firstBadSeq: expectedSeq, reason: 'digest-error', trustedIndex: i, head };
    }
    if (block.digest !== digest) {
      return { ok: false, firstBadSeq: expectedSeq, reason: 'digest-mismatch', trustedIndex: i, head };
    }
    prevDigest = block.digest;
  }

  const head = headOf(blocks);
  if (anchor) {
    if (!head || anchor.seq !== head.seq) {
      // anchor 领先：尾部记录被整体删除；anchor 落后：崩溃在“链已落库、锚点未推进”
      // 的提交窗口内（落后在 reconcile 中按已提交处理，这里仅标记位置）。
      return {
        ok: false,
        firstBadSeq: blocks.length + 1,
        reason: anchor.seq > blocks.length ? 'tail-missing' : 'anchor-behind',
        trustedIndex: blocks.length,
        head,
      };
    }
    if (anchor.digest !== head.digest) {
      return {
        ok: false,
        firstBadSeq: blocks.length,
        reason: 'anchor-digest-mismatch',
        trustedIndex: blocks.length - 1,
        head: blocks.length > 1 ? blocks[blocks.length - 2] : null,
      };
    }
  }
  return { ok: true, head };
}

export function findByOpId(blocks, opId) {
  return blocks.find((b) => b && b.opId === opId) || null;
}
