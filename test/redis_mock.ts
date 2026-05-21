interface StoreEntry {
  value: string;
  expiresAt: number;
}

export class MockRedis {
  readonly store = new Map<string, StoreEntry>();
  readonly hashes = new Map<string, Record<string, string>>();
  readonly zsets = new Map<string, Map<string, number>>();

  private getEntry(key: string): string | null {
    const entry = this.store.get(key);
    if (!entry || entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  // Handles both: set(key, value, "EX", ttl) and the relay's old call shape
  // set(key, value, "EX", ttl, "NX", "GET"). We dispatch by argument count.
  set(
    key: string,
    value: string,
    _ex?: string,
    ttl?: number,
    nx?: string,
    _get?: string,
  ): Promise<string | null> {
    if (nx === "NX") {
      const current = this.getEntry(key);
      if (current !== null) return Promise.resolve(current);
    }
    const ttlMs = ttl && ttl > 0 ? ttl * 1000 : 60_000;
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
    return Promise.resolve(null);
  }

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.getEntry(key));
  }

  getdel(key: string): Promise<string | null> {
    const v = this.getEntry(key);
    this.store.delete(key);
    return Promise.resolve(v);
  }

  del(key: string): Promise<number> {
    let count = 0;
    if (this.store.delete(key)) count++;
    if (this.hashes.delete(key)) count++;
    if (this.zsets.delete(key)) count++;
    return Promise.resolve(count);
  }

  hset(key: string, fields: Record<string, string>): Promise<number> {
    const existing = this.hashes.get(key) ?? {};
    let added = 0;
    for (const [k, v] of Object.entries(fields)) {
      if (!(k in existing)) added++;
      existing[k] = String(v);
    }
    this.hashes.set(key, existing);
    return Promise.resolve(added);
  }

  hgetall(key: string): Promise<Record<string, string>> {
    return Promise.resolve(this.hashes.get(key) ?? {});
  }

  zadd(key: string, score: number, member: string): Promise<number> {
    const zset = this.zsets.get(key) ?? new Map<string, number>();
    const had = zset.has(member);
    zset.set(member, score);
    this.zsets.set(key, zset);
    return Promise.resolve(had ? 0 : 1);
  }

  zrem(key: string, member: string): Promise<number> {
    const zset = this.zsets.get(key);
    if (!zset) return Promise.resolve(0);
    const had = zset.delete(member);
    return Promise.resolve(had ? 1 : 0);
  }

  zrevrange(key: string, start: number, stop: number): Promise<string[]> {
    const zset = this.zsets.get(key);
    if (!zset) return Promise.resolve([]);
    const sorted = [...zset.entries()].sort((a, b) => b[1] - a[1]).map(([m]) => m);
    if (stop === -1) return Promise.resolve(sorted.slice(start));
    return Promise.resolve(sorted.slice(start, stop + 1));
  }

  expire(key: string, ttl: number): Promise<number> {
    const entry = this.store.get(key);
    if (!entry) return Promise.resolve(0);
    entry.expiresAt = Date.now() + ttl * 1000;
    return Promise.resolve(1);
  }
}
