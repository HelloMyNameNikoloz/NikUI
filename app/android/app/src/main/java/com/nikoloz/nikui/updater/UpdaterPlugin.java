package com.nikoloz.nikui.updater;

import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageInstaller;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.content.ContextCompat;
import androidx.lifecycle.Lifecycle;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;

/**
 * Installing a newer build of this app, handed over by the laptop it is paired
 * with — so an update reaches the phone wherever the tailnet does, with no
 * cable and no debugging switched on.
 *
 * The page asks the laptop for a one-time address; this downloads it, checks
 * it is byte for byte what the laptop said it was, and gives it to Android's
 * own installer. Android then asks the person, shows what it is, and refuses
 * anything not signed with the same key as the app already here — so the
 * laptop can offer an update, but never anything else.
 */
@CapacitorPlugin(name = "Updater")
public class UpdaterPlugin extends Plugin {
    private static final String ACTION = ".UPDATE_STATUS";
    private BroadcastReceiver receiver;
    private volatile boolean busy = false;

    // Where the last install got to, so a page that loads mid-install (the
    // person moved from Settings to a conversation and back) can pick it up:
    // the page's listeners go with the page, the download does not.
    private String phase = null;
    private long done = 0;
    private long total = 0;
    private String error = null;

    // Android's "Install this update?" screen. Started only while the app is
    // in front: from the background Android may block it without saying so,
    // which would leave the install waiting on a screen nobody sees.
    private Intent pendingConfirm = null;

