/**
 * dsh-computer-use-pip —— Codex 风格的「电脑操作小窗」。
 *
 * 由三块组成：
 *   pip-bridge.mjs   常驻桥接：跟随 activity.json / pin.json，用 cua-driver 抓帧，写 state.json
 *   dist/…app        置顶透明小窗（Swift/AppKit），只负责显示 + 按钮回写 control.json
 *   本文件             DSH 插件：拉起桥接进程 + 暴露 computer_pip 工具
 *
 * 状态文件目录：~/.dsh/computer-use-pip/
 *   activity.json  由 dsh-computer-use-next 每次动作写入（pid/windowId/tool/action/at）
 *   pin.json       computer_pip action=show 手动钉住的目标
 *   state.json     桥接写给小窗的显示状态
 *   control.json   小窗按钮回写（pause/resume/takeover/stop/hide）
 *   frame.png      最新一帧
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-computer-use-pip'
export const inject = ['tools']

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = join(HERE, '..')
const STATE_DIR = process.env.PIP_STATE_DIR || join(homedir(), '.dsh', 'computer-use-pip')
const BRIDGE = join(PLUGIN_ROOT, 'pip-bridge.mjs')

/** 找真正能跑 .mjs 的 node：桌面版进程里 process.execPath 是 Electron App 本身。 */
function resolveNode() {
  const explicit = process.env.PIP_NODE
  if (explicit && existsSync(explicit)) return { cmd: explicit, env: {} }
  const candidates = [
    join(homedir(), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'node', 'bin', 'node'),
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
    '/usr/bin/node',
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return { cmd: candidate, env: {} }
  }
  // 兜底：把 Electron 当 node 跑
  return { cmd: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } }
}

function bridgeLog(line) {
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    writeFileSync(join(STATE_DIR, 'bridge.log'), new Date().toISOString() + ' ' + line + '\n', { flag: 'a' })
  } catch { /* 日志失败不影响主流程 */ }
}

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
}

function writeJson(file, value) {
  mkdirSync(STATE_DIR, { recursive: true })
  writeFileSync(file + '.tmp', JSON.stringify(value))
  rmSync(file, { force: true })
  writeFileSync(file, JSON.stringify(value))
}

function statusSnapshot() {
  const state = readJson(join(STATE_DIR, 'state.json')) || {}
  const control = readJson(join(STATE_DIR, 'control.json')) || {}
  return {
    visible: state.visible ?? false,
    status: state.status ?? 'idle',
    app: state.app ?? null,
    title: state.title ?? null,
    windowId: state.windowId ?? null,
    action: state.action ?? null,
    frameSeq: state.frameSeq ?? 0,
    updatedAt: state.updatedAt ?? null,
    lastControl: control.action ?? null,
    stateDir: STATE_DIR,
  }
}

function pipTool(deps) {
  return {
    name: 'computer_pip',
    timeoutMs: 20_000,
    isConcurrencySafe: (args) => String(args?.action || '') === 'status',
    description:
      'Codex 风格的「电脑操作小窗」：右上角置顶小窗实时镜像 Agent 正在操作的窗口，带 暂停/接管/停止 按钮。' +
      'action=status 查看状态；show 手动钉住某个窗口（pid+windowId）；hide 收起；pause/resume/stop 等同于点小窗上的按钮。' +
      '平时不需要调用：dsh-computer-use-next 每次动作会自动把小窗引到目标窗口。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'show', 'hide', 'pause', 'resume', 'stop'] },
        pid: { type: 'number', description: 'show 的目标进程 pid' },
        windowId: { type: 'number', description: 'show 的目标窗口 id' },
        app: { type: 'string', description: 'show 的显示名（可选）' },
        title: { type: 'string', description: 'show 的窗口标题（可选）' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args) {
      const action = String(args?.action || 'status')
      mkdirSync(STATE_DIR, { recursive: true })
      switch (action) {
        case 'status':
          return { ok: true, ...statusSnapshot() }
        case 'show': {
          if (!args?.pid || !args?.windowId) return { ok: false, error: 'show 需要 pid 和 windowId' }
          writeJson(join(STATE_DIR, 'pin.json'), {
            pid: Number(args.pid), windowId: Number(args.windowId),
            app: args.app, title: args.title, at: Date.now(),
          })
          await deps.ensureBridge()
          return { ok: true, pinned: true, ...statusSnapshot() }
        }
        case 'hide':
          rmSync(join(STATE_DIR, 'pin.json'), { force: true })
          writeJson(join(STATE_DIR, 'control.json'), { seq: Date.now(), action: 'hide', at: Date.now() })
          return { ok: true, hidden: true }
        case 'pause':
        case 'stop':
          writeJson(join(STATE_DIR, 'control.json'), { seq: Date.now(), action, at: Date.now() })
          return { ok: true, sent: action }
        case 'resume': {
          const gate = readJson(join(STATE_DIR, 'gate.json'))
          if (gate && gate.mode && gate.mode !== 'run') {
            return { ok: false, error: '暂停/停止只能由用户在小窗里点「继续」解除，Agent 不能自己恢复。' }
          }
          writeJson(join(STATE_DIR, 'control.json'), { seq: Date.now(), action: 'resume', at: Date.now() })
          return { ok: true, sent: 'resume' }
        }
        default:
          return { ok: false, error: 'unknown action: ' + action }
      }
    },
  }
}

export function apply(ctx, pluginConfig = {}) {
  const config = pluginConfig || {}
  const enabled = config.enabled !== false
  let child
  let disposed = false

  const ensureBridge = async () => {
    if (!enabled || disposed) return { started: false }
    if (child && child.exitCode === null) return { started: false, running: true }
    if (!existsSync(BRIDGE)) {
      bridgeLog('bridge missing: ' + BRIDGE)
      return { started: false, error: 'bridge missing: ' + BRIDGE }
    }
    const node = resolveNode()
    child = spawn(node.cmd, [BRIDGE, '--serve'], {
      stdio: 'ignore',
      env: { ...process.env, ...node.env },
    })
    bridgeLog('spawned bridge pid=' + (child.pid ?? '?') + ' via ' + node.cmd)
    child.on('error', (error) => bridgeLog('bridge spawn error: ' + (error?.message || error)))
    child.on('exit', (code, signal) => {
      bridgeLog('bridge exited code=' + code + ' signal=' + signal)
      child = undefined
    })
    return { started: true, pid: child.pid, node: node.cmd }
  }

  if (ctx.tools && typeof ctx.tools.register === 'function') {
    ctx.effect(() => ctx.tools.register(pipTool({ ensureBridge })), 'dsh-computer-use-pip: computer_pip tool')
  }

  // 起桥接：DSH 起来就把小窗服务拉起，没活动时它自己待机
  ensureBridge().catch((error) => {
    console.warn('[dsh-computer-use-pip] 桥接启动失败:', error?.message || error)
  })

  ctx.effect(() => () => {
    disposed = true
    try { child?.kill('SIGTERM') } catch { /* 已退出 */ }
  }, 'dsh-computer-use-pip: bridge lifecycle')
}

export default { name, inject, apply }