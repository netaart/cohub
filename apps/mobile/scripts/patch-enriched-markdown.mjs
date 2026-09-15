/**
 * The chat/files pager is an outer horizontal scroller, and a chat message can contain a nested
 * horizontal scroller (the Markdown code block). Android gives the outer scroller priority unless
 * the inner one calls `requestDisallowInterceptTouchEvent`, and the Markdown library never does — so
 * a drag on a code block opens the panel instead of scrolling the code.
 *
 * Claim the gesture on touch down (so the pager cannot steal it) and hand it back as soon as the
 * drag turns vertical, which leaves the timeline's own axis to the outer list. Touches that do not
 * start on a code block are untouched, so the panel swipe keeps working everywhere else.
 *
 * Applied on install because the patch has to land inside the dependency's Android sources. The
 * proper fix belongs upstream; this only holds the line until it ships.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const RELATIVE = "node_modules/react-native-enriched-markdown/android/src/main/java/com/swmansion/enriched/markdown/views/CodeBlockContainerView.kt";
const MARKER = "// cohub: claim gestures that start on a code block";

const IMPORT_ANCHOR = "import android.util.TypedValue\nimport android.view.View\n";
const IMPORT_PATCHED = "import android.util.TypedValue\nimport android.view.MotionEvent\nimport android.view.View\n";

const FIELD_ANCHOR = "  private val scrollView =\n    HorizontalScrollView(context).apply {\n      isHorizontalScrollBarEnabled = true\n";
const FIELD_PATCHED = `  private var gestureDownX = 0f
  private var gestureDownY = 0f

  private val scrollView =
    HorizontalScrollView(context).apply {
      isHorizontalScrollBarEnabled = true
      ${MARKER}
      setOnTouchListener { view, event ->
        when (event.actionMasked) {
          MotionEvent.ACTION_DOWN -> {
            gestureDownX = event.rawX
            gestureDownY = event.rawY
            view.parent?.requestDisallowInterceptTouchEvent(true)
          }
          MotionEvent.ACTION_MOVE -> {
            if (kotlin.math.abs(event.rawY - gestureDownY) > kotlin.math.abs(event.rawX - gestureDownX)) {
              view.parent?.requestDisallowInterceptTouchEvent(false)
            }
          }
          MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> view.parent?.requestDisallowInterceptTouchEvent(false)
        }
        false
      }
`;

const target = path.join(process.cwd(), RELATIVE);
let source;
try {
  source = readFileSync(target, "utf8");
} catch (error) {
  console.error(`[patch-enriched-markdown] unable to read ${RELATIVE}: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}

if (source.includes(MARKER)) {
  console.log("[patch-enriched-markdown] already applied");
  process.exit(0);
}

if (!source.includes(IMPORT_ANCHOR) || !source.includes(FIELD_ANCHOR)) {
  console.error([
    "[patch-enriched-markdown] the Markdown library's code block changed shape; the patch no longer",
    "applies. Re-check CodeBlockContainerView.kt (imports + the HorizontalScrollView initializer) and",
    "update scripts/patch-enriched-markdown.mjs, or drop the patch if the upstream fix has shipped:",
  ].join("\n"));
  process.exit(1);
}

source = source.replace(IMPORT_ANCHOR, IMPORT_PATCHED).replace(FIELD_ANCHOR, FIELD_PATCHED);
writeFileSync(target, source);
console.log("[patch-enriched-markdown] applied");