    @Override
    public void load() {
        receiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                int status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
                if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
                    Intent confirm = intent.getParcelableExtra(Intent.EXTRA_INTENT);
                    if (confirm != null) {
                        confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                        synchronized (UpdaterPlugin.this) { pendingConfirm = confirm; }
                        state("confirming", null);
                        if (inFront()) showConfirm();
                        return;
                    }
                }
                busy = false;
                synchronized (UpdaterPlugin.this) { pendingConfirm = null; }
                if (status == PackageInstaller.STATUS_SUCCESS) state("installed", null);
                else if (status == PackageInstaller.STATUS_FAILURE_ABORTED) state("cancelled", null);
                else state("failed", intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE));
            }
        };
        ContextCompat.registerReceiver(getContext(), receiver,
            new IntentFilter(getContext().getPackageName() + ACTION), ContextCompat.RECEIVER_NOT_EXPORTED);
    }

    @Override
    protected void handleOnDestroy() {
        if (receiver != null) {
            try { getContext().unregisterReceiver(receiver); } catch (Exception ignored) { }
            receiver = null;
        }
    }

    @Override
    protected void handleOnResume() {
        // Asked while the app was away: ask now that it is back.
        boolean waiting;
        synchronized (this) { waiting = pendingConfirm != null && "confirming".equals(phase) && !confirmShown; }
        if (waiting) showConfirm();
    }

    private boolean confirmShown = false;

    private boolean inFront() {
        return getActivity() != null
            && getActivity().getLifecycle().getCurrentState().isAtLeast(Lifecycle.State.RESUMED);
    }

    /** Returns whether Android's confirmation screen could be started. */
    private boolean showConfirm() {
        Intent confirm;
        synchronized (this) { confirm = pendingConfirm; }
        if (confirm == null) return false;
        try {
            getContext().startActivity(confirm);
            synchronized (this) { confirmShown = true; }
            return true;
        } catch (Exception e) {
            busy = false;
            synchronized (this) { pendingConfirm = null; }
            state("failed", "Android would not show the installer.");
            return false;
        }
    }

    /**
     * Android's confirmation screen again, for when it was dismissed or never
     * came up. With nothing waiting on it, the install is over and this says so.
     */
    @PluginMethod
    public void confirm(PluginCall call) {
        boolean waiting;
        synchronized (this) { waiting = pendingConfirm != null; }
        if (!waiting) {
            if (busy && !"confirming".equals(phase)) { call.resolve(); return; }
            busy = false;
            state(null, null);
            call.reject("Nothing is waiting to be installed.");
            return;
        }
        if (showConfirm()) call.resolve(); else call.reject("Android would not show the installer.");
    }

    /** Where an install got to, for a page that was not there to hear it. */
    @PluginMethod
    public void status(PluginCall call) {
        JSObject out = new JSObject();
        synchronized (this) {
            out.put("busy", busy);
            if (phase != null) out.put("state", phase);
            out.put("done", done);
            out.put("total", total);
            if (error != null) out.put("message", error);
        }
        call.resolve(out);
    }

    /** Whether Android lets this app install updates, which a person grants once. */
    @PluginMethod
    public void canInstall(PluginCall call) {
        JSObject out = new JSObject();
        out.put("allowed", allowed());
        call.resolve(out);
    }

    /** The one switch in Android's settings that `canInstall` is about. */
    @PluginMethod
    public void allow(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Intent intent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.parse("package:" + getContext().getPackageName()));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            try { getContext().startActivity(intent); } catch (Exception e) { call.reject("Android has no such setting here."); return; }
        }
        call.resolve();
    }

    @PluginMethod
    public void install(PluginCall call) {
        final String url = call.getString("url");
        final String sha256 = call.getString("sha256");
        final long size = call.getLong("size", -1L);
        if (url == null || !(url.startsWith("https://") || url.startsWith("http://"))) {
            call.reject("No address to download the update from.");
            return;
        }
        if (busy) { call.reject("An update is already being installed."); return; }
        if (!allowed()) { call.reject("not-allowed"); return; }
        busy = true;
        synchronized (this) { pendingConfirm = null; confirmShown = false; error = null; phase = "downloading"; done = 0; total = size; }
        call.resolve();

        new Thread(() -> {
            File file = new File(getContext().getCacheDir(), "nikui-update.apk");
            try {
                download(url, file, size);
                if (sha256 != null && !sha256.equalsIgnoreCase(digest(file))) {
                    throw new Exception("The download did not match what the laptop sent. Try again.");
                }
                state("installing", null);
                hand(file);
            } catch (Exception e) {
                busy = false;
                file.delete();
                state("failed", e.getMessage() != null ? e.getMessage() : "The update could not be downloaded.");
            }
        }, "nikui-update").start();
    }

    private boolean allowed() {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.O
            || getContext().getPackageManager().canRequestPackageInstalls();
    }

    private void download(String address, File file, long expected) throws Exception {
        HttpURLConnection http = (HttpURLConnection) new URL(address).openConnection();
        http.setConnectTimeout(15000);
        http.setReadTimeout(30000);
        http.setInstanceFollowRedirects(false);
        int code = http.getResponseCode();
        if (code != 200) {
            http.disconnect();
            throw new Exception(code == 404 || code == 410
                ? "That update is no longer offered. Check again."
                : "The laptop refused the download (" + code + ").");
        }
        long total = http.getContentLengthLong();
        if (total <= 0) total = expected;
        long done = 0;
        long told = -1;
        try (InputStream in = http.getInputStream(); OutputStream out = new FileOutputStream(file)) {
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = in.read(buffer)) != -1) {
                out.write(buffer, 0, read);
                done += read;
                // Every whole percent, not every buffer: the bridge is not free.
                long percent = total > 0 ? (done * 100 / total) : -1;
                if (percent != told) {
                    told = percent;
                    synchronized (this) { phase = "downloading"; this.done = done; this.total = total; }
                    JSObject progress = new JSObject();
                    progress.put("state", "downloading");
                    progress.put("done", done);
                    progress.put("total", total);
                    notifyListeners("progress", progress);
                }
            }
        } finally {
            http.disconnect();
        }
        if (expected > 0 && done != expected) throw new Exception("The download stopped early. Try again.");
    }

    private static String digest(File file) throws Exception {
        MessageDigest sha = MessageDigest.getInstance("SHA-256");
        try (InputStream in = new FileInputStream(file)) {
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = in.read(buffer)) != -1) sha.update(buffer, 0, read);
        }
        StringBuilder hex = new StringBuilder();
        for (byte b : sha.digest()) hex.append(String.format("%02x", b));
        return hex.toString();
    }

    /** Give the file to Android's installer, which asks the person and does the rest. */
    private void hand(File file) throws Exception {
        PackageInstaller installer = getContext().getPackageManager().getPackageInstaller();
        PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
        params.setAppPackageName(getContext().getPackageName());
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED);
        }
        int id = installer.createSession(params);
        try (PackageInstaller.Session session = installer.openSession(id)) {
            try (InputStream in = new FileInputStream(file);
                 OutputStream out = session.openWrite("nikui.apk", 0, file.length())) {
                byte[] buffer = new byte[64 * 1024];
                int read;
                while ((read = in.read(buffer)) != -1) out.write(buffer, 0, read);
                session.fsync(out);
            }
            Intent status = new Intent(getContext().getPackageName() + ACTION).setPackage(getContext().getPackageName());
            int flags = PendingIntent.FLAG_UPDATE_CURRENT
                | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ? PendingIntent.FLAG_MUTABLE : 0);
            PendingIntent pending = PendingIntent.getBroadcast(getContext(), id, status, flags);
            session.commit(pending.getIntentSender());
        } finally {
            file.delete();
        }
    }

    private void state(String state, String message) {
        synchronized (this) {
            // Over: nothing for a later page to resume, except what went wrong.
            boolean over = state == null || "installed".equals(state) || "cancelled".equals(state) || "failed".equals(state);
            phase = over ? null : state;
            error = "failed".equals(state) ? message : null;
            if (over) { pendingConfirm = null; confirmShown = false; }
        }
        if (state == null) return;
        JSObject out = new JSObject();
        out.put("state", state);
        if (message != null) out.put("message", message);
        notifyListeners("progress", out);
    }
}
