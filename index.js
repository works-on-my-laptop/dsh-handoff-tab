/**
 * dsh-handoff-tab — Host half.
 *
 * Serves two same-origin routes for the conversation view tab added by the
 * browser half (`client.js`):
 *
 *   GET  /handoff/doc?sessionId=<id>   → { state: 'idle' | 'generating' | 'ready' | 'error', ... }
 *   POST /handoff/generate  {sessionId} → 202 { state: 'generating' }
 *
 * Generation is a Host background task: POST returns immediately, the
 * transcript is read and summarized by the current default model, and the
 * resulting paste-ready prompt is stored in the `handoff` storage domain
 * (keyed by sessionId, latest one only). The client polls GET until the
 * state leaves `generating`. Closing the page, switching tabs or switching
 * sessions does not interrupt it; the in-flight state lives in memory and is
 * reported by GET so a remounted tab restores the right state.
 *
 * Hard boundaries (frozen design):
 * - no workspace files are written;
 * - no session events/messages/commands are appended (the routes are pure
 *   side channels; `llm.stream` receives `sessionId` only as model-hidden
 *   request metadata);
 * - only the latest document per session is kept;
 * - records older than 60 days are pruned once, asynchronously after boot.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, isAbsolute, join, relative, sep } from 'node:path'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

export const name = 'dsh-handoff-tab'

/** Host services required by this plugin. */
export const inject = ['webServer', 'storageDomain']

/* ------------------------------------------------------------------ *
 * Constants                                                           *
 * ------------------------------------------------------------------ */

const ROUTE_DOC = '/handoff/doc'
const ROUTE_GENERATE = '/handoff/generate'

/**
 * Storage-domain name. It doubles as the storage backend unit name, so the
 * file is `$DSH_HOME/storages/<DOMAIN_NAME>.json`; underscores only because
 * `UNIT_NAME_RE` is `^[a-z][a-z0-9_]*$` (hyphens are not allowed). Naming it
 * after the plugin keeps it from colliding with another plugin's "handoff"
 * domain.
 */
const DOMAIN_NAME = 'dsh_handoff_tab'
const TABLE_NAME = 'documents'
const DOMAIN_VERSION = 1
const PROMPT_VERSION = 2

/** Retained documents older than this are pruned when the plugin loads. */
const RETENTION_DAYS = 60
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000

/** Delay before the one-shot prune, so plugin loading stays non-blocking. */
const PRUNE_DELAY_MS = 5000

/** Prompt body to summarize: 800–2000 characters of paste-ready handoff. */
const MAX_TOKENS = 8192
const GENERATION_TIMEOUT_MS = 180000

/** Request bodies are tiny JSON documents; refuse anything larger. */
const MAX_BODY_BYTES = 64 * 1024
const MAX_SESSION_ID_LENGTH = 200

const LOG_PREFIX = '[dsh-handoff-tab]'

/* ------------------------------------------------------------------ *
 * Storage domain                                                      *
 * ------------------------------------------------------------------ */

/**
 * Record schema for one document.
 *
 * It implements the two methods the domain layer actually calls
 * (`parse`, and `safeParse` by symmetry) instead of importing zod: this
 * plugin is installed as a linked local directory, and a linked package
 * resolves Node imports from its own ancestors, where the profile's `zod`
 * is not visible. The record has four primitive fields, so the equivalent
 * check is a few lines and keeps the plugin dependency-free.
 */
const documentSchema = {
  parse(value) {
    if (!isDocument(value)) throw new Error('handoff document record is invalid')
    return value
  },
  safeParse(value) {
    return isDocument(value)
      ? { success: true, data: value }
      : { success: false, error: new Error('handoff document record is invalid') }
  },
}

function isDocument(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && typeof value.text === 'string'
    && typeof value.generatedAt === 'number'
    && Number.isFinite(value.generatedAt)
    && typeof value.model === 'string'
    && typeof value.promptVersion === 'number'
}

