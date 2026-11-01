package live.cohub.android.helper;

import android.content.ClipData;
import android.content.Intent;
import android.view.Surface;

interface ICohubHelper {
    int createDisplay(String name, int width, int height, int densityDpi, in Surface surface) = 1;
    void releaseDisplay(int displayId) = 2;
    IBinder mirror(int displayId, int width, int height, in Surface surface) = 3;
    void releaseMirror(IBinder token) = 4;
    boolean touch(int displayId, int action, float x, float y, long downTime) = 5;
    boolean key(int displayId, int action, int keyCode, int metaState) = 6;
    int start(int displayId, in Intent intent) = 7;
    String topPackage(int displayId) = 8;
    int moveTop(int fromDisplayId, int toDisplayId) = 9;
    boolean moveTask(int taskId, int displayId) = 10;
    void prepare() = 11;
    oneway void syncAudio() = 12;
    @nullable ClipData putClip(String text) = 13;
    void restoreClip(in @nullable ClipData previous, String ours) = 14;
}
