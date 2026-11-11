/**
 * Guard the package/display metadata that other processes read without
 * evaluating plugin code: the icon declarations and the marketplace
 * screenshot manifest must point at files that actually exist.
 *
 * Icon paths are especially easy to break: the plugin manager renders the
 * icon from `package.json` (`icon`, falling back to the `./icon` export), and
 * a stale path surfaces as a metadata error in the UI.
 */
'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

assert.equal(manifest.icon, 'assets/icon-256.png', 'package.json icon must be assets/icon-256.png')
assert.equal(manifest.exports['./icon'], './assets/icon-256.png', './icon export must point at the PNG')
assert.ok(fs.existsSync(path.join(root, manifest.icon)), 'declared icon file is missing')
assert.ok(manifest.files.includes('assets/icon-256.png'), 'icon must be included in the npm package files')

const screenshots = JSON.parse(fs.readFileSync(path.join(root, 'screenshots.json'), 'utf8'))
assert.ok(Array.isArray(screenshots) && screenshots.length >= 1 && screenshots.length <= 8, 'screenshots.json must list 1-8 images')
for (const relative of screenshots) {
  assert.ok(fs.existsSync(path.join(root, relative)), 'screenshot is missing: ' + relative)
}

console.log('package-meta: ok — icon declarations and screenshot manifest resolve')
