// test/helpers/memory-store.js
// 模拟多个浏览器标签页共享的 localStorage：
// 后端数据共享，storage 事件只派发给“其它”标签页（异步派发，与浏览器一致）。

class Backend {
  constructor() {
    this.map = new Map();
    this.tabs = new Set();
  }
}

export class MemoryTabStorage {
  constructor(backend) {
    this.backend = backend;
    this.listeners = new Set();
    backend.tabs.add(this);
  }

  get length() {
    return this.backend.map.size;
  }

  key(i) {
    return [...this.backend.map.keys()][i] ?? null;
  }

  getItem(key) {
    return this.backend.map.has(key) ? this.backend.map.get(key) : null;
  }

  setItem(key, value) {
    const oldValue = this.backend.map.has(key) ? this.backend.map.get(key) : null;
    this.backend.map.set(key, String(value));
    this.dispatchLater(key, oldValue, String(value));
  }

  removeItem(key) {
    const oldValue = this.backend.map.has(key) ? this.backend.map.get(key) : null;
    this.backend.map.delete(key);
    this.dispatchLater(key, oldValue, null);
  }

  clear() {
    const snapshot = [...this.backend.map.entries()];
    this.backend.map.clear();
    for (const [key, oldValue] of snapshot) {
      this.dispatchLater(key, oldValue, null);
    }
  }

  addListener(fn) {
    this.listeners.add(fn);
  }

  removeListener(fn) {
    this.listeners.delete(fn);
  }

  dispatchLater(key, oldValue, newValue) {
    if (oldValue === newValue) return;
    const event = { key, oldValue, newValue, storageArea: this.backend.map };
    for (const tab of this.backend.tabs) {
      if (tab === this) continue; // 本标签页不收到自己的 storage 事件
      for (const fn of tab.listeners) {
        queueMicrotask(() => {
          try { fn(event); } catch { /* 与浏览器一致，事件异常不外泄 */ }
        });
      }
    }
  }
}

export function createTabs(n, timing) {
  const backend = new Backend();
  const tabs = [];
  for (let i = 0; i < n; i += 1) {
    tabs.push(new MemoryTabStorage(backend));
  }
  return { backend, tabs };
}
