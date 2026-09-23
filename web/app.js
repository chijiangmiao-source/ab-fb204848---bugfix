// web/app.js
// 页面逻辑：表单、连续序号、前序/当前摘要、本标签页提交状态、断链展示。
import { LedgerStorage, LedgerError } from '/lib/storage.js';
import { computeDigest, GENESIS_DIGEST } from '/lib/chain.js';

const $ = (sel) => document.querySelector(sel);

function getPeerId() {
  const KEY = 'irrad.peerId';
  let id = sessionStorage.getItem(KEY);
  if (!id) {
    id = `tab-${Math.random().toString(36).slice(2, 10)}`;
    sessionStorage.setItem(KEY, id);
  }
  return id;
}

const peerId = getPeerId();
$('#peerId').textContent = peerId;

// 本标签页自己的提交跟踪（仅 sessionStorage，随标签页生命周期结束）。
const TAB_QUEUE_KEY = 'irrad.tabQueue.v1';
function loadTabQueue() {
  try { return JSON.parse(sessionStorage.getItem(TAB_QUEUE_KEY)) || []; }
  catch { return []; }
}
function saveTabQueue(queue) {
  sessionStorage.setItem(TAB_QUEUE_KEY, JSON.stringify(queue));
}
let tabQueue = loadTabQueue();

const reasonText = {
  'seq-gap': '序号断号（疑似记录缺失）',
  'tail-missing': '尾部记录缺失',
  'prev-digest-mismatch': '前序摘要不符（疑似分叉）',
  'digest-mismatch': '摘要不符（疑似内容被改）',
  'anchor-digest-mismatch': '链头锚点摘要不符',
  'content-malformed': '业务内容畸形',
  'record-malformed': '记录畸形',
  'digest-malformed': '摘要格式畸形',
  'storage-corrupt': '本地存储损坏',
  'anchor-corrupt': '链头锚点损坏',
  'quarantine-rebuilt': '冻结标记损坏，已按隔离后缀重建冻结',
};

function short(hash) {
  return hash ? `${hash.slice(0, 10)}…${hash.slice(-6)}` : '—';
}

function rowHtml(block) {
  return `<tr>
    <td>${block.seq}</td>
    <td>${escapeHtml(block.instrument)}</td>
    <td>${block.dose}</td>
    <td>${escapeHtml(block.operator)}</td>
    <td>${escapeHtml(block.opId)}</td>
    <td class="mono" title="${block.prevDigest}">${short(block.prevDigest)}</td>
    <td class="mono" title="${block.digest}">${short(block.digest)}</td>
  </tr>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

let ledger;

async function render() {
  const state = ledger.readState();
  const frozen = state.status === 'frozen';

  $('#chainStatus').textContent = frozen
    ? `已冻结（${reasonText[state.quarantine.reason] || state.quarantine.reason}）`
    : state.status === 'unreadable' ? '存储不可读' : '正常';
  $('#chainStatus').style.color = frozen ? 'var(--danger)' : 'var(--ok)';
  $('#nextSeq').textContent = frozen ? '—' : state.nextSeq;
  $('#headSeq').textContent = state.head ? `#${state.head.seq}` : '（创世）';
  $('#prevDigest').textContent = frozen
    ? (state.head ? `${state.head.digest}（#${state.head.seq}）` : `${GENESIS_DIGEST}（创世）`)
    : state.prevDigest;
  $('#prevDigest').title = frozen && state.head ? state.head.digest : state.prevDigest;

  $('#chainBody').innerHTML = state.chain.length
    ? state.chain.map(rowHtml).join('')
    : '<tr><td colspan="7" style="color:var(--muted)">暂无记录，下一条为创世记录 #1</td></tr>';

  const banner = $('#freezeBanner');
  banner.hidden = !frozen;
  if (frozen) {
    const q = state.quarantine;
    $('#freezeDetail').textContent =
      ` 首个坏序号：#${q.firstBadSeq}（${reasonText[q.reason] || q.reason}）；` +
      `其后 ${state.suffix.length} 条已隔离；最后可信链头：` +
      `${q.trustedHead ? `#${q.trustedHead.seq} ${q.trustedHead.digest}` : '创世锚点'}。`;
    $('#h-suffix').hidden = false;
    $('#suffixWrap').hidden = false;
    $('#suffixBody').innerHTML = state.suffix.length
      ? state.suffix.map(rowHtml).join('')
      : '<tr><td colspan="7" style="color:var(--muted)">后缀为空（坏位置无记录，如尾部缺失）</td></tr>';
    $('#btnSubmit').disabled = true;
  } else {
    $('#h-suffix').hidden = true;
    $('#suffixWrap').hidden = true;
    $('#btnSubmit').disabled = false;
  }
}

