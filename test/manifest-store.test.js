'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const { ManifestStore } = require('../dist/core/manifest-store.js');
const { nativePath } = require('../dist/core/io.js');

const sandboxes = [];
after(async () => {
  for (const dir of sandboxes) {
    await fs.rm(nativePath(dir), { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
});

function logger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

async function sandbox() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fpdt-store-'));
  sandboxes.push(root);
  return root;
}

function entry(marker) {
  return { hash: marker.repeat(32), size: 4096, mtimeMs: 1_700_000_000_000 };
}

/** Write a manifest the way the store expects to find it, outside the store. */
async function writeManifestFile(file, files, profile = 'default') {
  const data = { version: 1, profile, updatedAt: new Date().toISOString(), files };
  await fs.mkdir(path.dirname(nativePath(file)), { recursive: true });
  await fs.writeFile(nativePath(file), JSON.stringify(data), 'utf8');
}

/** Force a distinct mtime so a same-size rewrite is still detectable. */
async function touchFuture(file, seconds = 10) {
  const when = new Date(Date.now() + seconds * 1000);
  await fs.utimes(nativePath(file), when, when);
}

test('an unchanged manifest is parsed once and reused', async () => {
  const file = path.join(await sandbox(), 'manifest.json');
  await writeManifestFile(file, { 'R/a/b.sol': entry('a') });

  const store = new ManifestStore(logger());
  const first = await store.load(file, 'default');
  const second = await store.load(file, 'default');

  assert.equal(second, first, 'the cached bundle is returned, not a new parse');
  assert.equal(second.index, first.index);
  assert.equal(store.residentManifests, 1);
  assert.equal(first.index.entries.size, 1);
});

test('an external rewrite is noticed even when the size is unchanged', async () => {
  const file = path.join(await sandbox(), 'manifest.json');
  await writeManifestFile(file, { 'R/a/b.sol': entry('a') });

  const store = new ManifestStore(logger());
  const first = await store.load(file, 'default');
  assert.equal(first.index.entries.get('r/a/b.sol').hash, 'a'.repeat(32));

  // Different hash, identical byte length: only the mtime gives this away.
  await writeManifestFile(file, { 'R/a/b.sol': entry('b') });
  await touchFuture(file);

  const second = await store.load(file, 'default');
  assert.notEqual(second, first);
  assert.equal(second.index.entries.get('r/a/b.sol').hash, 'b'.repeat(32));
});

test('save writes through and keeps the new state resident', async () => {
  const file = path.join(await sandbox(), 'manifest.json');
  const store = new ManifestStore(logger());

  const base = new Map([['r/a/b.sol', entry('c')]]);
  const keys = new Map([['r/a/b.sol', 'R/a/b.sol']]);
  await store.save(file, 'default', base, keys);

  const onDisk = JSON.parse(await fs.readFile(nativePath(file), 'utf8'));
  assert.deepEqual(Object.keys(onDisk.files), ['R/a/b.sol']);

  const loaded = await store.load(file, 'default');
  assert.equal(loaded.index.entries, base, 'the saved maps are the resident copy');
  assert.equal(loaded.index.keys, keys);
  assert.equal(loaded.data.updatedAt, onDisk.updatedAt);
});

test('invalidate drops the resident copy', async () => {
  const file = path.join(await sandbox(), 'manifest.json');
  await writeManifestFile(file, { 'R/a/b.sol': entry('a') });

  const store = new ManifestStore(logger());
  const base = new Map([['r/a/b.sol', entry('d')]]);
  const keys = new Map([['r/a/b.sol', 'R/a/b.sol']]);
  await store.save(file, 'default', base, keys);

  store.invalidate(file);
  assert.equal(store.residentManifests, 0);

  const reloaded = await store.load(file, 'default');
  assert.notEqual(reloaded.index.entries, base);
  assert.equal(reloaded.index.entries.get('r/a/b.sol').hash, 'd'.repeat(32));
});

test('invalidateAll forgets every manifest', async () => {
  const root = await sandbox();
  const store = new ManifestStore(logger());
  const one = path.join(root, 'one.json');
  const two = path.join(root, 'two.json');
  await writeManifestFile(one, { 'R/a/b.sol': entry('a') });
  await writeManifestFile(two, { 'R/c/d.sol': entry('b') });

  await store.load(one, 'default');
  await store.load(two, 'default');
  assert.equal(store.residentManifests, 2);

  store.invalidateAll();
  assert.equal(store.residentManifests, 0);
  assert.equal(store.residentEntries, 0);
});

test('a missing manifest is cached as missing but not permanently', async () => {
  const file = path.join(await sandbox(), 'missing.json');
  const store = new ManifestStore(logger());

  const first = await store.load(file, 'default');
  assert.equal(first.data, null);
  assert.equal(await store.load(file, 'default'), first);

  await writeManifestFile(file, { 'R/a/b.sol': entry('a') });
  const created = await store.load(file, 'default');
  assert.notEqual(created.data, null);
  assert.equal(created.index.entries.size, 1);
});

test('invalid entries are dropped without rewriting the table', async () => {
  const file = path.join(await sandbox(), 'manifest.json');
  await fs.writeFile(
    nativePath(file),
    JSON.stringify({
      version: 1,
      profile: 'default',
      updatedAt: 'now',
      files: { 'R/ok.sol': entry('a'), 'R/bad.sol': { size: 12 } },
    }),
    'utf8',
  );

  const store = new ManifestStore(logger());
  const loaded = await store.load(file, 'default');
  assert.equal(loaded.index.entries.size, 1);
  assert.ok(!loaded.index.entries.has('r/bad.sol'));
});

test('a manifest for another profile is treated as missing', async () => {
  const file = path.join(await sandbox(), 'manifest.json');
  await writeManifestFile(file, { 'R/a/b.sol': entry('a') }, 'SomeoneElse');

  const store = new ManifestStore(logger());
  const loaded = await store.load(file, 'default');
  assert.equal(loaded.data, null);
});

test('settle keeps the resident set under the entry budget', async () => {
  const root = await sandbox();
  const store = new ManifestStore(logger(), { maxEntries: 3 });

  for (const name of ['one', 'two', 'three']) {
    const file = path.join(root, `${name}.json`);
    await writeManifestFile(file, {
      [`R/${name}/a.sol`]: entry('a'),
      [`R/${name}/b.sol`]: entry('b'),
    });
    await store.load(file, 'default');
  }
  assert.equal(store.residentEntries, 6);
  assert.equal(store.residentManifests, 3);

  store.settle();
  assert.ok(store.residentEntries <= 3, `expected <= 3 entries, got ${store.residentEntries}`);
  assert.ok(store.residentManifests < 3);

  // The dropped manifests are a cache, so they reload cleanly from disk.
  const again = await store.load(path.join(root, 'one.json'), 'default');
  assert.equal(again.index.entries.size, 2);
});

test('concurrent loads of one file share a single read', async () => {
  const file = path.join(await sandbox(), 'manifest.json');
  await writeManifestFile(file, { 'R/a/b.sol': entry('a') });

  const store = new ManifestStore(logger());
  const [a, b, c] = await Promise.all([
    store.load(file, 'default'),
    store.load(file, 'default'),
    store.load(file, 'default'),
  ]);
  assert.equal(a, b);
  assert.equal(b, c);
  assert.equal(store.residentManifests, 1);
});

test('save is skipped when neither the state nor the file changed', async () => {
  const file = path.join(await sandbox(), 'manifest.json');
  const store = new ManifestStore(logger());
  const base = new Map([['r/a.sol', entry('a')]]);
  const keys = new Map([['r/a.sol', 'R/a.sol']]);

  await store.save(file, 'default', base, keys);
  const first = JSON.parse(await fs.readFile(nativePath(file), 'utf8')).updatedAt;

  await new Promise(resolve => setTimeout(resolve, 25));
  await store.save(file, 'default', base, keys);
  const second = JSON.parse(await fs.readFile(nativePath(file), 'utf8')).updatedAt;

  assert.equal(second, first, 'an unchanged table must not be rewritten');
  assert.equal(store.skippedWrites, 1);

  // A real change to the table still has to reach the disk.
  base.set('r/a.sol', { hash: 'z'.repeat(32), size: 8192, mtimeMs: 1_700_000_000_001 });
  await new Promise(resolve => setTimeout(resolve, 25));
  await store.save(file, 'default', base, keys);
  const third = JSON.parse(await fs.readFile(nativePath(file), 'utf8')).updatedAt;

  assert.notEqual(third, first, 'a changed table must be written');
  assert.equal(store.skippedWrites, 1);
});

test('settle trims a realistic resident set', async () => {
  const root = await sandbox();
  const store = new ManifestStore(logger(), { maxEntries: 800 });

  for (const name of ['a', 'b', 'c']) {
    const files = {};
    for (let i = 0; i < 400; i++) {
      files[`R/${name}/f${i}.sol`] = entry('a');
    }
    const file = path.join(root, `${name}.json`);
    await writeManifestFile(file, files);
    await store.load(file, 'default');
  }

  assert.equal(store.residentEntries, 1200);
  store.settle();
  assert.ok(store.residentEntries <= 800, `expected <= 800 entries, got ${store.residentEntries}`);
  assert.ok(store.residentManifests >= 1, 'the most recently used manifest survives');
});
