import UIKit

/// The launch mark growing into a woven context network; mirrors Android's `LaunchNet`.
final class LaunchNet: UIView {
    enum Phase { case loading, slow, offline, broken }

    var phase = Phase.loading {
        didSet {
            guard phase != oldValue else { return }
            if phase == .slow { slowSince = clock }
            link?.isPaused = false
            breathe()
        }
    }

    private(set) var lifting = false

    private let background = UIColor(named: "LaunchBackground") ?? .systemBackground
    private let tileImage = UIImage(named: "LaunchTile")
    private let glyphImage = UIImage(named: "LaunchMark")
    private let logo = UIImageView(image: UIImage(named: "LaunchLogo"))
    private var liftToken = 0
    private var gradientCache: (Tone, CGGradient)?
    private var reduced = false
    private var link: CADisplayLink?
    private var idling = false
    private var last: CFTimeInterval?
    private var clock = 0.0
    private var turn = 0.0
    private var liftedAt: Double?
    private var onLifted: (() -> Void)?
    private var offline = 0.0, broken = 0.0, slow = 0.0, slowSince = 0.0
    private var clearing = CGRect.null, cleared = 0.0, clearingShown = false
    private var nodes: [Node] = []
    private var nodesFor = CGSize.zero

    override init(frame: CGRect) {
        super.init(frame: frame)
        isOpaque = false
        contentMode = .redraw
        layer.drawsAsynchronously = true
        logo.isHidden = true
        addSubview(logo)
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in self.setNeedsDisplay() }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    var clearance: CGFloat {
        reduced ? tileSize / 2 : max(tileSize / 2, finalRadius + Spec.hub / 2)
    }

    func clear(_ rect: CGRect?) {
        if let rect { clearing = rect.insetBy(dx: -40, dy: -32) }
        clearingShown = rect != nil
        link?.isPaused = false
    }

    func lift(_ done: @escaping () -> Void) {
        guard !lifting else { return }
        lifting = true
        guard !reduced, link != nil else {
            logo.layer.removeAnimation(forKey: Self.breatheKey)
            liftToken &+= 1
            let token = liftToken
            UIView.animate(withDuration: 0.18) {
                self.alpha = 0
            } completion: { _ in
                if self.lifting, self.liftToken == token { done() }
            }
            return
        }
        liftedAt = clock
        onLifted = done
        idling = false
        link?.isPaused = false
        link?.preferredFrameRateRange = Self.fluid
    }

