export class RpcCache {
  constructor(defaultTtlMs = 5000) {
    this.cache = new Map();
    this.defaultTtlMs = defaultTtlMs;
    this.hits = 0;
    this.misses = 0;
  }

  get(key) {
    const entry = this.cache.get(key);
    if (!entry) {
      this.misses++;
      return null;
    }
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      this.misses++;
      return null;
    }
    this.hits++;
    return entry.value;
  }

  set(key, value, ttlMs) {
    const ttl = ttlMs !== undefined ? ttlMs : this.defaultTtlMs;
    this.cache.set(key, { value, expiresAt: Date.now() + ttl });
  }

  clear() {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
  }
}
