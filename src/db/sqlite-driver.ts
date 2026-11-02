/**
 * SQLite implementation of DatabaseDriver using better-sqlite3.
 *
 * The native operations are synchronous. A connection queue keeps asynchronous
 * transaction callbacks isolated from unrelated requests on the same driver.
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { DatabaseDriver, RunResult } from './driver.js';

interface TransactionFrame {
  active: boolean;
  childOpen: boolean;
  child?: Promise<void>;
}

export class SqliteDriver implements DatabaseDriver {
  readonly dialect = 'sqlite' as const;
  private db: Database.Database;
  private queue: Promise<void> = Promise.resolve();
  private owner = new AsyncLocalStorage<{ active: boolean }>();
  private transactionFrame = new AsyncLocalStorage<TransactionFrame>();
  private savepoint = 0;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
  }

  async run(sql: string, params: unknown[] = []): Promise<RunResult> {
    return this.exclusive(() => {
      const result = this.db.prepare(sql).run(...params);
      return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
    });
  }

  async get<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    return this.exclusive(() => this.db.prepare(sql).get(...params) as T | undefined);
  }

  async all<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.exclusive(() => this.db.prepare(sql).all(...params) as T[]);
  }

  async exec(sql: string): Promise<void> {
    await this.exclusive(() => { this.db.exec(sql); });
  }

  async transaction<T>(fn: (driver: DatabaseDriver) => Promise<T>): Promise<T> {
    return this.exclusive(async () => {
      const nested = this.db.inTransaction;
      const parent = this.transactionFrame.getStore();
      if (nested && (!parent?.active || parent.childOpen)) {
        throw new Error('Concurrent nested SQLite transactions are not supported; await each nested transaction');
      }
      let releaseChild: (() => void) | undefined;
      if (nested && parent) {
        parent.childOpen = true;
        parent.child = new Promise<void>(resolve => { releaseChild = resolve; });
      }
      const frame: TransactionFrame = { active: true, childOpen: false };
      const name = `hxa_sp_${++this.savepoint}`;
      let opened = false;
      try {
        this.db.exec(nested ? `SAVEPOINT ${name}` : 'BEGIN IMMEDIATE');
        opened = true;
        const result = await this.transactionFrame.run(frame, () => fn(this));
        if (frame.child) await frame.child;
        this.db.exec(nested ? `RELEASE SAVEPOINT ${name}` : 'COMMIT');
        return result;
      } catch (err) {
        // If Promise.all rejects because a parallel nested transaction was
        // refused, let the already-open child finish before rolling back.
        if (frame.child) await frame.child;
        if (opened && nested) {
          this.db.exec(`ROLLBACK TO SAVEPOINT ${name}`);
          this.db.exec(`RELEASE SAVEPOINT ${name}`);
        } else if (opened) {
          this.db.exec('ROLLBACK');
        }
        throw err;
      } finally {
        frame.active = false;
        if (nested && parent) {
          parent.childOpen = false;
          releaseChild?.();
        }
      }
    }, true);
  }

  /**
   * A resolved Promise still yields at await. Serialize every connection access,
   * including non-transactional session operations, so another request cannot
   * accidentally read/write inside a transaction it does not own.
   */
  private async exclusive<T>(fn: () => T | Promise<T>, transactionEntry = false): Promise<T> {
    const frame = this.transactionFrame.getStore();
    if (this.owner.getStore()?.active && (!frame || frame.active)) {
      if (frame?.childOpen && !transactionEntry) {
        throw new Error('Cannot access SQLite from a parent transaction while a nested transaction is active; await the nested transaction');
      }
      return fn();
    }
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>(resolve => { release = resolve; });
    await previous;
    const context = { active: true };
    try {
      return await this.owner.run(context, fn);
    } finally {
      // Detached asynchronous children retain their ALS store. They must queue
      // normally once this transaction/operation has released the connection.
      context.active = false;
      release();
    }
  }

  async isHealthy(): Promise<boolean> {
    try {
      await this.exclusive(() => this.db.prepare('SELECT 1').get());
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.exclusive(() => { this.db.close(); });
  }
}
