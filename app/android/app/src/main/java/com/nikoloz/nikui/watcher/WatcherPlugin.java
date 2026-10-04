package com.nikoloz.nikui.watcher;

import android.annotation.SuppressLint;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;

/**
 * The switch for {@link WatchService}, what it needs to know, and the honest
 * answer to "can this phone do it at all" — which on iOS is no, and the
 * JavaScript asks the same question either way.
 */
@CapacitorPlugin(name = "Watcher")
public class WatcherPlugin extends Plugin {

    @Override
    public void load() {
        // The chime's channels exist before anything is raised, from either side.
        Chime.channels(getContext());
    }

    @PluginMethod
    public void status(PluginCall call) {
        call.resolve(state());
    }

    @PluginMethod
    public void start(PluginCall call) {
        Config.setEnabled(getContext(), true);
        WatchService.begin(getContext());
        call.resolve(state());
    }

    @PluginMethod
    public void stop(PluginCall call) {
        Config.setEnabled(getContext(), false);
        WatchService.end(getContext());
        call.resolve(state());
    }

    /** Where the laptop is, what to listen with, and which kinds are wanted. */
    @PluginMethod
    public void configure(PluginCall call) {
        Context context = getContext();
        String before = Config.secret(context);
        String origin = call.getString("origin");
        if (origin != null) Config.setOrigin(context, origin);
        String secret = call.getString("secret");
        if (secret != null) Config.setSecret(context, secret);
        JSArray kinds = call.getArray("kinds");
        if (kinds != null) Config.setKinds(context, kinds);
        String after = Config.secret(context);
        boolean changed = after == null ? before != null : !after.equals(before);
        if (Config.enabled(context)) WatchService.begin(context, changed);
        call.resolve(state());
    }

    /** Samsung in particular puts apps to sleep that it has not been told to leave alone. */
    @SuppressLint("BatteryLife")
    @PluginMethod
    public void exempt(PluginCall call) {
        if (!unrestricted() && Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            try {
                Intent ask = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                    Uri.parse("package:" + getContext().getPackageName()));
                getActivity().startActivity(ask);
            } catch (Exception refused) {
                getActivity().startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
            }
        }
        call.resolve(state());
    }

    /** The instance a tapped notification was about, once. */
    @PluginMethod
    public void opened(PluginCall call) {
        JSObject out = new JSObject();
        Intent intent = getActivity() == null ? null : getActivity().getIntent();
        String session = intent == null ? null : intent.getStringExtra(Chime.EXTRA_SESSION);
        if (session != null) intent.removeExtra(Chime.EXTRA_SESSION);
        out.put("session", session);
        call.resolve(out);
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        String session = intent == null ? null : intent.getStringExtra(Chime.EXTRA_SESSION);
        if (session == null) return;
        intent.removeExtra(Chime.EXTRA_SESSION);
        JSObject out = new JSObject();
        out.put("session", session);
        notifyListeners("opened", out);
    }

    private boolean unrestricted() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true;
        PowerManager power = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
        return power != null && power.isIgnoringBatteryOptimizations(getContext().getPackageName());
    }

    private JSObject state() {
        Context context = getContext();
        JSObject out = new JSObject();
        out.put("supported", true);
        out.put("platform", "android");
        out.put("enabled", Config.enabled(context));
        out.put("running", WatchService.isRunning());
        // off, waiting, connecting, listening, or refused.
        out.put("state", WatchService.state());
        out.put("listening", "listening".equals(WatchService.state()));
        out.put("origin", Config.origin(context));
        out.put("hasSecret", Config.secret(context) != null);
        out.put("unrestricted", unrestricted());
        // Android 13 asks separately before anything may be shown at all.
        out.put("needsPermission", Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU);
        return out;
    }
}
