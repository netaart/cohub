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
  private var predictiveBackGeneration = 0
  private val predictiveBackAttachProgress = 0.12f

  private fun findPredictiveBackStack(view: View): ScreenStack? {
    var nested: ScreenStack? = null
    if (view is ScreenStack && view.fragments.size >= 2 && view.topScreen != null) {
      nested = view
    }
    if (view is ViewGroup) {
      for (index in view.childCount - 1 downTo 0) {
        findPredictiveBackStack(view.getChildAt(index))?.let { return it }
      }
    }
    return nested
  }

  private fun resetPredictiveBackTransforms(stack: ScreenStack) {
    for (index in 0 until stack.childCount) {
      val child = stack.getChildAt(index)
      child.animate().cancel()
      child.translationX = 0f
      child.scaleX = 1f
      child.scaleY = 1f
      child.setLayerType(View.LAYER_TYPE_NONE, null)
    }
  }

  private fun findPredictiveBackTarget(stack: ScreenStack): View? {
    val target = stack.topScreen?.fragment?.view ?: return null
    return target.takeIf { it.visibility == View.VISIBLE && it.width > 0 && it.height > 0 }
  }

  private fun clearPredictiveBackPreview() {
    val stack = predictiveBackStack
    val attached = predictiveBackPreviousAttached
    predictiveBackTarget?.animate()?.cancel()
    predictiveBackTarget = null
    predictiveBackStack = null
    predictiveBackTop = null
    predictiveBackPreviousAttached = false
    predictiveBackActive = false
    if (stack != null) {
      resetPredictiveBackTransforms(stack)
      if (attached && stack.fragments.size >= 2) {
        stack.detachBelowTop()
      }
    }
  }

  private fun registerPredictiveBack() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) return

    predictiveBackCallback = object : OnBackAnimationCallback {
      override fun onBackStarted(backEvent: BackEvent) {
        predictiveBackGeneration += 1
        clearPredictiveBackPreview()
        val stack = findPredictiveBackStack(window.decorView)
        val target = stack?.let { findPredictiveBackTarget(it) }
        if (stack == null || target == null || target.animation != null || !target.isLaidOut) {
          return
        }

        predictiveBackStack = stack
        predictiveBackTop = stack.topScreen
        predictiveBackTarget = target
        predictiveBackActive = true
        predictiveBackDirection = if (backEvent.swipeEdge == BackEvent.EDGE_RIGHT) -1f else 1f
        target.setLayerType(View.LAYER_TYPE_HARDWARE, null)
        target.pivotX = if (predictiveBackDirection > 0f) 0f else target.width.toFloat()
        target.pivotY = target.height / 2f
        target.translationX = 0f
        target.scaleX = 1f
        target.scaleY = 1f
      }

      override fun onBackProgressed(backEvent: BackEvent) {
        val stack = predictiveBackStack ?: return
        if (!predictiveBackActive) return
        val progress = backEvent.progress.coerceIn(0f, 1f)
        if (!predictiveBackPreviousAttached && progress >= predictiveBackAttachProgress && stack.fragments.size >= 2) {
          stack.attachBelowTop()
          predictiveBackPreviousAttached = true
          predictiveBackTarget = findPredictiveBackTarget(stack) ?: predictiveBackTarget
          predictiveBackTarget?.setLayerType(View.LAYER_TYPE_HARDWARE, null)
        }
        val target = predictiveBackTarget ?: return
        target.pivotX = if (predictiveBackDirection > 0f) 0f else target.width.toFloat()
        target.pivotY = target.height / 2f
        target.translationX = predictiveBackDirection * target.width * progress
        val scale = 1f - (0.05f * progress)
        target.scaleX = scale
        target.scaleY = scale
      }

      override fun onBackCancelled() {
        val target = predictiveBackTarget
        val stack = predictiveBackStack
        val attached = predictiveBackPreviousAttached
        val generation = predictiveBackGeneration
        if (!predictiveBackActive || target == null) {
          clearPredictiveBackPreview()
          return
        }
        target.animate().cancel()
        target.animate()
          .translationX(0f)
          .scaleX(1f)
          .scaleY(1f)
          .setDuration(160L)
          .setInterpolator(DecelerateInterpolator())
          .withEndAction {
            if (generation != predictiveBackGeneration) return@withEndAction
            predictiveBackTarget = null
            predictiveBackStack = null
            predictiveBackTop = null
            predictiveBackPreviousAttached = false
            predictiveBackActive = false
            resetPredictiveBackTransforms(stack ?: return@withEndAction)
            if (attached && stack.fragments.size >= 2) {
              stack.detachBelowTop()
            }
          }
          .start()
      }

      override fun onBackInvoked() {
        val stack = predictiveBackStack
        predictiveBackTarget?.animate()?.cancel()
        if (stack != null) resetPredictiveBackTransforms(stack)
        predictiveBackTarget = null
        predictiveBackStack = null
        predictiveBackTop = null
        predictiveBackPreviousAttached = false
        predictiveBackActive = false
        // A committed pop rebuilds the native stack. Detaching here races that update and
        // can leave the revealed destination translated.
        onBackPressedDispatcher.onBackPressed()
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