const handoffSpec = defineDomain({
  name: DOMAIN_NAME,
  version: DOMAIN_VERSION,
  tables: {
    [TABLE_NAME]: domainTable(documentSchema),
  },
})

/* ------------------------------------------------------------------ *
 * System prompt                                                       *
 * ------------------------------------------------------------------ */

/**
 * The frozen prompt contract from the project's `handoff-prompt.md`:
 * the model output IS the next session's first message — no document shell,
 * no metadata, no preamble.
 */
const SYSTEM_PROMPT = `# 角色
你熟悉当前会话的全部内容（对话、产出的文件、执行过的命令与结果、做过的决策）。但你要写的东西不是给人看的报告，而是**给一个完全没有本会话记忆的新 agent 的开场提示词**。

# 任务
写一段可以直接粘贴到新会话的第一条消息。**全文都是提示词**：从第一个字开始就是对下一位 agent 说的话，到最后一个字为止。

不要出现：文档标题、「交接说明/交接文档」之类自称、引言、结语、「以下是……」、生成时间、会话 ID、完成度百分比、以及任何面向人的说明。正文之外不要再输出任何内容。

# 正文必须让接手者知道
1. 在做什么：项目/任务的背景、最终要达成什么、验收标准。
2. 做到哪了：已完成、进行中、未开始、已废弃各是哪些；能给出证据的写路径、命令、结果。
3. 定了什么：关键决策与理由，**以及被否决的方案和否决原因**（防止重做）。
4. 东西在哪：文件与目录路径（相对工作区根目录）、用途、当前状态。
5. 有什么坑：试过但失败的做法、容易误解的点、已排除的假设。
6. 接下来做什么：按优先级，每条写清"做什么 + 改哪里 + 验收标准"。
7. 什么不能动：用户明确提的要求、不可更改的前提、目录与命名规范、环境依赖、禁止事项。

# 写法
- 用第二人称"你"称呼接手者，祈使句为主（"先读 X""不要动 Y""改成 Z 再验证"）。
- 用短段落、列表、加粗强调来组织，不要用文档式的大标题层级。
- 具体到路径、命令、参数、字段名。禁止"那个文件""之前说的方案""如上所述"这类依赖旧对话的指代——新会话看不到旧对话。
- 涉及文件、目录与产物时，以输入里的「CURRENT WORKSPACE SNAPSHOT」为准；快照里没有列出的文件或构建产物不要声称存在，拿不准就写成行动（"先核实…"）。
- 事实给证据，判断给理由；推断标「推断」，未验证标「未验证」。
- 不确定的地方写成行动（"先核实 X，再决定 Y"），不要写成结论，更不要编造。
- 800–2000 字，宁详勿简：每句话要么是事实，要么是行动指令。
- 跟随会话使用的语言。

# 自检
把这段文本单独作为新会话的第一条消息发出去，检查两件事：
1. 新 agent 能否立刻知道"做什么、从哪开始、什么不能碰"？不能就补。
2. 它会不会反问"你要我做什么"？会就说明开头没把任务写出来。

# 开始
动笔前先在上下文里核对信息；信息不全就按"先核实"的写法处理，不要为了凑结构而编造。`

/* ------------------------------------------------------------------ *
 * Plugin body                                                         *
 * ------------------------------------------------------------------ */

