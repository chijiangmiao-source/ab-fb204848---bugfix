// verify/verify.js
// Compose 中名为 verify 的单次服务入口：
//   1) 复算并发幂等、异参冲突、断链边界等场景
//   2) 执行代码测试
//   3) 构建检查（语法 / 页面引用资源存在 / JSON 合法）
//   4) 启动应用做 HTTP 冒烟
// 任一步失败即以非零退出码结束。

import { spawn } from 'node:child_process';
import { readdir, readFile, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runScenarios } from './scenarios.js';
import { start } from '../src/server.js';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');

const C_RESET = '\x1b[0m';
const C_GREEN = '\x1b[32m';
const C_RED = '\x1b[31m';
const C_CYAN = '\x1b[36m';
let failures = 0;

function section(title) {
  console.log(`\n${C_CYAN}=== ${title} ===${C_RESET}`);
}
function report(name, ok, detail = '') {
  const mark = ok ? `${C_GREEN}PASS${C_RESET}` : `${C_RED}FAIL${C_RESET}`;
  console.log(`  [${mark}] ${name}${detail && !ok ? `  -- ${detail}` : ''}`);
  if (!ok) failures += 1;
}

async function walk(dir, suffix) {
  const out = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const abs = join(dir, e.name);
    if (e.isDirectory()) out.push(...await walk(abs, suffix));
    else if (e.name.endsWith(suffix)) out.push(abs);
  }
  return out;
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function stepScenarios() {
  section('1/4 场景复算（并发幂等 / 异参冲突 / 断链边界 / 崩溃原子性）');
  const checks = await runScenarios();
  for (const c of checks) report(c.name, c.ok, c.detail);
}

async function stepTests() {
  section('2/4 代码测试（node --test）');
  const r = await run(process.execPath, ['--test', 'test/chain.test.js', 'test/storage.test.js']);
  const lines = r.stdout.split('\n');
  const summary = lines.filter((l) => l.startsWith('# ')).join('\n');
  console.log(summary.split('\n').map((l) => `  ${l}`).join('\n'));
  const passLine = lines.find((l) => l.startsWith('# pass'));
  const failLine = lines.find((l) => l.startsWith('# fail'));
  report('node --test 退出码为 0', r.code === 0, r.stderr.slice(-400));
  report('测试用例全部通过', Boolean(failLine && /^# fail 0$/.test(failLine.trim())), failLine);
  report('存在已执行的通过用例', Boolean(passLine && !/# pass 0$/.test(passLine.trim())), passLine);
}

async function stepBuild() {
  section('3/4 构建检查');
  const dirs = ['lib', 'src', 'web', 'verify', 'test'].map((d) => join(ROOT, d));
  let jsFiles = [];
  for (const d of dirs) {
    try {
      jsFiles.push(...await walk(d, '.js'));
    } catch { /* 目录不存在则跳过 */ }
  }
  let syntaxFail = null;
  for (const f of jsFiles) {
    const r = await run(process.execPath, ['--check', f]);
    if (r.code !== 0) {
      syntaxFail = `${f}: ${r.stderr.trim()}`;
      break;
    }
  }
  report(`全部 ${jsFiles.length} 个 JS 文件语法检查通过`, syntaxFail === null, syntaxFail);

  // package.json 合法
  let pkgOk = true;
  try { JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')); }
  catch (e) { pkgOk = false; syntaxFail = e.message; }
  report('package.json 是合法 JSON', pkgOk, syntaxFail);

  // 页面引用的本地资源必须存在（防止构建出 404）
  const html = await readFile(join(ROOT, 'web', 'index.html'), 'utf8');
  const refs = [...html.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map((m) => m[1]);
  let missing = null;
  for (const ref of refs) {
    const rel = ref.startsWith('/lib/') ? ref.slice(1) : join('web', ref.slice(1));
    try {
      await access(join(ROOT, rel));
    } catch {
      missing = ref;
      break;
    }
  }
  report(`页面引用资源存在（${refs.join(', ')}）`, missing === null, `缺失 ${missing}`);

  // 前端入口的模块导入可达
  const app = await readFile(join(ROOT, 'web', 'app.js'), 'utf8');
  const imports = [...app.matchAll(/from\s+'(\/[^']+)'/g)].map((m) => m[1]);
  let badImport = null;
  for (const imp of imports) {
    try {
      await access(join(ROOT, imp.slice(1)));
    } catch {
      badImport = imp;
      break;
    }
  }
  report('前端模块导入路径可达', badImport === null, `缺失 ${badImport}`);
  void dirname;
}

async function get(base, path) {
  const res = await fetch(`${base}${path}`);
  const body = await res.text();
  return { status: res.status, body, headers: res.headers };
}

async function stepHttp() {
  section('4/4 HTTP 冒烟');
  const appUrl = process.env.APP_URL || '';
  let server = null;
  let base;
  if (appUrl) {
    // Compose 中对 app 容器做真实冒烟，等待其就绪
    base = appUrl.replace(/\/$/, '');
    await waitReady(base);
  } else {
    const port = Number(process.env.SMOKE_PORT || 8091);
    try {
      server = await start(port, '127.0.0.1');
    } catch (e) {
      report('测试服务器启动', false, e.message);
      return;
    }
    base = `http://127.0.0.1:${port}`;
  }
  try {
    const h = await get(base, '/healthz');
    report('GET /healthz -> 200 {"status":"ok"}',
      h.status === 200 && JSON.parse(h.body).status === 'ok',
      `status=${h.status} body=${h.body}`);

    const home = await get(base, '/');
    report('GET / -> 200 页面',
      home.status === 200 && home.body.includes('辐照实验剂量见证台账'),
      `status=${home.status}`);
    report('页面以 UTF-8 提供', /charset=utf-8/.test(home.headers.get('content-type') || ''));

    const appJs = await get(base, '/app.js');
    report('GET /app.js -> 200', appJs.status === 200 && appJs.body.includes('LedgerStorage'));

    const chainJs = await get(base, '/lib/chain.js');
    report('GET /lib/chain.js -> 200', chainJs.status === 200 && chainJs.body.includes('verifyChain'));

    const css = await get(base, '/styles.css');
    report('GET /styles.css -> 200', css.status === 200);

    const nf = await get(base, '/no-such-file');
    report('未知路径 -> 404', nf.status === 404);

    const trav = await get(base, '/../package.json');
    report('目录穿越被拒绝', trav.status === 403 || trav.status === 404, `status=${trav.status}`);
  } catch (e) {
    report('HTTP 冒烟请求', false, e.message);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
  }
}

async function waitReady(base) {
  const deadline = Date.now() + 15000;
  for (;;) {
    try {
      const res = await fetch(`${base}/healthz`);
      if (res.ok) return;
    } catch { /* 尚未就绪，重试 */ }
    if (Date.now() > deadline) throw new Error(`等待 ${base}/healthz 就绪超时`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function main() {
  console.log(`${C_CYAN}verify 单次服务开始${C_RESET}`);
  await stepScenarios();
  await stepTests();
  await stepBuild();
  await stepHttp();

  console.log(`\n${C_CYAN}=== 汇总 ===${C_RESET}`);
  if (failures === 0) {
    console.log(`${C_GREEN}全部检查通过，verify 以退出码 0 结束${C_RESET}`);
    process.exit(0);
  }
  console.log(`${C_RED}${failures} 项检查失败，verify 以退出码 1 结束${C_RESET}`);
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
