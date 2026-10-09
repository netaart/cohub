/**
 * The chat/files pager is an outer horizontal scroller. A chat message can contain a nested
 * horizontal scroller (Markdown code block or table). Android gives the outer scroller priority
 * unless the inner one calls `requestDisallowInterceptTouchEvent`.
 *
 * React Native's pager only yields to another `ReactHorizontalScrollView`, so a vanilla
 * `HorizontalScrollView` never wins. An OnTouchListener also cannot claim the drag: the child
 * TextView consumes ACTION_DOWN, the listener never runs, and MOVE is intercepted by the pager.
 *
 * Claim in `dispatchTouchEvent` (it sees every event that hits the scroller) and only keep the
 * drag while this view can actually scroll that way. A vertical drag, or a horizontal drag at the
 * edge / on a block that does not overflow, is handed back so the timeline and pager still work.
 * Touches that do not start on a nested scroller are untouched.
 *
 * Applied on install because the patch has to land inside the dependency's native sources. The
 * proper fix belongs upstream; this only holds the line until it ships.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const MARKER = "// cohub: nested horizontal scroll claims its own drag";
const OLD_MARKER = "// cohub: claim gestures that start on a code block";
const ANDROID_VIEWS = "node_modules/react-native-enriched-markdown/android/src/main/java/com/swmansion/enriched/markdown/views";
const HELPER_RELATIVE = `${ANDROID_VIEWS}/NestedHorizontalScrollView.kt`;
const CODE_BLOCK_RELATIVE = `${ANDROID_VIEWS}/CodeBlockContainerView.kt`;
const TABLE_RELATIVE = `${ANDROID_VIEWS}/TableContainerView.kt`;
const IOS_CODE_BLOCK_RELATIVE = "node_modules/react-native-enriched-markdown/ios/views/ENRMCodeBlockContainerView.m";

const HELPER_SOURCE = `package com.swmansion.enriched.markdown.views

import android.content.Context
import android.view.MotionEvent
import android.view.ViewConfiguration
import android.widget.HorizontalScrollView
import kotlin.math.abs

/**
 * Cohub postinstall patch (scripts/patch-enriched-markdown.mjs). Not upstream.
 *
 * The chat/files pager is a ReactHorizontalScrollView. RN only yields a
 * horizontal drag to another ReactHorizontalScrollView, so a vanilla
 * HorizontalScrollView in a Markdown code block/table never wins — the pager
 * opens instead of scrolling the code.
 *
 * Claim in dispatchTouchEvent (OnTouchListener never sees ACTION_DOWN: the
 * child TextView consumes it). Keep the drag only while this view can actually
 * scroll that way; a vertical drag, or a horizontal drag at the edge, is
 * handed back so the timeline and pager still work. Nested scrolling is off
 * so leftover motion cannot also drag the pager.
 */
internal class NestedHorizontalScrollView(context: Context) : HorizontalScrollView(context) {
  private var downX = 0f
  private var downY = 0f
  private val touchSlop = ViewConfiguration.get(context).scaledTouchSlop

  init {
    isNestedScrollingEnabled = false
  }

  override fun dispatchTouchEvent(event: MotionEvent): Boolean {
    when (event.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        downX = event.rawX
        downY = event.rawY
        if (canScrollHorizontally(1) || canScrollHorizontally(-1)) {
          parent?.requestDisallowInterceptTouchEvent(true)
        }
      }
      MotionEvent.ACTION_MOVE -> {
        val dx = event.rawX - downX
        val dy = event.rawY - downY
        if (abs(dx) > touchSlop || abs(dy) > touchSlop) {
          if (abs(dy) > abs(dx)) {
            parent?.requestDisallowInterceptTouchEvent(false)
          } else {
            val canScroll = if (dx > 0) canScrollHorizontally(-1) else canScrollHorizontally(1)
            parent?.requestDisallowInterceptTouchEvent(canScroll)
          }
        }
      }
      MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
        parent?.requestDisallowInterceptTouchEvent(false)
      }
    }
    return super.dispatchTouchEvent(event)
  }
}
`;

const IOS_NESTED_SCROLL_VIEW = `#if !TARGET_OS_OSX
${MARKER}
@interface ENRMNestedHorizontalScrollView : RCTUIScrollView
@end

@implementation ENRMNestedHorizontalScrollView

- (BOOL)gestureRecognizerShouldBegin:(UIGestureRecognizer *)gestureRecognizer
{
  if (![super gestureRecognizerShouldBegin:gestureRecognizer]) {
    return NO;
  }
  if (gestureRecognizer != self.panGestureRecognizer ||
      ![gestureRecognizer isKindOfClass:[UIPanGestureRecognizer class]]) {
    return YES;
  }
  UIPanGestureRecognizer *pan = (UIPanGestureRecognizer *)gestureRecognizer;
  CGPoint translation = [pan translationInView:self];
  if (fabs(translation.y) > fabs(translation.x)) {
    return NO;
  }
  CGFloat dx = translation.x;
  if (dx == 0) {
    dx = [pan velocityInView:self].x;
  }
  if (dx > 0) {
    return self.contentOffset.x > 0.5;
  }
  return (self.contentOffset.x + CGRectGetWidth(self.bounds)) < (self.contentSize.width - 0.5);
}

- (BOOL)gestureRecognizer:(UIGestureRecognizer *)gestureRecognizer
    shouldBeRequiredToFailByGestureRecognizer:(UIGestureRecognizer *)otherGestureRecognizer
{
  if (gestureRecognizer == self.panGestureRecognizer &&
      [otherGestureRecognizer.view isKindOfClass:[UIScrollView class]] &&
      otherGestureRecognizer.view != self) {
    return YES;
  }
  return NO;
}