export function apply(ctx) {
  /** sessionId → { startedAt } while a background generation runs. */
  const inFlight = new Map()
  /** sessionId → { error, at } for the last failed attempt, consumed once by GET. */
  const failures = new Map()

  /** One Domain handle for the whole plugin: the facility rejects a second open. */
  let domainPromise = null
  const domain = () => {
    if (domainPromise === null) {
      domainPromise = ctx.storageDomain.open(handoffSpec).catch((error) => {
        domainPromise = null
        console.error(LOG_PREFIX, 'failed to open storage domain:', error)
        throw error
      })
    }
    return domainPromise
  }
  const table = async () => (await domain()).table(TABLE_NAME)

  // Open the domain at boot, schedule the one-shot 60-day prune, and close the
  // handle on unload (the timer is cleared first so it cannot outlive it).
  ctx.effect(async () => {
    let handle
    try {
      handle = await domain()
    } catch {
      // Routes surface the failure; boot itself must not fail.
      return
    }
    const timer = setTimeout(() => {
      void prune(handle).catch((error) => console.error(LOG_PREFIX, 'prune failed:', error))
    }, PRUNE_DELAY_MS)
    timer.unref?.()
    return async () => {
      clearTimeout(timer)
      await handle.close()
    }
  }, 'dsh-handoff-tab: storage domain and retention')

  // GET /handoff/doc?sessionId=... — the current state for one session.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE_DOC,
    handler: async (req, res) => {
      if (req.method !== 'GET') {
        sendJson(res, 405, { state: 'idle', error: '仅支持 GET' })
        return
      }
      try {
        const sessionId = readSessionIdFromUrl(req)
        if (!sessionId) {
          sendJson(res, 400, { state: 'idle', error: '缺少 sessionId' })
          return
        }
        const running = inFlight.get(sessionId)
        if (running) {
          sendJson(res, 200, { state: 'generating', startedAt: running.startedAt })
          return
        }
        const failure = failures.get(sessionId)
        if (failure) {
          failures.delete(sessionId)
          sendJson(res, 200, { state: 'error', error: failure.error })
          return
        }
        const document = (await table()).get(sessionId)
        if (document) {
          sendJson(res, 200, {
            state: 'ready',
            text: document.text,
            generatedAt: document.generatedAt,
            model: document.model,
            promptVersion: document.promptVersion,
          })
          return
        }
        sendJson(res, 200, { state: 'idle' })
      } catch (error) {
        console.error(LOG_PREFIX, 'GET /handoff/doc failed:', error)
        sendJson(res, 500, { state: 'idle', error: errorMessage(error) })
      }
    },
  }), 'dsh-handoff-tab: GET /handoff/doc')

  // POST /handoff/generate { sessionId } — start a background generation.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE_GENERATE,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { state: 'idle', error: '仅支持 POST' })
        return
      }
      try {
        const body = await readJsonBody(req)
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
        if (!sessionId || sessionId.length > MAX_SESSION_ID_LENGTH) {
          sendJson(res, 400, { state: 'error', error: '缺少或非法的 sessionId' })
          return
        }
        if (inFlight.has(sessionId)) {
          sendJson(res, 202, { state: 'generating', startedAt: inFlight.get(sessionId).startedAt })
          return
        }
        // A new attempt supersedes an unreported old failure.
        failures.delete(sessionId)
        const entry = { startedAt: Date.now() }
        inFlight.set(sessionId, entry)
        void runGeneration(ctx, sessionId, table)
          .catch((error) => {
            console.error(LOG_PREFIX, 'generation failed:', error)
            failures.set(sessionId, { error: errorMessage(error), at: Date.now() })
          })
          .finally(() => {
            inFlight.delete(sessionId)
          })
        sendJson(res, 202, { state: 'generating', startedAt: entry.startedAt })
      } catch (error) {
        console.error(LOG_PREFIX, 'POST /handoff/generate failed:', error)
        sendJson(res, 500, { state: 'error', error: errorMessage(error) })
      }
    },
  }), 'dsh-handoff-tab: POST /handoff/generate')
}

/* ------------------------------------------------------------------ *
 * Generation pipeline                                                 *
 * ------------------------------------------------------------------ */

/**
 * Read the session, compress its transcript, ask the current default model
 * for the handoff prompt, and persist the result. Runs detached from the
 * request that started it.
 * @param ctx - plugin context.
 * @param sessionId - session to hand off.
 */
