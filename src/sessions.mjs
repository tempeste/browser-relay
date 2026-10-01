import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_DIR } from './config.mjs';

// IDs survive a relay restart. Ownership survives separately in the extension.
export class Sessions {
  constructor() {
    this.file = join(CONFIG_DIR, 'sessions.json');
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    try {
      this.items = new Map(JSON.parse(readFileSync(this.file, 'utf8')).map((s) => [s.id, s]));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      this.items = new Map();
    }
  }

  get(id) {
    const session = this.items.get(id);
    if (!session) throw new Error('Unknown sessionId; create a named session first');
    return session;
  }

  create(name) {
    if (typeof name !== 'string' || !name.trim() || name.length > 80 || /[\x00-\x1f\x7f]/.test(name)) {
      throw new Error('Session name must contain 1–80 printable characters');
    }
    const session = { id: randomUUID(), name: name.trim() };
    this.items.set(session.id, session);
    this.persist();
    return session;
  }

  remove(id) {
    this.items.delete(id);
    this.persist();
  }

  persist() {
    writeFileSync(`${this.file}.tmp`, JSON.stringify([...this.items.values()]), { mode: 0o600 });
    renameSync(`${this.file}.tmp`, this.file);
  }
}
