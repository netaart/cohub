const { withMainActivity } = require("@expo/config-plugins");

const MARKER = "// @generated begin cohub-predictive-back";

const predictiveBackImports = `import android.view.View
import android.view.ViewGroup
import android.view.animation.DecelerateInterpolator
import android.window.BackEvent
import android.window.OnBackAnimationCallback
import android.window.OnBackInvokedDispatcher

import com.swmansion.rnscreens.Screen
import com.swmansion.rnscreens.ScreenStack
`;

const predictiveBackCode = `
  private var predictiveBackTarget: View? = null
  private var predictiveBackDirection = 1f
  private var predictiveBackCallback: OnBackAnimationCallback? = null
  private var predictiveBackStack: ScreenStack? = null
  private var predictiveBackTop: Screen? = null
  private var predictiveBackPreviousAttached = false
  private var predictiveBackActive = false

  private fun findPredictiveBackStack(view: View): ScreenStack? {
    if (view is ScreenStack) return view
    if (view is ViewGroup) {
      for (index in view.childCount - 1 downTo 0) {
        findPredictiveBackStack(view.getChildAt(index))?.let { return it }
      }
    }
    return null
  }

  private fun resetPredictiveBackTransforms(stack: ScreenStack) {
    for (index in 0 until stack.childCount) {
      val child = stack.getChildAt(index)
      child.translationX = 0f
      child.scaleX = 1f
      child.scaleY = 1f
    }
  }

  private fun findPredictiveBackTarget(stack: ScreenStack): View? {
    val target = stack.topScreen?.fragment?.view ?: return null
    return target.takeIf { it.visibility == View.VISIBLE && it.width > 0 && it.height > 0 }
  }

  private fun registerPredictiveBack() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) return

    predictiveBackCallback = object : OnBackAnimationCallback {
      override fun onBackStarted(backEvent: BackEvent) {
        predictiveBackActive = false
        val stack = findPredictiveBackStack(window.decorView)
        if (stack == null || stack.fragments.size < 2 || stack.topScreen == null) {
          predictiveBackTarget = null
          predictiveBackStack = null
          predictiveBackTop = null
          predictiveBackPreviousAttached = false
          return
        }

        resetPredictiveBackTransforms(stack)
        val enteringTarget = findPredictiveBackTarget(stack)
        if (enteringTarget == null || enteringTarget.animation != null || !enteringTarget.isLaidOut) {
          predictiveBackTarget = null
          predictiveBackStack = null
          predictiveBackTop = null
          predictiveBackPreviousAttached = false
          return
        }

        val top = stack.topScreen
        stack.attachBelowTop()
        predictiveBackStack = stack
        predictiveBackTop = top
        predictiveBackPreviousAttached = true
        predictiveBackTarget = findPredictiveBackTarget(stack)
        predictiveBackActive = predictiveBackTarget != null
        predictiveBackDirection = if (backEvent.swipeEdge == BackEvent.EDGE_RIGHT) -1f else 1f
        predictiveBackTarget?.let { target ->
          target.pivotX = if (predictiveBackDirection > 0f) 0f else target.width.toFloat()
          target.pivotY = target.height / 2f
          target.translationX = 0f
          target.scaleX = 1f
          target.scaleY = 1f
        }
      }

      override fun onBackProgressed(backEvent: BackEvent) {
        val target = predictiveBackTarget ?: return
        val progress = backEvent.progress.coerceIn(0f, 1f)
        target.translationX = predictiveBackDirection * target.width * progress
        val scale = 1f - (0.05f * progress)
        target.scaleX = scale
        target.scaleY = scale
      }

      override fun onBackCancelled() {
        val target = predictiveBackTarget
        val stack = predictiveBackStack
        val restorePreview = {
          if (predictiveBackPreviousAttached) {
            stack?.detachBelowTop()
            predictiveBackPreviousAttached = false
          }
          predictiveBackTarget = null
          predictiveBackStack = null
          predictiveBackTop = null
          predictiveBackActive = false
        }
        if (!predictiveBackActive || target == null) {
          restorePreview()
          return
        }
        target.animate()
          .translationX(0f)
          .scaleX(1f)
          .scaleY(1f)
          .setDuration(180L)
          .setInterpolator(DecelerateInterpolator())
          .withEndAction { restorePreview() }
          .start()
      }

      override fun onBackInvoked() {
        val target = predictiveBackTarget
        val stack = predictiveBackStack
        val top = predictiveBackTop
        val active = predictiveBackActive
        predictiveBackTarget = null
        predictiveBackActive = false
        if (!active) {
          onBackPressedDispatcher.onBackPressed()
          predictiveBackStack = null
          predictiveBackTop = null
          predictiveBackPreviousAttached = false
          return
        }
        onBackPressedDispatcher.onBackPressed()
        target?.postDelayed({
          if (stack != null && stack.topScreen === top) {
            if (predictiveBackPreviousAttached) {
              stack.detachBelowTop()
              predictiveBackPreviousAttached = false
            }
            target.translationX = 0f
            target.scaleX = 1f
            target.scaleY = 1f
          } else {
            predictiveBackPreviousAttached = false
          }
          predictiveBackStack = null
          predictiveBackTop = null
          predictiveBackActive = false
        }, 300L)
      }
    }

    onBackInvokedDispatcher.registerOnBackInvokedCallback(
      OnBackInvokedDispatcher.PRIORITY_OVERLAY,
      predictiveBackCallback!!
    )
  }

  private fun unregisterPredictiveBack() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) return
    predictiveBackCallback?.let { callback ->
      onBackInvokedDispatcher.unregisterOnBackInvokedCallback(callback)
    }
    predictiveBackCallback = null
  }
`;

function withPredictiveBack(config) {
  return withMainActivity(config, (config) => {
    if (config.modResults.language !== "kt") {
      throw new Error("Cohub predictive back requires the Kotlin MainActivity generated by Expo.");
    }

    let contents = config.modResults.contents;
    if (contents.includes(MARKER)) return config;

    contents = contents.replace(
      "import android.os.Bundle\n",
      `import android.os.Bundle\n${predictiveBackImports}`,
    );
    contents = contents.replace(
      "    super.onCreate(null)\n",
      "    super.onCreate(null)\n    registerPredictiveBack()\n",
    );
    contents = contents.replace(
      "  override fun invokeDefaultOnBackPressed() {\n",
      `${MARKER}\n${predictiveBackCode}\n  override fun onDestroy() {\n    unregisterPredictiveBack()\n    super.onDestroy()\n  }\n\n  override fun invokeDefaultOnBackPressed() {\n`,
    );
    config.modResults.contents = `${contents}\n// @generated end cohub-predictive-back\n`;
    return config;
  });
}

module.exports = withPredictiveBack;
