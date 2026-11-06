'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Optional, dependency-free JSON persistence.
 *
 * The app is designed to run with an empty environment, so persistence is
 * opt-in through DATA_FILE. When enabled, writes are debounced and atomic
 * (write to a temporary file, then rename) so a crash cannot leave a partial
 * JSON document behind.
 */
class FilePersistence {
  constructor(filePath, { fsImpl = fs, debounceMs = 40, logger = console } = {}) {
    if (!filePath) throw new Error('FilePersistence requires a file path');
    this.filePath = path.resolve(filePath);
    this.fs = fsImpl;
    this.debounceMs = Math.max(0, Number(debounceMs) || 0);
    this.logger = logger;
    this.timer = null;
    this.pending = null;
    this.writing = Promise.resolve();
  }

  load() {
    try {
      const raw = this.fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.invoices)) return null;
      return parsed;
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
      this.logger.warn?.(`[persistence] ignoring unreadable store: ${error.code || error.name}`);
      return null;
    }
  }

  scheduleSave(snapshot) {
    this.pending = snapshot;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const payload = this.pending;
      this.pending = null;
      this.writing = this.writing.then(() => this.writeSnapshot(payload)).catch((error) => {
        this.logger.warn?.(`[persistence] save failed: ${error.code || error.name}`);
      });
    }, this.debounceMs);
    this.timer.unref?.();
  }

  async writeSnapshot(snapshot) {
    if (!snapshot) return;
    const directory = path.dirname(this.filePath);
    await this.fs.promises.mkdir(directory, { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await this.fs.promises.writeFile(temporary, JSON.stringify(snapshot, null, 2), 'utf8');
    await this.fs.promises.rename(temporary, this.filePath);
  }

  async flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pending) {
      const payload = this.pending;
      this.pending = null;
      this.writing = this.writing.then(() => this.writeSnapshot(payload));
    }
    await this.writing;
  }
}

function persistenceFromEnvironment(env = process.env, options = {}) {
  return env.DATA_FILE ? new FilePersistence(env.DATA_FILE, options) : null;
}

module.exports = { FilePersistence, persistenceFromEnvironment };