    func hold() {
        guard lifting else { return }
        liftToken &+= 1
        lifting = false
        liftedAt = nil
        onLifted = nil
        layer.removeAnimation(forKey: "opacity")
        alpha = 1
        breathe()
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        link?.invalidate()
        link = nil
        guard window != nil else { return }
        reduced = UIAccessibility.isReduceMotionEnabled
        logo.isHidden = !reduced
        clock = 0
        turn = 0
        last = nil
        lifting = false
        liftedAt = nil
        onLifted = nil
        offline = 0
        broken = 0
        slow = 0
        idling = false
        alpha = 1
        breathe()
        setNeedsDisplay()
        guard !reduced else { return }
        let link = CADisplayLink(target: self, selector: #selector(step))
        link.preferredFrameRateRange = Self.fluid
        link.add(to: .main, forMode: .common)
        self.link = link
    }

    @objc private func step(_ link: CADisplayLink) {
        let dt = min(50, (link.timestamp - (last ?? link.timestamp)) * 1000)
        last = link.timestamp
        clock += dt
        offline = ease(offline, to: phase == .offline ? 1 : 0, dt, phase == .offline ? 320 : 240)
        broken = ease(broken, to: phase == .broken ? 1 : 0, dt, 200)
        slow = ease(slow, to: phase == .slow ? 1 : 0, dt, 200)
        cleared = ease(cleared, to: clearingShown ? 1 : 0, dt, 70)
        turn += dt / 1000 * Spec.spin * (1 - offline)
        setNeedsDisplay()

        if let liftedAt, exitProgress(liftedAt) >= 1 {
            link.isPaused = true
            let done = onLifted
            onLifted = nil
            done?()
            return
        }
        let grown = clock > Spec.growFrom + Spec.grow
        let settled =
            (phase == .offline && offline > 0.999 || phase == .broken && broken > 0.999) && grown
            && abs(cleared - (clearingShown ? 1 : 0)) < 0.001
        if settled && !lifting { link.isPaused = true }
        let idling = grown && !lifting
        if idling != self.idling {
            self.idling = idling
            link.preferredFrameRateRange = idling ? Self.idle : Self.fluid
        }
    }

    func reveals(_ point: CGPoint) -> Bool {
        guard let liftedAt else { return false }
        let hole = opening(grown: outCubic(span(liftedAt, Spec.growFrom, Spec.grow)), e: exitProgress(liftedAt)).hole
        return hypot(point.x - markCenter.x, point.y - markCenter.y) < hole
    }

    private var markCenter: CGPoint { CGPoint(x: bounds.midX + mark.offset.x, y: bounds.midY + mark.offset.y) }

    private func opening(grown: Double, e: Double) -> (hubWidth: CGFloat, hole: CGFloat) {
        let hubWidth = lerp(mark.width, Spec.hub, grown) * (1 + 0.6 * outCubic(e))
        let hole = lerp(
            mark.radius - mark.width / 2, hypot(bounds.width, bounds.height) / 2 + hubWidth,
            inOutCubic(clamp((e - 0.12) / 0.88)))
        return (hubWidth, hole)
    }

    private func exitProgress(_ liftedAt: Double) -> Double {
        clamp((clock - liftedAt) / (liftedAt < Spec.born ? Spec.quickExit : Spec.exit))
    }

    override func draw(_ rect: CGRect) {
        guard let ctx = UIGraphicsGetCurrentContext() else { return }
        let bg = Tone(background.resolvedColor(with: traitCollection))
        let origin = CGPoint(x: bounds.midX, y: bounds.midY)
        let tileRect = CGRect(x: origin.x - tileSize / 2, y: origin.y - tileSize / 2, width: tileSize, height: tileSize)
        if reduced {
            ctx.setFillColor(bg.cg)
            ctx.fill(bounds)
            return
        }
        if nodesFor != bounds.size {
            nodesFor = bounds.size
            nodes = Node.lattice(reach: hypot(bounds.width, bounds.height) / 2 / finalRadius + 1)
        }

        let lt = liftedAt ?? clock
        let e = liftedAt.map(exitProgress) ?? 0
        var m = inOutCubic(span(lt, Spec.hold, Spec.morph))
        if lifting { m = lerp(m, 1, outCubic(clamp(e / 0.4))) }
        let shape = outCubic(clamp(m / 0.55))
        let close = inOutCubic(clamp((m - 0.05) / 0.5))
        let tint = inOutCubic(clamp((m - 0.35) / 0.5))
        let grown = outCubic(span(lt, Spec.growFrom, Spec.grow))
        let unit = lerp(mark.radius, finalRadius, grown) * (1 + 0.9 * outCubic(e))
        let fade = 1 - outCubic(clamp(e / 0.8))
        let center = markCenter
        let (hubWidth, hole) = opening(grown: grown, e: e)

        if lifting {
            ctx.addRect(bounds)
            ctx.addEllipse(in: circle(center, hole))
            ctx.clip(using: .evenOdd)
        }
        ctx.setFillColor(bg.cg)
        ctx.fill(bounds)

        var rings: [Ring] = []
        rings.reserveCapacity(nodes.count + 1)
        let (cosr, sinr) = (cos(turn), sin(turn))
        let wave = (clock - slowSince) / 1000
        let grey = traitCollection.userInterfaceStyle == .dark ? Tone(92, 98, 104) : Tone(176, 180, 186)
        let ink = Tone.brand.mix(grey, offline)
        let spread = 1 + 0.5 * offline
        for node in nodes {
            let p = outCubic(span(lt, node.born, Spec.emerge)) * (1 - broken)
            guard p > 0 else { continue }
            let x = lerp(node.parent.x, node.at.x, p) * spread + node.drift.x * 0.5 * offline
            let y = lerp(node.parent.y, node.at.y, p) * spread + node.drift.y * 0.5 * offline
            var alpha = Spec.falloff[min(node.n, Spec.falloff.count - 1)] * p * fade
            if slow > 0 { alpha = clamp(alpha + 0.45 * slow * pow(max(0, cos(Double(node.n) * 0.9 - wave * 3.2)), 8) * p * fade) }
            rings.append(
                Ring(
                    center: CGPoint(x: center.x + (x * cosr - y * sinr) * unit, y: center.y + (x * sinr + y * cosr) * unit),
                    radius: unit * lerp(0.6, 1, p) * (1 - 0.15 * offline),
                    width: Spec.line,
                    tone: bg.mix(ink, alpha * (1 - 0.35 * offline))))
        }
        let hubGap = mark.gap * max(1 - close, broken)
        if tint >= 1 {
            rings.append(
                Ring(
                    center: center, radius: lifting ? max(unit, hole + hubWidth / 2) : unit, width: hubWidth,
                    tone: bg.mix(.brand, 1 - pow(e, 3)), hub: true, gap: hubGap))
        }
        weave(rings, bg: bg, in: ctx)

        if cleared > 0.001, !clearing.isNull, let gradient = clearingGradient(bg) {
            ctx.saveGState()
            ctx.setAlpha(cleared)
            ctx.translateBy(x: clearing.midX, y: clearing.midY)
            ctx.scaleBy(x: clearing.width / 200, y: clearing.height / 200)
            ctx.drawRadialGradient(gradient, startCenter: .zero, startRadius: 0, endCenter: .zero, endRadius: 100, options: [])
            ctx.restoreGState()
        }

        guard tint < 1 else { return }
        if shape <= 0, let tileImage {
            tileImage.draw(in: tileRect)
        } else {
            let size = lerp(tileSize, 2 * (mark.radius + mark.width / 2), shape)
            let at = CGPoint(x: lerp(origin.x, center.x, shape), y: lerp(origin.y, center.y, shape))
            let corner = min(lerp(Spec.tileCorner * scale, size / 2, shape), size / 2)
            ctx.addPath(CGPath(roundedRect: circle(at, size / 2), cornerWidth: corner, cornerHeight: corner, transform: nil))
            ctx.setFillColor(Tone.brand.cg)
            ctx.fillPath()
        }
        let inner = (mark.radius - mark.width / 2) * tint
        if inner > 0 {
            ctx.setFillColor(bg.cg)
            ctx.fillEllipse(in: circle(center, inner))
        }
        let arc = clamp(close / 0.25)
        if arc < 1 { glyphImage?.draw(in: tileRect, blendMode: .normal, alpha: 1 - arc) }
        if arc > 0 {
            ctx.setAlpha(arc)
            ctx.setLineCap(.round)
            ctx.setLineWidth(mark.width)
            ctx.setStrokeColor(Tone.white.mix(.brand, tint).cg)
            ctx.addArc(center: center, radius: mark.radius, startAngle: hubGap, endAngle: 2 * .pi - hubGap, clockwise: false)
            ctx.strokePath()
            ctx.setAlpha(1)
        }
    }

    // A ring passes over where the crossing lies clockwise of the line to its partner; the hub always over.
    private func weave(_ rings: [Ring], bg: Tone, in ctx: CGContext) {
        for ring in rings {
            ctx.setStrokeColor(ring.tone.cg)
            ctx.setLineWidth(ring.width)
            if ring.gap > 0.001 {
                ctx.setLineCap(.round)
                ctx.addArc(center: ring.center, radius: ring.radius, startAngle: ring.gap, endAngle: 2 * .pi - ring.gap, clockwise: false)
                ctx.strokePath()
            } else {
                ctx.strokeEllipse(in: circle(ring.center, ring.radius))
            }
        }
        ctx.setLineCap(.butt)
        for i in rings.indices {
            for j in rings.indices where j > i {
                let a = rings[i]
                let b = rings[j]
                let dx = b.center.x - a.center.x
                let dy = b.center.y - a.center.y
                let d = hypot(dx, dy)
                guard d < a.radius + b.radius, d > abs(a.radius - b.radius), d > 0.001 else { continue }
                let along = (a.radius * a.radius - b.radius * b.radius + d * d) / (2 * d)
                let h = sqrt(max(0, a.radius * a.radius - along * along))
                let mid = CGPoint(x: a.center.x + dx * along / d, y: a.center.y + dy * along / d)
                for s in [1.0, -1.0] {
                    let p = CGPoint(x: mid.x - s * dy * h / d, y: mid.y + s * dx * h / d)
                    let clockwise = dx * (p.y - a.center.y) - dy * (p.x - a.center.x) < 0
                    let (over, under) = a.hub || (!b.hub && clockwise) ? (a, b) : (b, a)
                    let phi = atan2(p.y - over.center.y, p.x - over.center.x)
                    if over.gap > 0.001, abs(phi) < over.gap { continue }
                    let half = (under.width / 2 + Spec.gap + 2) / over.radius * 1.4
                    ctx.setStrokeColor(bg.cg)
                    ctx.setLineWidth(over.width + 2 * Spec.gap)
                    ctx.addArc(center: over.center, radius: over.radius, startAngle: phi - half, endAngle: phi + half, clockwise: false)
                    ctx.strokePath()
                    ctx.setStrokeColor(over.tone.cg)
                    ctx.setLineWidth(over.width)
                    ctx.addArc(center: over.center, radius: over.radius, startAngle: phi - half * 1.05, endAngle: phi + half * 1.05, clockwise: false)
                    ctx.strokePath()
                }
            }
        }
    }

    private func clearingGradient(_ bg: Tone) -> CGGradient? {
        if let cached = gradientCache, cached.0 == bg { return cached.1 }
        let gradient = CGGradient(
            colorsSpace: CGColorSpace(name: CGColorSpace.sRGB),
            colors: [bg.cg, bg.cg, bg.cg(0)] as CFArray, locations: [0, 0.55, 1])
        gradientCache = gradient.map { (bg, $0) }
        return gradient
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        logo.center = CGPoint(x: bounds.midX, y: bounds.midY)
    }

    private func breathe() {
        let layer = logo.layer
        let still = !reduced || phase == .offline || phase == .broken || lifting
        guard !still else { return layer.removeAnimation(forKey: Self.breatheKey) }
        guard layer.animation(forKey: Self.breatheKey) == nil else { return }
        let breath = CABasicAnimation(keyPath: "opacity")
        breath.fromValue = 1
        breath.toValue = 0.55
        breath.duration = 0.8
        breath.autoreverses = true
        breath.repeatCount = .infinity
        breath.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        breath.beginTime = layer.convertTime(CACurrentMediaTime(), from: nil) + Spec.hold / 1000
        layer.add(breath, forKey: Self.breatheKey)
    }

    private static let breatheKey = "breathe"
    private static let fluid = CAFrameRateRange(minimum: 30, maximum: 60, preferred: 60)
    private static let idle = CAFrameRateRange(minimum: 20, maximum: 30, preferred: 30)

    private var tileSize: CGFloat { tileImage?.size.width ?? 88 }
    private var scale: CGFloat { tileSize / 192 }
    /// The C measured on its 192 grid: ring centre (106, 103.6), radius 30, stroke 12, open ±28° to the right.
    private var mark: (offset: CGPoint, radius: CGFloat, width: CGFloat, gap: CGFloat) {
        (CGPoint(x: 10 * scale, y: 7.6 * scale), 30 * scale, 12 * scale, 28 * .pi / 180)
    }

    private var finalRadius: CGFloat {
        max(Spec.radius, hypot(bounds.width, bounds.height) / 2 / (Spec.spacing * 5.2))
    }

    private func circle(_ center: CGPoint, _ radius: CGFloat) -> CGRect {
        CGRect(x: center.x - radius, y: center.y - radius, width: 2 * radius, height: 2 * radius)
    }
}

private enum Spec {
    static let hold = 300.0, morph = 450.0
    static let born = 700.0, layer = 380.0, stagger = 110.0, emerge = 700.0
    static let growFrom = 650.0, grow = 2700.0
    static let exit = 420.0, quickExit = 300.0
    static let spin = 0.05
    static let spacing = 1.6
    static let layers = 6
    static let falloff: [Double] = [1, 0.9, 0.66, 0.46, 0.32, 0.22, 0.16]
    static let radius = 60.0, hub = 9.0, line = 2.5, gap = 3.0
    static let tileCorner = 32.0
}

private struct Node {
    let n: Int
    let at: CGPoint
    let parent: CGPoint
    let born: Double
    let drift: CGPoint

