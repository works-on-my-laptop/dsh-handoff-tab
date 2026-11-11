/**
 * Keep the documented prompt contract byte-identical to the prompt the Host
 * embeds in `SYSTEM_PROMPT`.
 *
 * `docs/handoff-prompt.md` is the human-readable contract; `index.js` is what
 * actually runs. Drift between them is a documentation bug, so this check is
 * part of `npm test` and CI.
 */
'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const indexSource = fs.readFileSync(path.join(root, 'index.js'), 'utf8')
const docSource = fs.readFileSync(path.join(root, 'docs', 'handoff-prompt.md'), 'utf8')

const codeMatch = indexSource.match(/const SYSTEM_PROMPT = `([\s\S]*?)`\n/)
assert.ok(codeMatch, 'index.js does not declare SYSTEM_PROMPT as a template literal')

const docMatch = docSource.match(/```text\n([\s\S]*?)```/)
assert.ok(docMatch, 'docs/handoff-prompt.md has no ```text prompt-body block')

const normalize = (text) => text.replace(/\r\n/g, '\n').trimEnd()
const codePrompt = normalize(codeMatch[1])
const docPrompt = normalize(docMatch[1])

if (codePrompt !== docPrompt) {
  const codeLines = codePrompt.split('\n')
  const docLines = docPrompt.split('\n')
  let line = 0
  while (line < codeLines.length && line < docLines.length && codeLines[line] === docLines[line]) line++
  console.error('prompt-sync: docs/handoff-prompt.md is out of sync with index.js SYSTEM_PROMPT')
  console.error('  first difference at prompt line ' + (line + 1))
  console.error('  index.js: ' + JSON.stringify(codeLines[line]))
  console.error('  docs    : ' + JSON.stringify(docLines[line]))
  console.error('  Fix both copies (and bump PROMPT_VERSION in index.js).')
  process.exit(1)
}

assert.match(indexSource, /const PROMPT_VERSION = \d+/, 'index.js must declare a numeric PROMPT_VERSION')
console.log('prompt-sync: ok — docs/handoff-prompt.md matches index.js SYSTEM_PROMPT')
