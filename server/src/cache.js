'use strict';

/**
 * 版本化缓存 —— 解决"缓存回包乱序"：
 *  - 每次写入分配单调递增的 seq；
 *  - 迟到（seq 更小/相等）的写入被拒绝，旧回包不会覆盖新状态；
 *  - invalidate 留下 tombstone seq，失效后迟到的旧包无法复活该键；
 *  - 读取方（HTTP 层）把 seq 放进 X-Cache-Seq，客户端可据此丢弃乱序响应。
 */
class VersionedCache {
  constructor() {
    this.map = new Map();      // key -> { value, seq }
    this.tombstones = new Map(); // key -> 失效时的 seq
    this.seq = 0;
  }

  nextSeq() {
    return ++this.seq;
  }

  /**
   * 写入。若显式传入 seq（例如回源响应自带的版本），
   * 仅当它比当前条目与 tombstone 都新时才接受。
   * @returns {{accepted:boolean, seq:number, current?:object}}
   */
  set(key, value, seq) {
    const s = seq === undefined ? this.nextSeq() : seq;
    const cur = this.map.get(key);
    if (cur && s <= cur.seq) {
      return { accepted: false, seq: s, current: cur };
    }
    const tomb = this.tombstones.get(key);
    if (tomb !== undefined && s <= tomb) {
      return { accepted: false, seq: s, current: null };
    }
    const entry = { value, seq: s };
    this.map.set(key, entry);
    return { accepted: true, seq: s, entry };
  }

  get(key) {
    return this.map.get(key) || null;
  }

  /** 失效并记录 tombstone，拒绝之后到达的旧回包复活该键 */
  invalidate(key) {
    const cur = this.map.get(key);
    const tombSeq = Math.max(cur ? cur.seq : 0, this.nextSeq());
    this.map.delete(key);
    this.tombstones.set(key, tombSeq);
    return tombSeq;
  }

  /** 以某个前缀批量失效（如某街区下的所有缓存键） */
  invalidatePrefix(prefix) {
    const keys = new Set([...this.map.keys(), ...this.tombstones.keys()]);
    for (const key of keys) {
      if (key.startsWith(prefix)) this.invalidate(key);
    }
  }

  stats() {
    return { size: this.map.size, tombstones: this.tombstones.size, seq: this.seq };
  }
}

module.exports = { VersionedCache };