async function runGeneration(ctx, sessionId, table) {
  const sessionQuery = ctx.get('sessionQuery')
  if (!sessionQuery || typeof sessionQuery.readSession !== 'function') {
    throw new Error('sessionQuery 服务不可用')
  }
  const log = await sessionQuery.readSession(sessionId)
  const events = log && Array.isArray(log.events) ? log.events : []
  if (events.length === 0) throw new Error('会话没有可总结的事件')
  const cwd = log.session && typeof log.session.cwd === 'string' ? log.session.cwd : ''
  const title = await readTitle(sessionQuery, sessionId)

  const rows = selectTranscriptRows(extractRows(events))
  const references = extractReferences(events)
  const refs = relativizeRefs(cwd, references.refs)
  const transcript = buildTranscript(rows)
  const snapshot = readWorkspaceSnapshot(cwd, refs)
  const userText = buildUserText({ title, cwd, transcript, refs, skills: references.skills, snapshot })

  const model = await generateText(ctx, { sessionId, userText })
  const document = {
    text: model.text,
    generatedAt: Date.now(),
    model: model.model,
    promptVersion: PROMPT_VERSION,
  }
  await (await table()).put(sessionId, document)
}

/**
 * One non-streaming-looking model call: consume the stream, return the text.
 * `sessionId` is passed as routing metadata only; the LLM service never
 * appends session events.
 */
async function generateText(ctx, { sessionId, userText }) {
  const llm = ctx.get('llm')
  const defaultModel = ctx.get('agentDefaultModel')
  if (!llm || typeof llm.stream !== 'function') throw new Error('llm 服务不可用')
  if (!defaultModel || typeof defaultModel.currentSelection !== 'function') {
    throw new Error('agentDefaultModel 服务不可用')
  }
  const selection = defaultModel.currentSelection()
  if (!selection || typeof selection.provider !== 'string' || typeof selection.model !== 'string') {
    throw new Error('没有可用的默认模型')
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), GENERATION_TIMEOUT_MS)
  try {
    const options = {
      provider: selection.provider,
      model: selection.model,
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: userText }],
      }],
      system: SYSTEM_PROMPT,
      maxTokens: MAX_TOKENS,
      sessionId,
      purpose: 'handoff',
      signal: controller.signal,
    }
    if (typeof selection.reasoningEffort === 'string' && selection.reasoningEffort) {
      options.reasoningEffort = selection.reasoningEffort
    }

    let text = ''
    let finishKind = null
    let finishFailure = null
    for await (const chunk of llm.stream(options)) {
      if (!chunk || typeof chunk !== 'object') continue
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
      else if (chunk.type === 'finish' && chunk.reason) {
        finishKind = chunk.reason.kind
        finishFailure = chunk.reason.failure || null
      }
    }
    if (finishKind === 'error' || finishKind === 'aborted') {
      const detail = finishFailure && (finishFailure.message || finishFailure.code)
      throw new Error('LLM 调用失败: ' + finishKind + (detail ? ' — ' + detail : ''))
    }
    if (finishKind === 'max-tokens') {
      throw new Error('生成长度达到上限被截断，请重试')
    }
    const trimmed = stripFence(text.trim())
    if (!trimmed) throw new Error('LLM 未产生文本')
    return { text: trimmed, model: selection.model }
  } finally {
    clearTimeout(timer)
  }
}

/** Remove an accidental outer markdown fence; the body itself is plain text. */
function stripFence(text) {
  return text.replace(/^```(?:text|markdown|md)?\s*/i, '').replace(/\s*```$/, '').trim()
}

/* ------------------------------------------------------------------ *
 * Transcript compression (adapted from the established handoff skill) *
 * ------------------------------------------------------------------ */

/**
 * Per-turn rows: every user message plus the last assistant message text of
 * each turn (reasoning/tool blocks are skipped). Secrets are redacted.
 * @param events - session events from `sessionQuery.readSession`.
 * @returns chronological rows.
 */
