package com.nikoloz.nikui.bars;

import android.graphics.Color;
import android.view.View;

import androidx.core.view.WindowCompat;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * The strip the system navigation sits in follows the app's appearance: black
 * under the dark theme, the tab bar's colour under the light one, with the
 * navigation icons drawn to read on it. The page says which, after it has
 * settled the reader's choice against the phone's.
 */
// Not "SystemBars": Capacitor 8 has a plugin of its own by that name.
@CapacitorPlugin(name = "NikBars")
public class SystemBarsPlugin extends Plugin {
    @PluginMethod
    public void set(PluginCall call) {
        final boolean light = Boolean.TRUE.equals(call.getBoolean("light", false));
        final int colour = parse(call.getString("color"), light ? 0xFFF3F5F3 : 0xFF000000);
        getActivity().runOnUiThread(() -> {
            View content = getActivity().findViewById(android.R.id.content);
            if (content != null) content.setBackgroundColor(colour);
            // What shows behind the status bar and the navigation strip.
            getActivity().getWindow().getDecorView().setBackgroundColor(colour);
            getActivity().getWindow().setNavigationBarColor(colour);
            WindowCompat.getInsetsController(getActivity().getWindow(), getActivity().getWindow().getDecorView())
                .setAppearanceLightNavigationBars(light);
            call.resolve();
        });
    }

    private static int parse(String hex, int fallback) {
        if (hex == null) return fallback;
        try { return Color.parseColor(hex.trim()); } catch (IllegalArgumentException e) { return fallback; }
    }
}