    static func lattice(reach: CGFloat) -> [Node] {
        var nodes: [Node] = []
        let range = -Spec.layers...Spec.layers
        for q in range {
            for r in range {
                let n = (abs(q) + abs(r) + abs(q + r)) / 2
                let at = point(Double(q), Double(r))
                guard n > 0, n <= Spec.layers, hypot(at.x, at.y) <= reach else { continue }
                let back = Double(n - 1) / Double(n)
                let (pq, pr) = nearest(Double(q) * back, Double(r) * back)
                let around = (atan2(at.y, at.x) + .pi) / (2 * .pi)
                nodes.append(
                    Node(
                        n: n, at: at, parent: point(pq, pr),
                        born: Spec.born + Spec.layer * pow(Double(n - 1), 1.1) + Spec.stagger * around,
                        drift: CGPoint(x: noise(q, r, 12.9898, 78.233), y: noise(q, r, 39.346, 11.135))))
            }
        }
        return nodes.sorted { $0.n > $1.n }
    }

    private static func point(_ q: Double, _ r: Double) -> CGPoint {
        CGPoint(x: Spec.spacing * (q + r / 2), y: Spec.spacing * sqrt(3) / 2 * r)
    }

    private static func nearest(_ x: Double, _ z: Double) -> (Double, Double) {
        let y = -x - z
        var rx = (x + 0.5).rounded(.down)
        var rz = (z + 0.5).rounded(.down)
        let ry = (y + 0.5).rounded(.down)
        let dx = abs(rx - x)
        let dy = abs(ry - y)
        let dz = abs(rz - z)
        if dx > dy, dx > dz { rx = -ry - rz } else if dz >= dy { rz = -rx - ry }
        return (rx, rz)
    }

