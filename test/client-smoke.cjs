/**
 * Structural smoke test for the browser half.
 *
 * `client.js` is a classic script wrapped in `window.__ModuleLoader__.load`,
 * so this test evaluates it in a Node VM with a stubbed module loader and a
 * stubbed React, then asserts the plugin contract: exports, locale
 * dictionaries, and the `conversation.view` registration (id/order/locale/
 * label/sessionId forwarding).
 *
 * Run with `node test/client-smoke.cjs` (no dependencies).
 */
'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const source = fs.readFileSync(path.join(__dirname, '..', 'client.js'), 'utf8')

let captured
const ReactStub = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useRef: (value) => ({ current: value }),
  useCallback: (fn) => fn,
}

const sandbox = {
  window: { __ModuleLoader__: { load: (spec) => { captured = spec } } },
  document: {
    createElement: () => ({ setAttribute() {}, remove() {}, style: {} }),
    head: { append() {} },
    body: { append() {} },
    execCommand: () => false,
  },
  navigator: {},
  Intl,
  Date,
  JSON,
  String,
  Number,
  Array,
  Object,
  Symbol,
  Promise,
  console,
  setTimeout,
  clearTimeout,
  AbortController,
}
sandbox.globalThis = sandbox
vm.createContext(sandbox)
vm.runInContext(source, sandbox, { filename: 'client.js' })

assert.ok(captured, 'window.__ModuleLoader__.load was not called')
assert.equal(captured.id, 'dsh-handoff-tab', 'module id must be the package name')

const module_ = captured.factory((name) => {
  if (name === 'react') return ReactStub
  throw new Error('unexpected require: ' + name)
})

assert.equal(typeof module_.apply, 'function', 'exports.apply must be a function')
// Values created inside the VM realm have foreign prototypes, so compare
// by value instead of deepStrictEqual.
assert.equal(module_.inject.join(','), 'slots,locale', 'inject list mismatch')

const effects = []
const injections = []
const registrations = []
const dictionaries = []
const ctx = {
  effect(fn, label) {
    effects.push(label)
    const dispose = fn()
    return () => { if (typeof dispose === 'function') dispose() }
  },
  locale: {
    register(namespace, dicts) {
      dictionaries.push({ namespace, languages: Object.keys(dicts) })
      return () => {}
    },
    bind(namespace) {
      return (key) => namespace + ':' + key
    },
  },
  slots: {
    inject(slot, callback) {
      injections.push(slot)
      callback()
      return () => {}
    },
    register(spec, component) {
      registrations.push({ spec, component })
      return () => {}
    },
  },
}

module_.apply(ctx)

assert.deepEqual(dictionaries, [{ namespace: 'handoff', languages: ['zh', 'en'] }])
assert.equal(injections.join(','), 'conversation.view')
assert.equal(registrations.length, 1, 'expected exactly one slot registration')

const { spec, component } = registrations[0]
assert.equal(spec.name, 'conversation.view')
assert.equal(spec.id, 'handoff')
assert.equal(spec.order, 20)
assert.equal(spec.locale, 'handoff')
assert.equal(typeof spec.label, 'function')
assert.equal(spec.label(), 'handoff:view.handoff')
const injected = spec.inject('session-test')
assert.equal(injected.sessionId, 'session-test', 'sessionId must be forwarded to props')
assert.equal(typeof component, 'function', 'view component must be a function')

console.log('client-smoke: ok — conversation.view registration and exports are valid')
