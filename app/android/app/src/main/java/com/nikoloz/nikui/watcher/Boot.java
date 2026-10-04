package com.nikoloz.nikui.watcher;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * A phone that restarts, or an app that updates, would otherwise stop
 * listening until somebody happened to open it. Both are moments Android lets
 * a remoteMessaging service start from nothing.
 */
public class Boot extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent == null ? null : intent.getAction();
        if (!Intent.ACTION_BOOT_COMPLETED.equals(action) && !Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) return;
        if (Config.enabled(context)) WatchService.begin(context);
    }
}