function extractRows(events) {
  const rows = []
  let pending = null
  const flush = () => {
    if (pending) {
      rows.push(pending)
      pending = null
    }
  }
  for (const event of events) {
    if (!event || typeof event !== 'object') continue
    if (event.type === 'turn/start') {
      flush()
    } else if (event.type === 'user/message') {
      flush()
      const text = redact(extractText(event.data))
      if (text) rows.push({ kind: '用户', text, time: fmtTime(event.time) })
    } else if (event.type === 'assistant/message') {
      const message = event.data && event.data.message
      const text = redact(extractText(message))
      if (!text) continue
      const source = message && message.source
      const model = source && typeof source.provider === 'string'
        ? source.provider + '/' + (typeof source.model === 'string' ? source.model : '')
        : ''
      pending = { kind: '助手', text, time: fmtTime(event.time), model }
    }
  }
  flush()
  return rows
}

/**
 * Keep the original goal and the latest status, prefer user messages, and
 * replace larger holes with an explicit omission marker so the model does
 * not invent skipped work.
 * @param rows - extractRows() output.
 * @param maxRows - maximum content rows; default 24.
 */
function selectTranscriptRows(rows, maxRows = 24) {
  if (!Array.isArray(rows) || rows.length === 0) return []
  if (rows.length <= maxRows) return rows.slice()

  const userIndexes = []
  const otherIndexes = []
  for (let i = 0; i < rows.length; i++) {
    if (rows[i] && rows[i].kind === '用户') userIndexes.push(i)
    else otherIndexes.push(i)
  }

  const chosen = new Set()
  if (userIndexes.length) chosen.add(userIndexes[0])
  else chosen.add(0)
  chosen.add(rows.length - 1)
  if (otherIndexes.length) chosen.add(otherIndexes[0])

  for (let k = userIndexes.length - 1; k >= 0 && chosen.size < maxRows; k--) chosen.add(userIndexes[k])
  for (let k = otherIndexes.length - 1; k >= 0 && chosen.size < maxRows; k--) chosen.add(otherIndexes[k])

  const ordered = [...chosen].sort((a, b) => a - b)
  const out = []
  let previous = -1
  for (const index of ordered) {
    if (previous >= 0 && index - previous > 2) {
      out.push({
        kind: '省略',
        text: '（中间 ' + (index - previous - 1) + ' 条已省略。中段进展以工件清单中的文件为准，不要臆造。）',
      })
    }
    out.push(rows[index])
    previous = index
  }
  return out
}

function buildTranscript(rows) {
  const parts = []
  for (const row of rows) {
    parts.push('### ' + row.kind + (row.model ? '（' + row.model + '）' : '') + (row.time ? ' · ' + row.time : ''))
    const max = row.kind === '用户' ? 2000 : row.kind === '省略' ? 200 : 800
    parts.push(clamp(row.text, max))
  }
  return parts.join('\n\n')
}

function buildUserText({ title, cwd, transcript, refs, skills, snapshot }) {
  const lines = []
  lines.push('Session title: ' + (title || 'untitled'))
  lines.push('Workspace: ' + (cwd || '(unknown)'))
  lines.push('Plugin storage file: $DSH_HOME/storages/' + DOMAIN_NAME + '.json')
  lines.push('')
  lines.push('Files the session touched according to the transcript (may be stale — the current snapshot below wins):')
  if (refs && refs.length) for (const ref of refs) lines.push('- ' + ref)
  else lines.push('- (none extracted)')
  lines.push('')
  lines.push('Skills already used in this session:')
  if (skills && skills.length) for (const skill of skills) lines.push('- ' + skill)
  else lines.push('- (none)')
  lines.push('')
  lines.push('Conversation transcript (compressed; text only). The opening goal and the latest turns are included; middle assistant turns may be omitted when they should already live in the files above. Do not invent omitted work.')
  lines.push(transcript)
  lines.push('')
  lines.push('CURRENT WORKSPACE SNAPSHOT (computed just now; authoritative over the transcript):')
  lines.push(snapshot || '(workspace unavailable)')
  lines.push('')
  lines.push('Snapshot rules:')
  lines.push('- The transcript may describe earlier states: files may have moved or been deleted, and planned build artifacts may never have existed. When they conflict, follow this snapshot.')
  lines.push('- The plugin storage file path stated above is current; ignore any older storage path mentioned in the transcript.')
  lines.push('- Never claim a file, directory or build artifact exists unless it is listed in the snapshot. If something is absent here but mentioned above, write it as an action ("先核实…") instead of a fact.')
  lines.push('')
  lines.push('Hard output constraints:')
  lines.push('- Output ONLY the handoff prompt body. No code fence, no title, no preamble, no trailing note.')
  lines.push('- Length MUST be 800–2000 Chinese characters (punctuation included). If longer, delete redundant detail and rewrite; if shorter, add missing facts. Count before you answer; a result outside this range is invalid.')
  lines.push('- Write as if the work is still in progress: address the next agent directly ("你继续…"), never call the current session "the previous session" and never assume an older session exists.')
  return lines.join('\n')
}

