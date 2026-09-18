package com.nikoloz.nikui.watcher;

import android.os.Build;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * The switch for {@link WatchService}, and the honest answer to "can this phone
 * do it at all" — which on iOS is no, and the JavaScript asks the same question
 * either way.
 */
@CapacitorPlugin(name = "Watcher")
public class WatcherPlugin extends Plugin {

    @PluginMethod
    public void status(PluginCall call) {
        call.resolve(state());
    }

    @PluginMethod
    public void start(PluginCall call) {
        // The WebView keeps running while the activity is paused, so the socket
        // it is holding survives — as long as the process does, which is what
        // the service is for.
        WatchService.begin(getContext());
        call.resolve(state());
    }

    @PluginMethod
    public void stop(PluginCall call) {
        WatchService.end(getContext());
        call.resolve(state());
    }

    private JSObject state() {
        JSObject out = new JSObject();
        out.put("supported", true);
        out.put("running", WatchService.isRunning());
        out.put("platform", "android");
        // Android 13 asks separately before anything may be shown at all, and
        // a background watcher that cannot show its own notification is a
        // contradiction the person should be told about rather than discover.
        out.put("needsPermission", Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU);
        return out;
    }
}
