package live.cohub.android.ui

import android.content.Context
import android.content.res.Configuration
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RadialGradient
import android.graphics.RectF
import android.graphics.Shader
import android.graphics.drawable.AdaptiveIconDrawable
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.Drawable
import android.graphics.drawable.ShapeDrawable
import android.graphics.drawable.shapes.OvalShape
import android.os.Build
import android.provider.Settings
import android.view.Choreographer
import android.view.View
import live.cohub.android.R
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.math.sqrt

/** The launch mark growing into a woven context network; mirrors iOS's `LaunchNet`. */
class LaunchNet(context: Context) : View(context) {

    enum class Phase { LOADING, SLOW, OFFLINE, BROKEN }

    var phase = Phase.LOADING
        set(value) {
            if (field == value) return
            field = value
            if (value == Phase.SLOW) slowSince = clock
            wake()
        }

    var lifting = false
        private set

    private val density = resources.displayMetrics.density
    private val brand = context.getColor(R.color.ic_launcher_background)
    private val glyph = requireNotNull(context.getDrawable(R.drawable.ic_launcher_foreground)).mutate()

    // From Android 12 the splash masks its tile like a launcher icon; before, with a circle.
    private val tile: Drawable = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        AdaptiveIconDrawable(ColorDrawable(brand), null)
    } else {
        ShapeDrawable(OvalShape()).apply { paint.color = brand }
    }

    private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
    private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
    private val clearingPaint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val hole = Path()

    private var anchorX = Float.NaN
    private var anchorY = Float.NaN
    private var tileSize = 160 * density

    private var reduced = false
    private var timeScale = 1f
    private var running = false
    private var lastFrame = 0L
    private var clock = 0.0
    private var turn = 0.0
    private var liftedAt: Double? = null
    private var onLifted: (() -> Unit)? = null
    private var offline = 0.0
    private var broken = 0.0
    private var slow = 0.0
    private var slowSince = 0.0
    private val clearing = RectF()
    private var clearingShown = false
    private var cleared = 0.0
    private var nodes: List<Node> = emptyList()
    private var nodesFor = 0L
    private val rings = ArrayList<Ring>()

    private val frame = Choreographer.FrameCallback { step(it) }
    private var clearingShader: Pair<Int, Shader>? = null

    init {
        restart()
    }

    val originX get() = if (anchorX.isNaN()) width / 2f else anchorX
    val originY get() = if (anchorY.isNaN()) height / 2f else anchorY

    val clearance get() = if (reduced) tileSize / 2.0 else max(tileSize / 2.0, finalRadius() + HUB * density / 2)

    fun anchor(x: Float, y: Float, size: Float) {
        anchorX = x
        anchorY = y
        tileSize = size
        if (lifting) invalidate() else restart()
    }

    fun clear(rect: RectF?) {
        if (rect != null) {
            clearing.set(rect)
            clearing.inset(-40 * density, -32 * density)
        }
        clearingShown = rect != null
        wake()
    }

    fun lift(done: () -> Unit) {
        if (lifting) return
        lifting = true
        if (reduced || !isAttachedToWindow || !isShown) return done()
        liftedAt = clock
        onLifted = done
        wake()
    }

    fun hold() {
        lifting = false
        liftedAt = null
        onLifted = null
        wake()
    }

    fun restart() {
        timeScale = Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f)
        reduced = timeScale == 0f
        clock = 0.0
        turn = 0.0
        lastFrame = 0L
        lifting = false
        liftedAt = null
        onLifted = null
        offline = 0.0
        broken = 0.0
        slow = 0.0
        wake()
    }

    override fun onVisibilityAggregated(isVisible: Boolean) {
        super.onVisibilityAggregated(isVisible)
        if (isVisible) wake() else sleep()
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        if (oldw != 0) {
            anchorX = Float.NaN
            anchorY = Float.NaN
        }
    }

    override fun onDetachedFromWindow() {
        sleep()
        super.onDetachedFromWindow()
    }

    private fun wake() {
        invalidate()
        if (running || reduced || !isAttachedToWindow || !isShown) return
        running = true
        lastFrame = 0L
        Choreographer.getInstance().postFrameCallback(frame)
    }

    private fun sleep() {
        running = false
        Choreographer.getInstance().removeFrameCallback(frame)
    }

    private fun step(nanos: Long) {
        if (!running) return
        if (clock > GROW_FROM + GROW && !lifting && lastFrame != 0L && nanos - lastFrame < IDLE_FRAME_NANOS) {
            Choreographer.getInstance().postFrameCallback(frame)
            return
        }
        val dt = if (lastFrame == 0L) 0.0 else min(50.0, (nanos - lastFrame) / 1e6) / max(timeScale, 0.01f)
        lastFrame = nanos
        clock += dt
        offline = ease(offline, if (phase == Phase.OFFLINE) 1.0 else 0.0, dt, if (phase == Phase.OFFLINE) 320.0 else 240.0)
        broken = ease(broken, if (phase == Phase.BROKEN) 1.0 else 0.0, dt, 200.0)
        slow = ease(slow, if (phase == Phase.SLOW) 1.0 else 0.0, dt, 200.0)
        cleared = ease(cleared, if (clearingShown) 1.0 else 0.0, dt, 70.0)
        turn += dt / 1000 * SPIN * (1 - offline)
        invalidate()

        val lifted = liftedAt
        if (lifted != null && exitProgress(lifted) >= 1) {
            running = false
            val done = onLifted
            onLifted = null
            done?.invoke()
            return
        }
        val settled = (phase == Phase.OFFLINE && offline > 0.999 || phase == Phase.BROKEN && broken > 0.999) &&
            clock > GROW_FROM + GROW && abs(cleared - if (clearingShown) 1.0 else 0.0) < 0.001
        if (settled && !lifting) {
            running = false
            return
        }
        Choreographer.getInstance().postFrameCallback(frame)
    }

    fun reveals(x: Float, y: Float): Boolean {
        val lifted = liftedAt ?: return false
        return hypot(x - markX, y - markY) < opening(outCubic(span(lifted, GROW_FROM, GROW)), exitProgress(lifted)).second
    }

    // The launcher glyph's 108-unit canvas is 1.5× the tile, so a glyph unit is tileSize / 72.
    private val markRadius get() = 14.06f * tileSize / 72
    private val markWidth get() = 9.28f * tileSize / 72
    private val markX get() = originX + 0.068f * tileSize
    private val markY get() = originY + 0.0523f * tileSize

    private fun opening(grown: Double, e: Double): Pair<Double, Double> {
        val hubWidth = lerp(markWidth.toDouble(), HUB * density, grown) * (1 + 0.6 * outCubic(e))
        val hole = lerp((markRadius - markWidth / 2).toDouble(), hypot(width.toDouble(), height.toDouble()) / 2 + hubWidth,
            inOutCubic(clamp((e - 0.12) / 0.88)))
        return hubWidth to hole
    }

    private fun exitProgress(from: Double) = clamp((clock - from) / if (from < BORN) QUICK_EXIT else EXIT)

    override fun onDraw(canvas: Canvas) {
        val bg = context.getColor(R.color.shell_background)
        val centerX = markX
        val centerY = markY
        val tileLeft = (originX - tileSize / 2).roundToInt()
        val tileTop = (originY - tileSize / 2).roundToInt()
        val tileRight = tileLeft + tileSize.roundToInt()
        val tileBottom = tileTop + tileSize.roundToInt()
        val pad = (tileSize / 4).roundToInt()
        glyph.setBounds(tileLeft - pad, tileTop - pad, tileRight + pad, tileBottom + pad)

        if (reduced) {
            canvas.drawColor(bg)
            tile.setBounds(tileLeft, tileTop, tileRight, tileBottom)
            tile.alpha = 255
            tile.draw(canvas)
            glyph.alpha = 255
            glyph.draw(canvas)
            return
        }
        val key = width.toLong() shl 32 or height.toLong()
        if (nodesFor != key) {
            nodesFor = key
            nodes = Node.lattice(hypot(width.toDouble(), height.toDouble()) / 2 / finalRadius() + 1)
        }

        val lt = liftedAt ?: clock
        val e = liftedAt?.let(::exitProgress) ?: 0.0
        var m = inOutCubic(span(lt, HOLD, MORPH))
        if (lifting) m = lerp(m, 1.0, outCubic(clamp(e / 0.4)))
        val shape = outCubic(clamp(m / 0.55))
        val close = inOutCubic(clamp((m - 0.05) / 0.5))
        val tint = inOutCubic(clamp((m - 0.35) / 0.5))
        val grown = outCubic(span(lt, GROW_FROM, GROW))
        val unit = lerp(markRadius.toDouble(), finalRadius(), grown) * (1 + 0.9 * outCubic(e))
        val fade = 1 - outCubic(clamp(e / 0.8))
        val (hubWidth, holeRadius) = opening(grown, e)

        canvas.save()
        if (lifting) {
            hole.rewind()
            hole.addCircle(centerX, centerY, holeRadius.toFloat(), Path.Direction.CW)
            canvas.clipOutPath(hole)
        }
        canvas.drawColor(bg)

        rings.clear()
        val cosr = cos(turn)
        val sinr = sin(turn)
        val wave = (clock - slowSince) / 1000
        val night = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
        val ink = blend(brand, if (night) GREY_DARK else GREY_LIGHT, offline)
        val spread = 1 + 0.5 * offline
        for (node in nodes) {
            val p = outCubic(span(lt, node.born, EMERGE)) * (1 - broken)
            if (p <= 0) continue
            val x = lerp(node.parentX, node.x, p) * spread + node.driftX * 0.5 * offline
            val y = lerp(node.parentY, node.y, p) * spread + node.driftY * 0.5 * offline
            var alpha = FALLOFF[min(node.n, FALLOFF.size - 1)] * p * fade
            if (slow > 0) alpha = clamp(alpha + 0.45 * slow * max(0.0, cos(node.n * 0.9 - wave * 3.2)).pow(8) * p * fade)
            rings += Ring(
                x = centerX + (x * cosr - y * sinr) * unit,
                y = centerY + (x * sinr + y * cosr) * unit,
                radius = unit * lerp(0.6, 1.0, p) * (1 - 0.15 * offline),
                width = LINE * density,
                color = blend(bg, ink, alpha * (1 - 0.35 * offline)),
            )
        }
        val hubGap = GAP_DEGREES * max(1 - close, broken)
        if (tint >= 1) {
            rings += Ring(
                x = centerX.toDouble(), y = centerY.toDouble(),
                radius = if (lifting) max(unit, holeRadius + hubWidth / 2) else unit,
                width = hubWidth, color = blend(bg, brand, 1 - e.pow(3)), hub = true, gap = hubGap,
            )
        }
        weave(canvas, bg)

        if (cleared > 0.001 && !clearing.isEmpty) {
            val shader = clearingShader?.takeIf { it.first == bg }?.second
                ?: RadialGradient(0f, 0f, 100f, intArrayOf(bg, bg, withAlpha(bg, 0)), floatArrayOf(0f, 0.55f, 1f), Shader.TileMode.CLAMP)
                    .also { clearingShader = bg to it }
            clearingPaint.shader = shader
            clearingPaint.alpha = (cleared * 255).roundToInt()
            canvas.save()
            canvas.translate(clearing.centerX(), clearing.centerY())
            canvas.scale(clearing.width() / 200, clearing.height() / 200)
            canvas.drawCircle(0f, 0f, 100f, clearingPaint)
            canvas.restore()
        }

        if (tint < 1) {
            val size = lerp(tileSize.toDouble(), 2.0 * (markRadius + markWidth / 2), shape).toFloat()
            val atX = lerp(originX.toDouble(), centerX.toDouble(), shape).toFloat()
            val atY = lerp(originY.toDouble(), centerY.toDouble(), shape).toFloat()
            if (shape > 0) {
                fill.color = brand
                canvas.drawCircle(atX, atY, size / 2, fill)
            }
            if (shape < 1) {
                canvas.save()
                canvas.translate(atX - originX, atY - originY)
                canvas.scale(size / tileSize, size / tileSize, originX, originY)
                tile.setBounds(tileLeft, tileTop, tileRight, tileBottom)
                tile.alpha = ((1 - shape) * 255).roundToInt()
                tile.draw(canvas)
                canvas.restore()
            }
            val inner = (markRadius - markWidth / 2) * tint
            if (inner > 0) {
                fill.color = bg
                canvas.drawCircle(centerX, centerY, inner.toFloat(), fill)
            }
            val arc = clamp(close / 0.25)
            if (arc < 1) {
                glyph.alpha = ((1 - arc) * 255).roundToInt()
                glyph.draw(canvas)
            }
            if (arc > 0) {
                stroke.strokeCap = Paint.Cap.ROUND
                stroke.strokeWidth = markWidth
                stroke.color = withAlpha(blend(Color.WHITE, brand, tint), (arc * 255).roundToInt())
                canvas.drawArc(centerX - markRadius, centerY - markRadius, centerX + markRadius, centerY + markRadius,
                    hubGap.toFloat(), (360 - 2 * hubGap).toFloat(), false, stroke)
                stroke.strokeCap = Paint.Cap.BUTT
            }
        }
        canvas.restore()
    }

    // A ring passes over where the crossing lies clockwise of the line to its partner; the hub always over.
    private fun weave(canvas: Canvas, bg: Int) {
        for (ring in rings) {
            stroke.color = ring.color
            stroke.strokeWidth = ring.width.toFloat()
            if (ring.gap > 0.001) {
                stroke.strokeCap = Paint.Cap.ROUND
                arc(canvas, ring, ring.gap, 360 - 2 * ring.gap)
                stroke.strokeCap = Paint.Cap.BUTT
            } else {
                canvas.drawCircle(ring.x.toFloat(), ring.y.toFloat(), ring.radius.toFloat(), stroke)
            }
        }
        val gap = GAP * density
        for (i in rings.indices) for (j in i + 1 until rings.size) {
            val a = rings[i]
            val b = rings[j]
            val dx = b.x - a.x
            val dy = b.y - a.y
            val d = hypot(dx, dy)
            if (d >= a.radius + b.radius || d <= abs(a.radius - b.radius) || d < 0.001) continue
            val along = (a.radius * a.radius - b.radius * b.radius + d * d) / (2 * d)
            val h = sqrt(max(0.0, a.radius * a.radius - along * along))
            val midX = a.x + dx * along / d
            val midY = a.y + dy * along / d
            for (s in SIDES) {
                val px = midX - s * dy * h / d
                val py = midY + s * dx * h / d
                val clockwise = dx * (py - a.y) - dy * (px - a.x) < 0
                val over = if (a.hub || (!b.hub && clockwise)) a else b
                val under = if (over === a) b else a
                val phi = Math.toDegrees(atan2(py - over.y, px - over.x))
                if (over.gap > 0.001 && abs(phi) < over.gap) continue
                val half = Math.toDegrees((under.width / 2 + gap + 2 * density) / over.radius * 1.4)
                stroke.color = bg
                stroke.strokeWidth = (over.width + 2 * gap).toFloat()
                arc(canvas, over, phi - half, 2 * half)
                stroke.color = over.color
                stroke.strokeWidth = over.width.toFloat()
                arc(canvas, over, phi - half * 1.05, 2 * half * 1.05)
            }
        }
    }

    private fun arc(canvas: Canvas, ring: Ring, start: Double, sweep: Double) {
        val r = ring.radius.toFloat()
        val x = ring.x.toFloat()
        val y = ring.y.toFloat()
        canvas.drawArc(x - r, y - r, x + r, y + r, start.toFloat(), sweep.toFloat(), false, stroke)
    }

    private fun finalRadius() = max(RADIUS * density.toDouble(), hypot(width.toDouble(), height.toDouble()) / 2 / (SPACING * 5.2))

    private class Ring(
        val x: Double,
        val y: Double,
        val radius: Double,
        val width: Double,
        val color: Int,
        val hub: Boolean = false,
        val gap: Double = 0.0,
    )

    private class Node(
        val n: Int,
        val x: Double,
        val y: Double,
        val parentX: Double,
        val parentY: Double,
        val born: Double,
        val driftX: Double,
        val driftY: Double,
    ) {
        companion object {
            fun lattice(reach: Double): List<Node> {
                val nodes = ArrayList<Node>()
                for (q in -LAYERS..LAYERS) for (r in -LAYERS..LAYERS) {
                    val n = (abs(q) + abs(r) + abs(q + r)) / 2
                    val x = SPACING * (q + r / 2.0)
                    val y = SPACING * sqrt(3.0) / 2 * r
                    if (n == 0 || n > LAYERS || hypot(x, y) > reach) continue
                    val back = (n - 1).toDouble() / n
                    val (pq, pr) = nearest(q * back, r * back)
                    val around = (atan2(y, x) + Math.PI) / (2 * Math.PI)
                    nodes += Node(
                        n, x, y, SPACING * (pq + pr / 2), SPACING * sqrt(3.0) / 2 * pr,
                        born = BORN + LAYER * (n - 1.0).pow(1.1) + STAGGER * around,
                        driftX = noise(q, r, 12.9898, 78.233),
                        driftY = noise(q, r, 39.346, 11.135),
                    )
                }
                return nodes.sortedByDescending { it.n }
            }

            private fun nearest(x: Double, z: Double): Pair<Double, Double> {
                val y = -x - z
                var rx = floor(x + 0.5)
                val ry = floor(y + 0.5)
                var rz = floor(z + 0.5)
                val dx = abs(rx - x)
                val dy = abs(ry - y)
                val dz = abs(rz - z)
                if (dx > dy && dx > dz) rx = -ry - rz else if (dz >= dy) rz = -rx - ry
                return rx to rz
            }

            private fun noise(q: Int, r: Int, a: Double, b: Double): Double {
                val v = sin(q * a + r * b) * 43758.5453
                return v - floor(v) - 0.5
            }
        }
    }

    private companion object {
        const val HOLD = 300.0
        const val MORPH = 450.0
        const val BORN = 700.0
        const val LAYER = 380.0
        const val STAGGER = 110.0
        const val EMERGE = 700.0
        const val GROW_FROM = 650.0
        const val GROW = 2700.0
        const val EXIT = 420.0
        const val QUICK_EXIT = 300.0
        const val SPIN = 0.05
        const val IDLE_FRAME_NANOS = 30_000_000L

        const val SPACING = 1.6
        const val LAYERS = 6
        val FALLOFF = doubleArrayOf(1.0, 0.9, 0.66, 0.46, 0.32, 0.22, 0.16)
        const val RADIUS = 60.0
        const val HUB = 9.0
        const val LINE = 2.5
        const val GAP = 3.0

        const val GAP_DEGREES = 21.0
        val SIDES = doubleArrayOf(1.0, -1.0)
        val GREY_LIGHT = Color.rgb(176, 180, 186)
        val GREY_DARK = Color.rgb(92, 98, 104)

        fun clamp(v: Double) = v.coerceIn(0.0, 1.0)
        fun span(t: Double, from: Double, length: Double) = clamp((t - from) / length)
        fun lerp(a: Double, b: Double, t: Double) = a + (b - a) * t
        fun outCubic(x: Double) = 1 - (1 - x).pow(3)
        fun inOutCubic(x: Double) = if (x < 0.5) 4 * x * x * x else 1 - (-2 * x + 2).pow(3) / 2
        fun ease(value: Double, target: Double, dt: Double, tau: Double) = value + (target - value) * (1 - exp(-dt / tau))
        fun withAlpha(color: Int, alpha: Int) = color and 0x00FFFFFF or (alpha shl 24)

        fun blend(from: Int, to: Int, t: Double): Int {
            fun channel(shift: Int) = lerp((from shr shift and 0xFF).toDouble(), (to shr shift and 0xFF).toDouble(), t).roundToInt()
            return Color.rgb(channel(16), channel(8), channel(0))
        }
    }
}
