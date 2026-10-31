import { DurableObject } from 'cloudflare:workers';
import { TransitStore } from './transit-store.mjs';
import { TransitEngine } from './transit.mjs';

/** A single SQLite-backed object: all heavy GTFS work runs outside the HTTP Worker's CPU budget. */
export class TransitCoordinator extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.engine = new TransitEngine(new TransitStore((sql, ...args) => ctx.storage.sql.exec(sql, ...args), work => ctx.storage.transactionSync(work))); }
  view(options) { return this.engine.view(options); }
  stops(q, origin) { return this.engine.stops(q, origin); }
  commutes() { return this.engine.commutes(); }
  async save(input, id) { const result = this.engine.save(input, id); await this.ctx.storage.setAlarm(Date.now() + 1000); return result; }
  remove(id) { this.engine.remove(id); }
  activate(id, event, now) { return this.engine.activate(id, event, now); }
  cancel() { this.engine.cancel(); }
  async ensureAlarm() { if (!await this.ctx.storage.getAlarm()) await this.ctx.storage.setAlarm(Date.now() + 1000); }
  async refresh() { await this.ctx.storage.setAlarm(Date.now() + 1000); }
  async alarm() {
    // Re-arm before network I/O. A failed invocation/restart cannot strand the poller.
    await this.ctx.storage.setAlarm(Date.now() + 60_000);
    await this.engine.tick();
  }
}

