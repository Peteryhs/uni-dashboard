import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OfficeHoursEditor } from '../apps/web/src/lib/office-hours-editor.ts';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const config = (ids) => ({ version: 1, rules: ids.map((id) => ({ id, label: id })) });
const appendDraft = (current) => ({ ...current, rules: [...current.rules, { id: 'draft', label: 'Draft' }] });
const ids = (editor) => editor.getSnapshot().config.rules.map((rule) => rule.id);

test('a ready draft cannot replace rules while the initial configuration is still loading', async () => {
  const response = deferred();
  let writes = 0;
  const editor = new OfficeHoursEditor({ load: () => response.promise, save: async (value) => { writes++; return { config: value }; } });
  const loading = editor.load();
  assert.equal(await editor.save(appendDraft), null);
  assert.equal(writes, 0);
  response.resolve(config(['existing']));
  await loading;
  await editor.save(appendDraft);
  assert.deepEqual(ids(editor), ['existing', 'draft']);
  assert.equal(writes, 1);
});

test('a failed initial load keeps all writes blocked until a successful retry', async () => {
  let reads = 0, writes = 0;
  const editor = new OfficeHoursEditor({
    load: async () => { if (++reads === 1) throw new Error('Synthetic offline'); return config(['existing']); },
    save: async (value) => { writes++; return { config: value }; },
  });
  await editor.load();
  assert.equal(editor.getSnapshot().loaded, false);
  assert.match(editor.getSnapshot().error, /offline/);
  assert.equal(await editor.save(appendDraft), null);
  assert.equal(writes, 0);
  await editor.load();
  await editor.save(appendDraft);
  assert.deepEqual(ids(editor), ['existing', 'draft']);
});

test('an older GET cannot overwrite a newer load or a completed save even if abort is ignored', async () => {
  const older = deferred(), newer = deferred();
  const signals = [];
  const editor = new OfficeHoursEditor({
    load: (signal) => { signals.push(signal); return signals.length === 1 ? older.promise : newer.promise; },
    save: async (value) => ({ config: value }),
  });
  const first = editor.load(), second = editor.load();
  assert.equal(signals[0].aborted, true);
  newer.resolve(config(['newer']));
  await second;
  await editor.save(appendDraft);
  older.resolve(config(['obsolete']));
  await first;
  assert.deepEqual(ids(editor), ['newer', 'draft']);
});

test('overlapping mutations are blocked synchronously and a load cannot race a pending save', async () => {
  const response = deferred();
  let reads = 0, writes = 0;
  const editor = new OfficeHoursEditor({
    load: async () => { reads++; return config(['existing']); },
    save: () => { writes++; return response.promise; },
  });
  await editor.load();
  const saving = editor.save(appendDraft);
  assert.equal(editor.getSnapshot().saving, true);
  assert.equal(await editor.save(appendDraft), null);
  await editor.load();
  assert.equal(reads, 1);
  assert.equal(writes, 1);
  response.resolve({ config: { ...config(['existing', 'draft']), rules: [{ id: 'existing', updated_at: 123 }, { id: 'draft', updated_at: 123 }] } });
  await saving;
  assert.deepEqual(ids(editor), ['existing', 'draft']);
  assert.equal(editor.getSnapshot().config.rules[1].updated_at, 123, 'adopt the server-normalized document');
});

test('cancelled requests cannot publish into a later mount or restore saving state', async () => {
  const response = deferred();
  let writes = 0, signal;
  const editor = new OfficeHoursEditor({
    load: async () => config(writes ? ['fresh'] : ['existing']),
    save: (_value, abortSignal) => { writes++; signal = abortSignal; return response.promise; },
  });
  await editor.load();
  const saving = editor.save(appendDraft);
  editor.cancel();
  assert.equal(signal.aborted, true);
  await editor.load();
  response.resolve({ config: config(['obsolete-save']) });
  assert.equal(await saving, null);
  assert.deepEqual(ids(editor), ['fresh']);
  assert.equal(editor.getSnapshot().saving, false);
});

test('a cancelled initial load can be restarted, as required by React StrictMode', async () => {
  const obsolete = deferred();
  let reads = 0;
  const editor = new OfficeHoursEditor({
    load: () => ++reads === 1 ? obsolete.promise : Promise.resolve(config(['fresh'])),
    save: async (value) => ({ config: value }),
  });
  const oldLoad = editor.load();
  editor.cancel();
  await editor.load();
  obsolete.reject(new Error('Late rejected request'));
  await oldLoad;
  assert.deepEqual(ids(editor), ['fresh']);
  assert.equal(editor.getSnapshot().error, null);
});

test('failed saves preserve the loaded document and allow a safe retry', async () => {
  let writes = 0;
  const editor = new OfficeHoursEditor({
    load: async () => config(['existing']),
    save: async (value) => { if (++writes === 1) throw new Error('Synthetic rejected write'); return { config: value }; },
  });
  await editor.load();
  await assert.rejects(editor.save(appendDraft), /rejected write/);
  assert.deepEqual(ids(editor), ['existing']);
  assert.equal(editor.getSnapshot().loaded, true);
  assert.equal(editor.getSnapshot().saving, false);
  await editor.save(appendDraft);
  assert.deepEqual(ids(editor), ['existing', 'draft']);
  assert.equal(editor.getSnapshot().error, null);
});
