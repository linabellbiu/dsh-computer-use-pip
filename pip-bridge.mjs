#!/usr/bin/env node
/**
 * pip-bridge.mjs — Computer Use 小窗的桥接进程
 *
 * 职责：
 *   1. 盯着「当前被 Agent 操作的窗口」（activity.json / CLI 参数）
 *   2. 用 cua-driver 抓该窗口的最新画面，落到 frame.png（原子写）
 *   3. 维护 state.json（给 overlay 读）
 *   4. 监听 control.json（overlay 按钮回写）：pause / resume / takeover / stop / hide
 *   5. 按需拉起 / 关闭小窗 app
 *
 * 用法（单独跑做联调）：
 *   node pip-bridge.mjs --window 37386 --pid 23902 --title "工作区会话丢失" --app "DeepSeek Harness" --seconds 60
 */
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const STATE_DIR = process.env.PIP_STATE_DIR || join(homedir(), '.dsh', 'computer-use-pip')
const OVERLAY_CANDIDATES = [
  process.env.PIP_OVERLAY_APP,
  join(HERE, '..', 'dist', 'ComputerUsePip.app'),
  join(HERE, 'dist', 'ComputerUsePip.app'),
].filter(Boolean)
const OVERLAY_APP = OVERLAY_CANDIDATES.find((p) => existsSync(p)) || OVERLAY_CANDIDATES[1]

// ---------- cua-driver 定位 ----------

function resolveCua() {
  const explicit = process.env.CUA_DRIVER_BIN
  if (explicit && existsSync(explicit)) return explicit
  for (const p of [
    join(homedir(), '.local', 'bin', 'cua-driver'),
    join(homedir(), '.cua-driver', 'packages', 'current', 'cua-driver'),
    '/Applications/CuaDriver.app/Contents/MacOS/cua-driver',
    '/usr/local/bin/cua-driver',
    '/opt/homebrew/bin/cua-driver',
  ]) if (existsSync(p)) return p
  return 'cua-driver'
}
const CUA = resolveCua()

// ---------- 原子写 ----------

function writeAtomic(file, data) {
  const tmp = file + '.tmp-' + process.pid
  writeFileSync(tmp, data)
  renameSync(tmp, file)
}

function publishState(patch) {
  mkdirSync(STATE_DIR, { recursive: true })
  const file = join(STATE_DIR, 'state.json')
  let prev = {}
  try { prev = JSON.parse(readFileSync(file, 'utf8')) } catch { /* 首次 */ }
  const next = { version: 1, ...prev, ...patch, updatedAt: Date.now() }
  writeAtomic(file, JSON.stringify(next))
  return next
}

// ---------- 抓帧 ----------

let frameSeq = 0

/** 抓一次目标窗口画面；display_only=true 不占用动作快照，纯预览。 */
export function captureFrame({ pid, windowId }, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const out = join(STATE_DIR, 'frame.raw.png')
    const args = ['call', 'get_window_state', JSON.stringify({
      pid, window_id: windowId, include_accessibility_tree: false, include_screenshot: true, display_only: true,
    }), '--screenshot-out-file', out]
    const child = spawn(CUA, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve({ ok: false, error: 'timeout' }) }, timeoutMs)
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: e.message }) })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0 || !existsSync(out)) return resolve({ ok: false, error: 'exit ' + code })
      try {
        const buf = readFileSync(out)
        rmSync(out, { force: true })
        frameSeq += 1
        writeAtomic(join(STATE_DIR, 'frame.png'), buf)
        resolve({ ok: true, bytes: buf.byteLength, seq: frameSeq })
      } catch (e) { resolve({ ok: false, error: String(e) }) }
    })
  })
}

/** 把某个窗口带到前台（接管按钮）。 */
export function bringToFront({ pid, windowId }) {
  try {
    execFileSync(CUA, ['call', 'bring_to_front', JSON.stringify({ pid, window_id: windowId })], { stdio: 'ignore', timeout: 6000 })
    return true
  } catch { return false }
}