    private static func noise(_ q: Int, _ r: Int, _ a: Double, _ b: Double) -> CGFloat {
        let v = sin(Double(q) * a + Double(r) * b) * 43758.5453
        return v - v.rounded(.down) - 0.5
    }
}

private struct Ring {
    var center: CGPoint
    var radius: CGFloat
    var width: CGFloat
    var tone: Tone
    var hub = false
    var gap: CGFloat = 0
}

private struct Tone: Equatable {
    var r, g, b: Double

    static let brand = Tone(255, 69, 0)
    static let white = Tone(255, 255, 255)

    init(_ r: Double, _ g: Double, _ b: Double) {
        (self.r, self.g, self.b) = (r / 255, g / 255, b / 255)
    }

    init(_ color: UIColor) {
        var (r, g, b, a): (CGFloat, CGFloat, CGFloat, CGFloat) = (0, 0, 0, 0)
        color.getRed(&r, green: &g, blue: &b, alpha: &a)
        (self.r, self.g, self.b) = (Double(r), Double(g), Double(b))
    }

    func mix(_ other: Tone, _ t: Double) -> Tone {
        var tone = self
        tone.r = lerp(r, other.r, t)
        tone.g = lerp(g, other.g, t)
        tone.b = lerp(b, other.b, t)
        return tone
    }

    var cg: CGColor { cg(1) }

    func cg(_ alpha: Double) -> CGColor { CGColor(srgbRed: r, green: g, blue: b, alpha: alpha) }
}

private func lerp(_ a: Double, _ b: Double, _ t: Double) -> Double { a + (b - a) * t }
private func clamp(_ v: Double) -> Double { min(1, max(0, v)) }
private func span(_ t: Double, _ from: Double, _ length: Double) -> Double { clamp((t - from) / length) }
private func outCubic(_ x: Double) -> Double { 1 - pow(1 - x, 3) }
private func inOutCubic(_ x: Double) -> Double { x < 0.5 ? 4 * x * x * x : 1 - pow(-2 * x + 2, 3) / 2 }
private func ease(_ value: Double, to target: Double, _ dt: Double, _ tau: Double) -> Double {
    value + (target - value) * (1 - exp(-dt / tau))
}
