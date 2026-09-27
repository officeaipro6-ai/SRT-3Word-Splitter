import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

const root = path.resolve(import.meta.dirname, '..');

test('public/manifest.webmanifest exists and references real icon files', () => {
  const manifestPath = path.join(root, 'public', 'manifest.webmanifest');
  assert.ok(fs.existsSync(manifestPath), 'manifest.webmanifest must exist');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.name, 'Odia SRT');
  assert.equal(manifest.short_name, 'Odia SRT');
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length >= 3);
  const purposes = manifest.icons.map((i: any) => i.purpose);
  assert.ok(purposes.includes('any'), 'needs a normal-use icon');
  assert.ok(purposes.includes('maskable'), 'needs a maskable icon');
  for (const icon of manifest.icons) {
    const file = path.join(root, 'public', icon.src.replace(/^\//, ''));
    assert.ok(fs.existsSync(file), `manifest icon ${icon.src} must exist`);
    // Valid PNG: signature + correct IHDR dimensions.
    const buf = fs.readFileSync(file);
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.ok(buf.subarray(0, 8).equals(sig), `${icon.src} must be a PNG`);
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    assert.equal(width, height, `${icon.src} must be square`);
    const expected = Number(icon.sizes.split('x')[0]);
    assert.equal(width, expected, `${icon.src} must be ${expected}x${expected}`);
  }
});

test('index.html links the manifest, theme-color and favicon', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(html, /rel="manifest"\s+href="\/manifest\.webmanifest"/);
  assert.match(html, /name="theme-color"/);
  assert.match(html, /icons\/favicon-32\.png/);
  assert.match(html, /<title>Odia SRT/);
});