/* ------------------------------------------------------------------ *
 * Current workspace snapshot                                          *
 * ------------------------------------------------------------------ */

/** Directories that are dependency caches, VCS internals or temp output. */
const SNAPSHOT_SKIP_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', '.venv', 'venv', '__pycache__',
  '.next', '.turbo', '.cache', '.idea', '.vscode', '.gradle', '.m2',
])

/**
 * Compact, authoritative view of the session workspace right now. The
 * transcript describes older states (files move, planned artifacts never
 * exist), so the model is told this snapshot wins. Bounded on purpose: it is
 * prompt context, not a directory walker.
 * @param cwd - session workspace root.
 * @param refs - workspace-relative paths extracted from the transcript.
 * @returns a newline-joined snapshot, or '' when the workspace is unreadable.
 */
function readWorkspaceSnapshot(cwd, refs) {
  if (!cwd || !existsSync(cwd)) return ''
  const lines = []
  try {
    const entries = readdirSync(cwd, { withFileTypes: true })
      .filter((entry) => !SNAPSHOT_SKIP_DIRS.has(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name))
    lines.push('Top level (' + entries.length + ' entries):')
    for (const entry of entries.slice(0, 80)) {
      if (entry.isDirectory()) {
        lines.push('- ' + entry.name + '/')
        try {
          const children = readdirSync(join(cwd, entry.name), { withFileTypes: true })
            .filter((child) => !SNAPSHOT_SKIP_DIRS.has(child.name))
            .sort((a, b) => a.name.localeCompare(b.name))
          for (const child of children.slice(0, 12)) {
            lines.push('  - ' + entry.name + '/' + child.name + (child.isDirectory() ? '/' : ''))
          }
          if (children.length > 12) lines.push('  - ' + entry.name + '/… (' + (children.length - 12) + ' more)')
        } catch {
          lines.push('  - ' + entry.name + '/ (unreadable)')
        }
      } else {
        lines.push('- ' + entry.name)
      }
    }
    if (entries.length > 80) lines.push('- … (' + (entries.length - 80) + ' more)')
  } catch {
    return ''
  }

  try {
    const manifest = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'))
    if (manifest && typeof manifest.name === 'string') {
      lines.push('package.json: ' + manifest.name + (typeof manifest.version === 'string' ? '@' + manifest.version : ''))
    }
  } catch {
    // no package.json at the workspace root
  }

  const verified = []
  const moved = []
  const missing = []
  for (const ref of refs || []) {
    if (!ref || ref.startsWith('..') || ref.includes('\u0000')) continue
    if (existsSync(join(cwd, ref))) {
      verified.push(ref)
    } else {
      const found = findWorkspaceFile(cwd, basename(ref))
      if (found && found !== ref) moved.push(ref + ' → ' + found)
      else missing.push(ref)
    }
  }
  if (verified.length) lines.push('Transcript references that still exist: ' + verified.join(', '))
  if (moved.length) lines.push('Transcript references that moved (old → current): ' + moved.join('; '))
  if (missing.length) lines.push('Transcript references that no longer exist (do not cite them): ' + missing.join(', '))
  return lines.join('\n')
}

