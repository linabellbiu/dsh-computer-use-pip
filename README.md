# dsh-computer-use-pip —— 电脑操作小窗

Agent 在后台操作电脑时，屏幕右上角浮一个**置顶小窗**，实时镜像它正在操作的那个窗口。
纯观察：没有文字、没有暂停，关掉它不会影响 Agent。

## 界面

- **尺寸**：宽 320，高度跟随目标窗口宽高比（140–430）；**双击在 1× / 3× 之间切换**（3× 受屏幕高度限制）。
- **投影**：无描边；窗口四周留 22pt 透明边距，自绘柔和投影（半径 18、向下偏移 8），边缘直接贴画面，不会出现深色描边。
- **按钮**（右上角深色小胶囊里的两个图标）：
  - ⤴ **接管**：把被操作的窗口切到前台，你直接接手（不影响 Agent 继续跑）。
  - ✕ **关闭**：只收起小窗。**不影响 Agent**；它的下一个动作会让小窗自己重新出现。
- 拖动任意处移动；位置记在 NSUserDefaults，下次开在同一位置（换显示器落到屏外则回到右上角）。
- 置顶 floating 层、不抢键盘焦点、跨 Space/全屏。

## 组成

| 部分 | 文件 | 职责 |
|---|---|---|
| 小窗 | `overlay/main.swift` → `dist/ComputerUsePip.app` | 只显示 `frame.png` + 两个按钮，按钮写 `control.json` |
| 桥接 | `plugin/pip-bridge.mjs` | 跟随目标窗口 → cua-driver 抓帧（`display_only`，约 4 fps）→ 写 `state.json`/`frame.png`；处理按钮动作 |
| 插件 | `plugin/lib/index.js` | App 启动时拉起桥接；暴露 `computer_pip` 工具（status/show/hide） |
| 联动 | `dsh-computer-use-next/lib/cua.js` 约 30 行 | 每次带目标窗口的调用写 `activity.json`；没装小窗时静默跳过 |

## 状态目录 ~/.dsh/computer-use-pip/

```
activity.json   computer-use 每次动作写入 {pid, windowId, tool, action, at}
pin.json        computer_pip action=show 手动钉住（优先，不过期）
state.json      桥接 → 小窗 {visible, status, aspect, frameSeq, updatedAt}
frame.png       最新一帧（原子替换）
control.json    小窗 → 桥接 {seq, action: takeover|hide}
hidden.json     关闭小窗的标记：同一条旧动作不会把小窗弹回来
overlay.pid     小窗进程 pid（只用这个 kill，绝不按模糊 cmdline 批量 pkill）
bridge.log      桥接启动/退出记录
```

## 生命周期

- App 启动 → 插件拉起 `pip-bridge.mjs --serve`（待机，不抓帧）。
- 有动作 → 按窗口抓到帧、拉起小窗 → 每次动作刷新一帧。
- 90 秒没动作 → 停抓帧、收窗；180 秒 → 小窗进程退出（下个动作再拉起）。
- 小窗被关/崩了：桥接在会话活跃时每秒检查一次，自动补起。

## 已知边界

- 抓帧走 cua-driver 的 `get_window_state`（`display_only:true`），4 fps 左右，不是视频流。
- 目标窗口被最小化/切走时可能拿到最后一帧或黑帧（系统捕获限制），下一个动作会恢复。
- 只在 macOS 上验证（Swift/AppKit + cua-driver）。

## 安装 / 卸载

需要 macOS 13+ 和 Xcode Command Line Tools（构建原生小窗）。

```bash
git clone https://github.com/linabellbiu/dsh-computer-use-pip.git
cd dsh-computer-use-pip
./install.sh          # 构建小窗 + 复制到 ~/.dsh/tools + profile 登记 + 软链
```

然后 ⌘Q 退出 DSH 再打开。

卸载：还原 `~/.dsh/profiles/desktop/package.json.bak-pip-*`，删 `~/.dsh/tools/dsh-computer-use-pip`、
`~/.dsh/profiles/desktop/node_modules/dsh-computer-use-pip`、`~/.dsh/computer-use-pip`，再重启 App。
