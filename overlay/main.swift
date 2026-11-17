// ComputerUsePip — DSH 电脑操作小窗（纯镜像 + 两个小按钮，无文字）
import AppKit
import Foundation

struct PipState: Decodable {
    var version: Int?
    var visible: Bool?
    var status: String?
    var app: String?
    var title: String?
    var action: String?
    var windowId: Int?
    var frameSeq: Int?
    var framePath: String?
    var aspect: Double?
    var updatedAt: Double?
}

struct PipControl: Encodable {
    var seq: Int
    var action: String
    var at: Double
}

/// 可拖动的内容视图：拖拽移动窗口，双击切换缩放。按钮是子视图，不受影响。

/// 用 NSShadow 直接绘制的投影层，避免 CALayer shadow 被裁剪。
final class ShadowView: NSView {
    override var isOpaque: Bool { false }
    override func draw(_ dirtyRect: NSRect) {
        let rect = bounds.insetBy(dx: 1, dy: 1)
        let path = NSBezierPath(roundedRect: rect, xRadius: 12, yRadius: 12)
        NSGraphicsContext.saveGraphicsState()
        let shadow = NSShadow()
        shadow.shadowColor = NSColor.black.withAlphaComponent(0.38)
        shadow.shadowBlurRadius = 16
        shadow.shadowOffset = NSSize(width: 0, height: -8)
        shadow.set()
        NSColor.black.setFill()
        path.fill()
        NSGraphicsContext.restoreGraphicsState()
    }
}

final class PipContentView: NSView {
    var onDoubleClick: (() -> Void)?
    var imageFrame: NSRect = .zero

    override func draw(_ dirtyRect: NSRect) {
        guard imageFrame.width > 1 else { return }
        NSGraphicsContext.saveGraphicsState()
        for i in 1...18 {
            let grow = CGFloat(i)
            let rect = imageFrame.insetBy(dx: -grow, dy: -grow).offsetBy(dx: 0, dy: -grow * 0.45)
            let path = NSBezierPath(roundedRect: rect, xRadius: 12 + grow * 0.4, yRadius: 12 + grow * 0.4)
            NSColor.black.withAlphaComponent(0.020).setFill()
            path.fill()
        }
        NSGraphicsContext.restoreGraphicsState()
    }
    private var dragStartMouse: NSPoint?
    private var dragStartOrigin: NSPoint?

    override func mouseDown(with event: NSEvent) {
        if event.clickCount == 2 {
            onDoubleClick?()
            return
        }
        dragStartMouse = NSEvent.mouseLocation
        dragStartOrigin = window?.frame.origin
    }

    override func mouseDragged(with event: NSEvent) {
        guard let startMouse = dragStartMouse, let startOrigin = dragStartOrigin, let win = window else { return }
        let now = NSEvent.mouseLocation
        win.setFrameOrigin(NSPoint(x: startOrigin.x + (now.x - startMouse.x),
                                   y: startOrigin.y + (now.y - startMouse.y)))
    }

    override func mouseUp(with event: NSEvent) {
        dragStartMouse = nil
        dragStartOrigin = nil
    }
}

final class PipWindowController: NSObject, NSApplicationDelegate {
    private var window: NSWindow!
    private let stateDir: URL
    private var imageView: NSImageView!
    private var controlBar: NSView!
    private var lastFrameSeq = -1
    private var lastVisible: Bool?
    private var lastAspect: Double = 0
    private var lastControlSeq = 0
    private var zoomed = false
    private let zoomFactor: CGFloat = 3
    private let defaults = UserDefaults.standard
    private var timer: Timer?

    private let width: CGFloat = 320
    private let padX: CGFloat = 0
    private let padTop: CGFloat = 0
    private let padBottom: CGFloat = 0
    private var shadowView: NSView!
    private var contentView: PipContentView!

