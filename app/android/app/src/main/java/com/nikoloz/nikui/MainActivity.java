package com.nikoloz.nikui;

import android.os.Build;
import android.os.Bundle;
import android.view.View;

import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;

import com.getcapacitor.BridgeActivity;
import com.nikoloz.nikui.applock.AppLockPlugin;
import com.nikoloz.nikui.securekey.SecureKeyPlugin;
import com.nikoloz.nikui.watcher.WatcherPlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // This app's own plugin, and the only one not installed from a package:
        // the key in the Keystore. Registered before the bridge starts, or the
        // first page would look for it and conclude the phone has no chip.
        registerPlugin(SecureKeyPlugin.class);
        registerPlugin(WatcherPlugin.class);
        registerPlugin(AppLockPlugin.class);
        super.onCreate(savedInstanceState);
        keepClearOfNavigation();
    }

    // The colour of the tab bar, so the strip the system navigation sits in
    // reads as the bottom of the app rather than as a gap. app.css says the same.
    private static final int NAV_STRIP = 0xFF141417;

    /**
     * Android 15 and later draw every app under the navigation bar. Here the
     * system navigation gets its own strip below the app instead, the way it
     * looks everywhere else on the phone: the app is padded by the bar's height
     * and the page is told there is nothing to avoid at the bottom. The status
     * bar stays drawn over, which the page already clears.
     */
    private void keepClearOfNavigation() {
        View content = findViewById(android.R.id.content);
        if (content == null) return;
        content.setBackgroundColor(NAV_STRIP);
        getWindow().setNavigationBarColor(NAV_STRIP);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) getWindow().setNavigationBarContrastEnforced(false);
        WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView()).setAppearanceLightNavigationBars(false);

        int bars = WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout();
        ViewCompat.setOnApplyWindowInsetsListener(content, (v, insets) -> {
            Insets nav = insets.getInsets(WindowInsetsCompat.Type.navigationBars());
            // With the keyboard up, Capacitor has already lifted the page above it.
            boolean typing = insets.isVisible(WindowInsetsCompat.Type.ime());
            int bottom = typing ? 0 : nav.bottom;
            v.setPadding(nav.left, 0, nav.right, bottom);
            Insets all = insets.getInsets(bars);
            return new WindowInsetsCompat.Builder(insets)
                .setInsets(bars, Insets.of(
                    Math.max(0, all.left - nav.left), all.top,
                    Math.max(0, all.right - nav.right), Math.max(0, all.bottom - bottom)))
                .build();
        });
        ViewCompat.requestApplyInsets(content);
    }
}