/**
 * Find a file by basename anywhere in the workspace (depth-limited BFS), so a
 * stale transcript path can be reported with its current location.
 * @param cwd - workspace root.
 * @param name - file basename to look for.
 * @returns workspace-relative path using '/', or '' when absent.
 */
function findWorkspaceFile(cwd, name) {
  if (!name) return ''
  const queue = [{ dir: cwd, rel: '', depth: 0 }]
  let visited = 0
  while (queue.length > 0 && visited < 3000) {
    const current = queue.shift()
    let entries
    try {
      entries = readdirSync(current.dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (SNAPSHOT_SKIP_DIRS.has(entry.name)) continue
      visited++
      if (visited > 3000) break
      const childRel = current.rel ? current.rel + '/' + entry.name : entry.name
      if (entry.isDirectory()) {
        if (current.depth < 3) queue.push({ dir: join(current.dir, entry.name), rel: childRel, depth: current.depth + 1 })
      } else if (entry.name === name) {
        return childRel
      }
    }
  }
  return ''
}

/* ------------------------------------------------------------------ *
 * References                                                          *
 * ------------------------------------------------------------------ */

const NON_PROJECT_PREFIXES = [
  '/usr', '/opt', '/Applications', '/System', '/bin', '/sbin',
  '/Library', '/private', '/etc', '/var', '/dev', '/tmp',
]
const NOISE_PATH_RE = /(^|[\\/])(\.write-test|\.probe-test|_tmp_|\.tmp)([\\/]|$)/
const NOISE_PATH_SEGMENTS = ['node_modules/.bin', '/bin/', '/sbin/']

function isNoisePath(value) {
  if (typeof value !== 'string' || !value) return true
  for (const prefix of NON_PROJECT_PREFIXES) {
    if (value === prefix || value.startsWith(prefix + '/')) return true
  }
  if (NOISE_PATH_RE.test(value)) return true
  for (const segment of NOISE_PATH_SEGMENTS) {
    if (value.includes(segment)) return true
  }
  return false
}

function extractReferences(events) {
  const refs = new Set()
  const skills = new Set()
  const pathKeys = ['path', 'file_path', 'target']
  for (const event of events) {
    if (!event || event.type !== 'tool/call' || !event.data) continue
    const toolName = event.data.name
    let args = {}
    try {
      args = JSON.parse(typeof event.data.arguments === 'string' ? event.data.arguments : '{}')
    } catch {
      continue
    }
    if (!args || typeof args !== 'object') continue
    if (toolName === 'skill') {
      if (typeof args.name === 'string' && args.name) skills.add(args.name)
      continue
    }
    for (const key of pathKeys) {
      const value = args[key]
      if (typeof value === 'string' && value && looksLikePath(value) && !isNoisePath(value)) refs.add(value)
    }
    if (typeof args.workdir === 'string' && args.workdir && !isNoisePath(args.workdir)) refs.add(args.workdir)
    if (toolName === 'bash' && typeof args.command === 'string') {
      for (const match of args.command.matchAll(/(?:^|\s)((?:\/[\w.\-]+){2,}|\.\.?\/[\w.\-/]+|\/[\w.\-/]+\.[\w]+)/g)) {
        const candidate = match[1].trim()
        if (looksLikePath(candidate) && !isNoisePath(candidate)) refs.add(candidate)
      }
    }
  }
  return { refs: [...refs].slice(0, 30), skills: [...skills].slice(0, 15) }
}

function looksLikePath(value) {
  if (!value.includes('/')) return false
  if (/^https?:\/\//i.test(value)) return false
  if (/^www\./i.test(value)) return false
  if (/^[a-z0-9-]+(\.[a-z]{2,})+\//i.test(value)) return false
  return true
}

/**
 * Rebase workspace-internal references onto the workspace root; drop
 * machine-specific paths outside it.
 */
function relativizeRefs(cwd, refs) {
  if (!refs || refs.length === 0) return refs
  const root = (cwd || '').replace(/[\\/]+$/, '')
  const seen = new Set()
  const out = []
  for (const ref of refs) {
    if (isNoisePath(ref)) continue
    let display
    if (root && isAbsolute(ref)) {
      const rel = relative(root, ref)
      if (!rel || rel.startsWith('..') || isAbsolute(rel)) continue
      display = rel.split(sep).join('/')
    } else if (ref.startsWith('..')) {
      continue
    } else {
      display = ref
    }
    if (display === '.' || display === '') continue
    if (seen.has(display)) continue
    seen.add(display)
    out.push(display)
  }
  return out
}

/* ------------------------------------------------------------------ *
 * Retention                                                           *
 * ------------------------------------------------------------------ */

/** Delete documents generated before the 60-day cutoff. */
async function prune(handle) {
  const table = handle.table(TABLE_NAME)
  const cutoff = Date.now() - RETENTION_MS
  const stale = []
  for (const [key, document] of table.entries()) {
    if (!document || typeof document.generatedAt !== 'number' || document.generatedAt < cutoff) {
      stale.push(key)
    }
  }
  if (stale.length === 0) return
  const removed = await table.deleteMany(stale)
  console.log(LOG_PREFIX, 'pruned ' + removed + ' document(s) older than ' + RETENTION_DAYS + ' days')
}

/* ------------------------------------------------------------------ *
 * HTTP helpers                                                        *
 * ------------------------------------------------------------------ */

async function readTitle(sessionQuery, sessionId) {
  try {
    const snapshot = await sessionQuery.readTitle(sessionId)
    if (snapshot && typeof snapshot.title === 'string') return snapshot.title.trim()
  } catch (error) {
    console.warn(LOG_PREFIX, 'readTitle failed:', error)
  }
  return ''
}

function readSessionIdFromUrl(req) {
  const url = new URL(req.url || '/', 'http://localhost')
  const sessionId = url.searchParams.get('sessionId') || ''
  if (!sessionId || sessionId.length > MAX_SESSION_ID_LENGTH) return ''
  return sessionId
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    req.on('data', (chunk) => {
      total += chunk.length
      if (total > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (!raw) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(raw))
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res, status, value) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(value))
}

function errorMessage(error) {
  if (!error) return '未知错误'
  return String(error.message || error)
}

/* ------------------------------------------------------------------ *
 * Text helpers                                                        *
 * ------------------------------------------------------------------ */

function extractText(message) {
  if (!message || !Array.isArray(message.content)) return ''
  const parts = []
  for (const block of message.content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
      parts.push(block.text)
    }
  }
  return parts.join('\n').trim()
}

function redact(text) {
  return String(text)
    .replace(/sk-[A-Za-z0-9]{12,}/g, 'sk-***')
    .replace(/ghp_[A-Za-z0-9]{20,}/g, 'ghp_***')
    .replace(/AKIA[0-9A-Z]{16}/g, 'AKIA***')
    .replace(/(api[_-]?key|apikey)\s*[:=]\s*(['"]?)[^\s'"]{8,}\2/gi, '$1: ***')
    .replace(/(password|passwd|secret|bearer\s+token)\s*[:=]\s*(['"]?)[^\s'"]{8,}\2/gi, '$1: ***')
    .replace(/(Bearer\s+)[A-Za-z0-9._-]{12,}/g, 'Bearer ***')
}

function clamp(text, max) {
  return text.length > max ? text.slice(0, max) + '\n…（截断）' : text
}

function fmtTime(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return ''
  const date = new Date(ms)
  return pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
}

function pad(value) {
  return String(value).padStart(2, '0')
}