    init(stateDir: URL) {
        self.stateDir = stateDir
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildWindow()
        tick()
        timer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
            self?.tick()
        }
        if let t = timer { RunLoop.main.add(t, forMode: .common) }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    private func buildWindow() {
        zoomed = defaults.bool(forKey: "pip.zoomed")
        let image = NSSize(width: currentWidth, height: heightFor(aspect: 1.6))
        let size = windowSize(for: image)
        let rect = NSRect(origin: rememberedOrigin(size: size), size: size)
        window = NSWindow(contentRect: rect, styleMask: [.borderless, .fullSizeContentView], backing: .buffered, defer: false)
        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = true
        window.level = .floating
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        window.isMovableByWindowBackground = false
        window.isReleasedWhenClosed = false
        window.appearance = NSAppearance(named: .darkAqua)

        let content = PipContentView(frame: NSRect(origin: .zero, size: size))
        content.onDoubleClick = { [weak self] in self?.onZoom() }
        content.wantsLayer = true
        content.layer?.backgroundColor = NSColor.clear.cgColor
        content.layer?.cornerRadius = 12
        content.layer?.borderWidth = 0.5
        content.layer?.borderColor = NSColor.black.withAlphaComponent(0.05).cgColor
        content.layer?.masksToBounds = false
        window.contentView = content

        // 投影层：窗口留出透明边距，投影画在边距里，边缘不会出现"描边"
        shadowView = NSView(frame: imageRect(for: image))
        shadowView.wantsLayer = true
        shadowView.layer?.backgroundColor = NSColor.black.cgColor
        shadowView.layer?.cornerRadius = 12
        shadowView.layer?.shadowColor = NSColor.black.cgColor
        shadowView.layer?.shadowOpacity = 0
        shadowView.layer?.shadowRadius = 24
        shadowView.layer?.shadowOffset = CGSize(width: 0, height: -8)
        content.addSubview(shadowView)

        imageView = NSImageView(frame: imageRect(for: image))
        imageView.autoresizingMask = []
        imageView.imageScaling = .scaleProportionallyUpOrDown
        imageView.wantsLayer = true
        imageView.layer?.cornerRadius = 12
        imageView.layer?.masksToBounds = true
        content.addSubview(imageView)

        // 右上角极小控制条：接管 / 关闭
        controlBar = NSView(frame: controlBarRect(for: image))
        controlBar.wantsLayer = true
        controlBar.layer?.backgroundColor = NSColor(calibratedWhite: 0.1, alpha: 0.62).cgColor
        controlBar.layer?.cornerRadius = 11
        content.addSubview(controlBar)

        var bx: CGFloat = 2
        let specs: [(String, String, Selector)] = [
            ("arrow.up.forward.app.fill", "接管", #selector(onTakeover)),
            ("xmark", "关闭小窗（不影响 Agent）", #selector(onHide)),
        ]
        for (symbol, tip, sel) in specs {
            let b = NSButton(frame: NSRect(x: bx, y: 1, width: 22, height: 20))
            b.isBordered = false
            b.imagePosition = .imageOnly
            let cfg = NSImage.SymbolConfiguration(pointSize: 11, weight: .semibold)
            b.image = NSImage(systemSymbolName: symbol, accessibilityDescription: tip)?.withSymbolConfiguration(cfg)
            b.contentTintColor = NSColor(calibratedWhite: 0.95, alpha: 0.92)
            b.toolTip = tip
            b.target = self
            b.action = sel
            controlBar.addSubview(b)
            bx += 25
        }

        window.setFrame(rect, display: false)
        window.orderFrontRegardless()
    }

    private func windowSize(for image: NSSize) -> NSSize {
        NSSize(width: image.width + padX * 2, height: image.height + padTop + padBottom)
    }

    private func imageRect(for image: NSSize) -> NSRect {
        NSRect(x: padX, y: padBottom, width: image.width, height: image.height)
    }

    private func controlBarRect(for image: NSSize) -> NSRect {
        NSRect(x: padX + image.width - 62, y: padBottom + image.height - 30, width: 54, height: 22)
    }

    private func applyChromeLayout(for image: NSSize) {
        let frame = imageRect(for: image)
        shadowView.frame = frame
        contentView?.needsDisplay = true
        imageView.frame = frame
        controlBar.frame = controlBarRect(for: image)
    }

    private var currentWidth: CGFloat { width * (zoomed ? zoomFactor : 1) }

    private func heightFor(aspect: Double) -> CGFloat {
        let ratio = (aspect > 0.25 && aspect < 8) ? CGFloat(aspect) : 1.6
        let raw = (currentWidth / ratio).rounded()
        if zoomed {
            let maxH = ((NSScreen.main ?? NSScreen.screens[0]).visibleFrame.height - 40)
            return min(raw, maxH)
        }
        return max(140, min(430, raw))
    }

    private func rememberedOrigin(size: NSSize) -> NSPoint {
        let screen = NSScreen.main ?? NSScreen.screens[0]
        let vf = screen.visibleFrame
        let sx = defaults.object(forKey: "pip.origin.x") as? Double
        let sy = defaults.object(forKey: "pip.origin.y") as? Double
        if let x = sx, let y = sy {
            let candidate = NSRect(x: x, y: y, width: size.width, height: size.height)
            if NSScreen.screens.contains(where: { $0.visibleFrame.intersects(candidate) }) {
                return NSPoint(x: x, y: y)
            }
        }
        return NSPoint(x: vf.maxX - size.width - 16, y: vf.maxY - size.height - 16)
    }

    private func tick() {
        defaults.set(window.frame.origin.x, forKey: "pip.origin.x")
        defaults.set(window.frame.origin.y, forKey: "pip.origin.y")

        guard let state = readState() else {
            if lastVisible != false { setVisible(false) }
            return
        }
        let visible = state.visible ?? true
        if lastVisible != visible { setVisible(visible) }
        guard visible else { return }

        if let aspect = state.aspect { applyAspect(aspect) }
        if let seq = state.frameSeq, seq != lastFrameSeq {
            lastFrameSeq = seq
            loadFrame(state.framePath)
        }
    }

    private func readState() -> PipState? {
        let url = stateDir.appendingPathComponent("state.json")
        guard let data = try? Data(contentsOf: url) else { return nil }
        guard let state = try? JSONDecoder().decode(PipState.self, from: data) else { return nil }
        if let at = state.updatedAt, Date().timeIntervalSince1970 * 1000 - at > 20_000 { return nil }
        return state
    }

    private func loadFrame(_ path: String?) {
        var candidates: [URL] = []
        if let p = path, !p.isEmpty { candidates.append(URL(fileURLWithPath: p)) }
        candidates.append(stateDir.appendingPathComponent("frame.png"))
        for url in candidates {
            if let img = NSImage(contentsOf: url), img.size.width > 1 {
                imageView.image = img
                return
            }
        }
    }

    private func setVisible(_ visible: Bool) {
        lastVisible = visible
        if visible { window.orderFrontRegardless() } else { window.orderOut(nil) }
    }

    private func applyAspect(_ aspect: Double) {
        guard aspect > 0.25, aspect < 8 else { return }
        if abs(aspect - lastAspect) < 0.04 { return }
        lastAspect = aspect
        relayout(anchorTopRight: true)
    }

    /// 带缓动的窗口尺寸动画（缩放用）
    private func animateFrame(to frame: NSRect) {
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.22
            context.timingFunction = CAMediaTimingFunction(name: .easeOut)
            window.animator().setFrame(frame, display: true)
        }
    }

    /// 按当前缩放状态与宽高比重排尺寸；anchorTopRight 时保持窗口右上角不动（贴边向左侧生长）。
    private func relayout(anchorTopRight: Bool, animated: Bool = false) {
        var frame = window.frame
        let top = frame.origin.y + frame.height
        let right = frame.origin.x + frame.width
        let image = NSSize(width: currentWidth, height: heightFor(aspect: lastAspect > 0 ? lastAspect : 1.6))
        let target = windowSize(for: image)
        frame.size = target
        if anchorTopRight {
            frame.origin = NSPoint(x: right - target.width, y: top - target.height)
        }
        applyChromeLayout(for: image)
        let vf = (NSScreen.main ?? NSScreen.screens[0]).visibleFrame
        if frame.maxX > vf.maxX { frame.origin.x = vf.maxX - frame.width }
        if frame.minX < vf.minX { frame.origin.x = vf.minX }
        if frame.maxY > vf.maxY { frame.origin.y = vf.maxY - frame.height }
        if frame.minY < vf.minY { frame.origin.y = vf.minY }
        if animated {
            animateFrame(to: frame)
        } else {
            window.setFrame(frame, display: true)
        }
    }

    /// 双击切换 放大(3x) / 还原
    @objc private func onZoom() {
        zoomed.toggle()
        defaults.set(zoomed, forKey: "pip.zoomed")
        relayout(anchorTopRight: true, animated: true)
    }

    private func writeControl(_ action: String) {
        lastControlSeq += 1
        let control = PipControl(seq: lastControlSeq, action: action, at: Date().timeIntervalSince1970 * 1000)
        if let data = try? JSONEncoder().encode(control) {
            try? data.write(to: stateDir.appendingPathComponent("control.json"), options: .atomic)
        }
    }

    @objc private func onTakeover() { writeControl("takeover") }
    @objc private func onHide() { writeControl("hide"); setVisible(false) }
}

let args = CommandLine.arguments
var dirPath = NSString(string: "~/.dsh/computer-use-pip").expandingTildeInPath
if let i = args.firstIndex(of: "--dir"), i + 1 < args.count {
    dirPath = NSString(string: args[i + 1]).expandingTildeInPath
}
try? FileManager.default.createDirectory(atPath: dirPath, withIntermediateDirectories: true)

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let controller = PipWindowController(stateDir: URL(fileURLWithPath: dirPath))
app.delegate = controller
app.run()