// ---------- 小窗生命周期 ----------

const OVERLAY_PID_FILE = join(STATE_DIR, 'overlay.pid')

function pidAlive(pid) {
  if (!pid || !Number.isFinite(pid)) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

export function overlayPid() {
  try {
    const pid = Number(readFileSync(OVERLAY_PID_FILE, 'utf8').trim())
    if (pidAlive(pid)) return pid
  } catch { /* 没有 pidfile */ }
  try {
    // 兜底：只匹配"带 --dir 参数"的那个可执行进程，绝不匹配编译器/编辑器之类
    const out = execFileSync('pgrep', ['-f', 'MacOS/ComputerUsePip --dir'], { encoding: 'utf8' })
    const pid = Number(out.trim().split('\n')[0])
    return pidAlive(pid) ? pid : 0
  } catch { return 0 }
}

export function overlayRunning() {
  return overlayPid() > 0
}

export function ensureOverlay() {
  const running = overlayPid()
  if (running) return { started: false, pid: running }
  const bin = join(OVERLAY_APP, 'Contents', 'MacOS', 'ComputerUsePip')
  if (!existsSync(bin)) return { started: false, error: 'overlay not built: ' + bin }
  mkdirSync(STATE_DIR, { recursive: true })
  const child = spawn(bin, ['--dir', STATE_DIR], { detached: true, stdio: 'ignore' })
  child.unref()
  if (child.pid) { try { writeAtomic(OVERLAY_PID_FILE, String(child.pid)) } catch { /* 非致命 */ } }
  return { started: true, pid: child.pid }
}

/** 只杀我们记下的那个进程；绝不按模糊命令行批量 pkill（会误伤同路径编译等）。 */
export function stopOverlay() {
  const pid = overlayPid()
  if (!pid) return
  try { process.kill(pid, 'SIGTERM') } catch { /* 已退出 */ }
  try { rmSync(OVERLAY_PID_FILE, { force: true }) } catch { /* 忽略 */ }
}


// ---------- 窗口名解析（activity 只带 pid/windowId 时补 app/title） ----------

let windowCache = { at: 0, list: [] }

function listWindowsCached() {
  if (Date.now() - windowCache.at < 10_000) return windowCache.list
  try {
    const out = execFileSync(CUA, ['call', 'list_windows', '{}'], { encoding: 'utf8', timeout: 8000, maxBuffer: 8 * 1024 * 1024 })
    const parsed = JSON.parse(out)
    windowCache = { at: Date.now(), list: parsed.windows || parsed || [] }
  } catch { /* 用旧缓存 */ }
  return windowCache.list
}

function resolveWindow(pid, windowId) {
  for (const w of listWindowsCached()) {
    if (Number(w.window_id) === windowId && (!pid || Number(w.pid) === pid)) {
      const b = w.bounds || {}
      const ratio = Number(b.width) > 0 && Number(b.height) > 0 ? Number(b.width) / Number(b.height) : undefined
      return { app: w.app_name || w.owner_name || w.name, title: w.title, aspect: ratio }
    }
  }
  return {}
}

// ---------- 控制文件 ----------

/** 读取当前 control.json 的 seq（新会话起点，用来忽略历史指令）。 */
export function currentControlSeq() {
  try {
    const file = join(STATE_DIR, 'control.json')
    const value = JSON.parse(readFileSync(file, 'utf8'))
    return typeof value?.seq === 'number' ? value.seq : 0
  } catch { return 0 }
}

export function readControl(lastSeen) {
  const file = join(STATE_DIR, 'control.json')
  if (!existsSync(file)) return null
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'))
    if (!value || typeof value.seq !== 'number' || value.seq <= lastSeen) return null
    return value
  } catch { return null }
}

// ---------- 状态机 ----------

