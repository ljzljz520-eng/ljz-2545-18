'use strict';

// 缓存/回包乱序防护：
// 每个 key 维护单调版本号；过期响应即使后到也必须被丢弃，避免旧面包屑覆盖新树。
class ResponseGuard {
  constructor() {
    this.serial = new Map(); // key -> 最新序号
  }

  // 发起请求时领取序号
  begin(key) {
    const seq = (this.serial.get(key) || 0) + 1;
    this.serial.set(key, seq);
    return seq;
  }

  // 回包到达时校验：仅序号等于最新值才允许提交
  isCurrent(key, seq) {
    return this.serial.get(key) === seq;
  }

  commit(key, seq, payload) {
    if (!this.isCurrent(key, seq)) {
      return { stale: true, payload: null };
    }
    return { stale: false, payload };
  }

  invalidate(key) {
    this.serial.delete(key);
  }
}

// 章节树缓存：按 treeVersion 失效；章节移动后所有树缓存立即作废
class TreeCache {
  constructor() {
    this.entries = new Map(); // key -> { version, value }
  }

  get(key, knownVersion) {
    const hit = this.entries.get(key);
    if (!hit) return { hit: false };
    if (knownVersion != null && hit.version !== knownVersion) {
      this.entries.delete(key);
      return { hit: false, stale: true };
    }
    return { hit: true, value: hit.value, version: hit.version };
  }

  set(key, version, value) {
    this.entries.set(key, { version, value });
    return value;
  }

  // 任意章节移动/发布/撤回后调用
  bust() {
    this.entries.clear();
  }
}

module.exports = { ResponseGuard, TreeCache };