function renderTabQueue() {
  const ul = $('#tabQueue');
  if (!tabQueue.length) {
    ul.innerHTML = '<li class="empty">本标签页暂无提交</li>';
    return;
  }
  const badge = {
    pending: '<span class="badge badge-pending">排队/写入中…</span>',
    committed: '<span class="badge badge-committed">已落库</span>',
    reused: '<span class="badge badge-reused">幂等返回原记录</span>',
    failed: '<span class="badge badge-failed">已拒绝</span>',
    frozen: '<span class="badge badge-frozen">断链冻结</span>',
  };
  ul.innerHTML = tabQueue.map((item) => {
    const detail = item.seq ? `#${item.seq}` : '未定序号';
    const err = item.error ? ` <span class="inline-msg">${escapeHtml(item.error)}</span>` : '';
    return `<li><span title="${escapeHtml(item.opId)}">${detail} · ${escapeHtml(item.opId)}${err}</span>${badge[item.status] || ''}</li>`;
  }).join('');
}

function updatePreview() {
  const form = $('#ledgerForm');
  const doseRaw = form.dose.value.trim();
  const dose = Number(doseRaw);
  const input = {
    instrument: form.instrument.value,
    dose,
    operator: form.operator.value,
    opId: form.opId.value,
  };
  if (!form.instrument.value.trim() || !form.operator.value.trim() || !form.opId.value.trim()
    || !Number.isSafeInteger(dose) || dose < 0) {
    $('#previewDigest').textContent = '（表单不完整或剂量不是非负整数）';
    return;
  }
  const state = ledger.readState();
  computeDigest(state.nextSeq, state.prevDigest, input)
    .then((d) => { $('#previewDigest').textContent = d; })
    .catch(() => { $('#previewDigest').textContent = '无法计算'; });
}

// 标签页重新打开：刷新时把会话内 pending 项按链上实际状态归位。
// 存储层 reconcile 已保证在途意图要么对应完整记录、要么按完全无记录回滚，
// 因此链上找不到的 pending 只能是刷新前未落库、已回滚的提交。
function reconcileTabQueue(state) {
  let changed = false;
  for (const item of tabQueue) {
    if (item.status !== 'pending') continue;
    const block = state.chain.find((b) => b.opId === item.opId);
    if (block) {
      item.status = 'committed';
      item.seq = block.seq;
      changed = true;
    } else if (state.status === 'frozen') {
      item.status = 'frozen';
      item.error = '断链冻结中，未追加';
      changed = true;
    } else {
      item.status = 'failed';
      item.error = '刷新/关闭前未落库，已回滚为无记录，可重新提交';
      changed = true;
    }
  }
  if (changed) saveTabQueue(tabQueue);
}

async function boot() {
  ledger = new LedgerStorage({
    storage: localStorage,
    peerId,
    onExternalChange: async (state) => {
      // 只刷新视图；本标签页 pending 项由其自身提交 Promise 或启动复算归位，
      // 避免并发同 opId 时把在途提交误判为失败。
      renderTabQueue();
      await render();
      $('#lastEvent').textContent = `已同步其它标签页的落库 · ${new Date().toLocaleTimeString()}`;
    },
  });

  const state = await ledger.start();
  reconcileTabQueue(state);
  await render();
  renderTabQueue();

  $('#ledgerForm').addEventListener('input', updatePreview);

  $('#ledgerForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const input = {
      instrument: form.instrument.value,
      dose: Number(form.dose.value),
      operator: form.operator.value,
      opId: form.opId.value,
    };
    const item = { opId: input.opId, status: 'pending', seq: null, error: null };
    tabQueue.unshift(item);
    saveTabQueue(tabQueue);
    renderTabQueue();
    $('#formError').hidden = true;
    $('#btnSubmit').disabled = true;
    try {
      const { block, reused } = await ledger.submit(input);
      item.status = reused ? 'reused' : 'committed';
      item.seq = block.seq;
      // 迟到/重复提交命中同内容原记录时，把本标签页其余同 opId pending 一并归位
      for (const other of tabQueue) {
        if (other !== item && other.status === 'pending' && other.opId === input.opId) {
          other.status = 'reused';
          other.seq = block.seq;
        }
      }
    } catch (err) {
      if (err instanceof LedgerError && err.code === 'OPID_CONFLICT') {
        item.status = 'failed';
        item.error = '异参冲突：该操作标识已关联不同内容，链头未改变';
      } else if (err instanceof LedgerError && err.code === 'FROZEN') {
        item.status = 'frozen';
        item.error = '断链冻结中';
      } else if (err instanceof LedgerError && err.code === 'VALIDATION') {
        item.status = 'failed';
        item.error = err.message;
      } else {
        item.status = 'failed';
        item.error = (err && err.message) || '提交失败';
      }
      $('#formError').textContent = item.error;
      $('#formError').hidden = false;
    } finally {
      $('#btnSubmit').disabled = ledger.readState().status === 'frozen';
      saveTabQueue(tabQueue);
      renderTabQueue();
      await render();
      updatePreview();
    }
  });

  $('#btnReverify').addEventListener('click', async () => {
    $('#btnReverify').disabled = true;
    try {
      await ledger.reverify();
      $('#reverifyMsg').textContent = `复算完成 · ${new Date().toLocaleTimeString()}`;
    } finally {
      $('#btnReverify').disabled = false;
      await render();
    }
  });

  updatePreview();
}

boot().catch((err) => {
  $('#formError').textContent = `初始化失败：${err && err.message}`;
  $('#formError').hidden = false;
});