export class PipSession {
  constructor({ pid, windowId, app, title, aspect, fps = 4 }) {
    this.target = { pid, windowId }
    this.app = app
    this.title = title
    this.aspect = aspect
    this.interval = Math.round(1000 / fps)
    this.status = 'driving'
    this.action = ''
    this.hidden = false
    this.closed = false
    this.lastControlSeq = 0
    this.lastSize = 0
    this.timers = []
  }

  start() {
    mkdirSync(STATE_DIR, { recursive: true })
    // 只响应本会话开始之后写入的控制指令
    this.lastControlSeq = currentControlSeq()
    const overlay = ensureOverlay()
    writeGate('run')
    this.publish()
    // 抓帧循环（串行：上一帧没抓完不叠加）
    let busy = false
    this.frames = setInterval(async () => {
      if (busy || this.status === 'paused' || this.status === 'stopped') return
      busy = true
      const r = await captureFrame(this.target)
      busy = false
      if (r.ok) {
        this.lastSize = r.bytes
        publishState(this.snapshot({ frameSeq: r.seq }))
      } else {
        publishState(this.snapshot({ action: this.action + '  (抓帧失败: ' + r.error + ')' }))
      }
    }, this.interval)
    // 控制回写轮询
    this.controls = setInterval(() => {
      const c = readControl(this.lastControlSeq)
      if (!c) return
      this.lastControlSeq = c.seq
      this.onControl(c.action)
    }, 150)
    return overlay
  }

  snapshot(extra = {}) {
    return {
      aspect: this.aspect,
      visible: this.status !== 'stopped' && this.hidden !== true,
      status: this.status,
      app: this.app,
      title: this.title,
      windowId: this.target.windowId,
      action: this.action,
      ...extra,
    }
  }

  publish() {
    publishState(this.snapshot())
  }

  /** 改变运行状态（driving / paused / stopped / waiting）。 */
  setStatus(status) {
    this.status = status
    this.publish()
  }

  setAction(text) {
    this.action = text
    this.publish()
  }

  onControl(action) {
    switch (action) {
      case 'pause':
        this.setStatus('paused')
        writeGate('pause')
        publishState(this.snapshot({ action: '你暂停了电脑操作' }))
        break
      case 'resume':
        this.setStatus('driving')
        writeGate('run')
        publishState(this.snapshot({ action: '已恢复电脑操作' }))
        break
      case 'takeover':
        this.bringToFront()
        publishState(this.snapshot({ action: '已把窗口切到前台' }))
        break
      case 'stop':
        this.setStatus('stopped')
        writeGate('stop')
        publishState(this.snapshot({ action: '你点了停止，Agent 已停手' }))
        stopOverlay()
        this.close()
        break
      case 'hide':
        markHidden()
        this.hidden = true
        publishState({ visible: false, status: 'idle' })
        this.close()
        break
      default:
        break
    }
  }

  bringToFront() { bringToFront(this.target) }

  close() {
    this.closed = true
    clearInterval(this.frames)
    clearInterval(this.controls)
  }
}

// ---------- CLI（联调用） ----------

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next && !next.startsWith('--')) { out[key] = next; i += 1 } else { out[key] = true }
    }
  }
  return out
}

// ---------- 常驻模式：跟随 activity.json（由 computer-use 插件写入） ----------

const ACTIVITY_FILE = join(STATE_DIR, 'activity.json')

const PIN_FILE = join(STATE_DIR, 'pin.json')
const GATE_FILE = join(STATE_DIR, 'gate.json')
const HIDDEN_FILE = join(STATE_DIR, 'hidden.json')

/** 用户点了关闭小窗：在被新动作"叫醒"之前不自动弹回。 */
function markHidden() {
  try { writeAtomic(HIDDEN_FILE, JSON.stringify({ at: Date.now() })) } catch { /* 非致命 */ }
}

function hiddenAt() {
  try { return JSON.parse(readFileSync(HIDDEN_FILE, 'utf8')).at || 0 } catch { return 0 }
}