@end
#endif

`;

function fail(message) {
  console.error(`[patch-enriched-markdown] ${message}`);
  process.exit(1);
}

function readRequired(relative) {
  const target = path.join(process.cwd(), relative);
  try {
    return { target, source: readFileSync(target, "utf8") };
  } catch (error) {
    fail(`unable to read ${relative}: ${error instanceof Error ? error.message : error}`);
  }
}

function replaceOnce(source, find, replacement, label) {
  const count = source.split(find).length - 1;
  if (count !== 1) fail(`${label}: expected exactly one match, found ${count}`);
  return source.replace(find, replacement);
}

function stripOldAndroidListenerPatch(source) {
  if (!source.includes(OLD_MARKER)) return source;
  let next = source.replace("import android.view.MotionEvent\n", "");
  next = next.replace(/\n  private var gestureDownX = 0f\n  private var gestureDownY = 0f\n/, "\n");
  next = next.replace(
    /\n      \/\/ cohub: claim gestures that start on a code block\n      setOnTouchListener \{[\s\S]*?false\n      \}\n/,
    "\n",
  );
  if (next.includes(OLD_MARKER) || next.includes("setOnTouchListener")) {
    fail("the previous OnTouchListener patch changed shape and could not be upgraded");
  }
  return next;
}

function applyNestedAndroidScrollView(source, label) {
  let next = stripOldAndroidListenerPatch(source);
  if (!next.includes("NestedHorizontalScrollView(context)")) {
    if (!next.includes("HorizontalScrollView(context).apply {")) {
      fail(`${label} no longer constructs a HorizontalScrollView; update the patch or drop it if upstream shipped the fix`);
    }
    next = replaceOnce(
      next,
      "HorizontalScrollView(context).apply {",
      `NestedHorizontalScrollView(context).apply { ${MARKER}`,
      label,
    );
  }
  if (next.includes("NestedHorizontalScrollView(context)")) {
    const withoutImport = next.replace("import android.widget.HorizontalScrollView\n", "");
    if (withoutImport !== next && !withoutImport.replaceAll("NestedHorizontalScrollView", "").includes("HorizontalScrollView")) {
      next = withoutImport;
    }
  }
  return next;
}

function patchIosCodeBlock(source) {
  if (source.includes("ENRMNestedHorizontalScrollView")) return source;
  const insertAnchor = `#if !TARGET_OS_OSX
@interface ENRMCodeBlockContainerView () <UIContextMenuInteractionDelegate>
@end
#endif`;
  const scrollAnchor = "  _scrollView = [[RCTUIScrollView alloc] init];\n";
  const bounceAnchor = "  _scrollView.bounces = YES;\n  _scrollView.alwaysBounceHorizontal = NO;\n";
  if (!source.includes(insertAnchor) || !source.includes(scrollAnchor) || !source.includes(bounceAnchor)) {
    fail("the iOS code block changed shape; re-check ENRMCodeBlockContainerView.m and update the patch");
  }
  let next = replaceOnce(source, insertAnchor, `${IOS_NESTED_SCROLL_VIEW}${insertAnchor}`, "iOS nested scroll class");
  next = replaceOnce(
    next,
    scrollAnchor,
    `#if !TARGET_OS_OSX
  _scrollView = [[ENRMNestedHorizontalScrollView alloc] init];
#else
  _scrollView = [[RCTUIScrollView alloc] init];
#endif
`,
    "iOS scroll view alloc",
  );
  return replaceOnce(
    next,
    bounceAnchor,
    "  _scrollView.bounces = YES;\n  _scrollView.alwaysBounceHorizontal = NO;\n  _scrollView.directionalLockEnabled = YES;\n",
    "iOS directional lock",
  );
}

function writeIfChanged(target, previous, next, label) {
  if (previous === next) {
    console.log(`[patch-enriched-markdown] ${label} already applied`);
    return false;
  }
  writeFileSync(target, next);
  console.log(`[patch-enriched-markdown] ${label} applied`);
  return true;
}

const helperTarget = path.join(process.cwd(), HELPER_RELATIVE);
mkdirSync(path.dirname(helperTarget), { recursive: true });
writeIfChanged(helperTarget, (() => {
  try {
    return readFileSync(helperTarget, "utf8");
  } catch {
    return "";
  }
})(), HELPER_SOURCE, "Android NestedHorizontalScrollView");

const codeBlock = readRequired(CODE_BLOCK_RELATIVE);
writeIfChanged(codeBlock.target, codeBlock.source, applyNestedAndroidScrollView(codeBlock.source, "CodeBlockContainerView.kt"), "Android code block");

const table = readRequired(TABLE_RELATIVE);
writeIfChanged(table.target, table.source, applyNestedAndroidScrollView(table.source, "TableContainerView.kt"), "Android table");

const ios = readRequired(IOS_CODE_BLOCK_RELATIVE);
writeIfChanged(ios.target, ios.source, patchIosCodeBlock(ios.source), "iOS code block");

function assertPatched(relative, needle) {
  const { source } = readRequired(relative);
  if (!source.includes(needle)) fail(`${relative} is missing ${needle}`);
}
assertPatched(HELPER_RELATIVE, "override fun dispatchTouchEvent");
assertPatched(CODE_BLOCK_RELATIVE, "NestedHorizontalScrollView(context)");
assertPatched(TABLE_RELATIVE, "NestedHorizontalScrollView(context)");
assertPatched(IOS_CODE_BLOCK_RELATIVE, "ENRMNestedHorizontalScrollView");