/**
 * 人工刹车：用户点小窗按钮后写入 gate.json，computer-use 插件在执行动作前会读它。
 *   mode = pause（暂停/接管）| stop（停止）| run（正常）
 * 只有用户在小窗里点「继续」才会写回 run——Agent 不能自己解除。
 */
function writeGate(mode) {
  try { writeAtomic(GATE_FILE, JSON.stringify({ mode, at: Date.now() })) } catch { /* 非致命 */ }
}

/** 手动钉住的窗口优先，且不过期（工具 computer_pip show 写入，hide 删除）。 */
function readPin() {
  try {
    const a = JSON.parse(readFileSync(PIN_FILE, 'utf8'))
    if (!a || typeof a.windowId !== 'number' || typeof a.pid !== 'number') return null
    return a
  } catch { return null }
}

function readActivity() {
  const pin = readPin()
  if (pin) return pin
  try {
    const a = JSON.parse(readFileSync(ACTIVITY_FILE, 'utf8'))
    if (!a || typeof a.windowId !== 'number' || typeof a.pid !== 'number') return null
    if (Date.now() - (a.at || 0) > 60_000) return null // 超过 1 分钟没动 = 过期
    return a
  } catch { return null }
}

export class PipFollower {
  constructor({ idleStopMs = 90_000, idleExitMs = 180_000, fps = 4 } = {}) {
    this.fps = fps
    this.idleStopMs = idleStopMs
    this.idleExitMs = idleExitMs
    this.session = null
    this.lastKey = ''
    this.lastActivityAt = 0
    this.tick = null
  }

  start() {
    mkdirSync(STATE_DIR, { recursive: true })
    this.tick = setInterval(() => this.step(), 900)
    this.step()
    return this
  }

  step() {
    if (this.session && this.session.closed) {
      this.session = null
      this.lastKey = ''
    }
    let activity = readActivity()
    if (activity) {
      // 用户刚点了关闭：同一个动作不弹回；只有"更新的动作"才重新出现
      if ((activity.at || 0) <= hiddenAt()) activity = null
    }
    if (activity) {
      rmSync(HIDDEN_FILE, { force: true })
      this.lastActivityAt = Date.now()
      const key = activity.pid + ':' + activity.windowId
      if (key !== this.lastKey || this.session === null) {
        this.session?.close()
        this.lastKey = key
        const meta = resolveWindow(activity.pid, activity.windowId)
        this.aspect = meta.aspect
        this.session = new PipSession({
          pid: activity.pid,
          windowId: activity.windowId,
          app: activity.app || meta.app,
          title: activity.title || meta.title,
          aspect: meta.aspect,
          fps: this.fps,
        })
        this.session.start()
      }
      if (activity.action) this.session.setAction(activity.action)
      if (!overlayRunning()) ensureOverlay()
      return
    }
    // 没有活动：先停抓帧，再收掉小窗
    const idle = Date.now() - (this.lastActivityAt || Date.now())
    if (this.session && idle > this.idleStopMs) {
      this.session.close()
      this.session = null
      publishState({ visible: false, status: 'idle', action: '' })
    }
    if (idle > this.idleExitMs) stopOverlay()
  }

  close() {
    clearInterval(this.tick)
    this.session?.close()
  }
}

if (process.argv[1] && process.argv[1].endsWith('pip-bridge.mjs')) {
  const argv = process.argv.slice(2)
  if (argv.includes('--serve')) {
    const follower = new PipFollower({ fps: Number((parseArgs(argv).fps) || 4) }).start()
    console.log(JSON.stringify({ ok: true, mode: 'serve', stateDir: STATE_DIR, activityFile: ACTIVITY_FILE }))
    process.on('SIGTERM', () => { follower.close(); process.exit(0) })
    process.on('SIGINT', () => { follower.close(); process.exit(0) })
  }
}