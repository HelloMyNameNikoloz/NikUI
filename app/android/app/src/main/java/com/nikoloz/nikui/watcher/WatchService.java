package com.nikoloz.nikui.watcher;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.ConnectivityManager;
import android.net.Network;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

import androidx.core.app.NotificationCompat;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Set;

/**
 * Listens to the laptop while NikUI is not on screen — locked, in a pocket,
 * swiped away, or after the phone restarts — and raises its notifications.
 *
 * It does not keep the app's WebView alive and lean on its socket, because
 * that socket dies with the app. It holds its own connection instead: one
 * long HTTPS request to /notify/listen, opened with a secret the laptop gave
 * this phone for listening and nothing else, down which the laptop writes each
 * notification as it happens. No push service and no account anywhere.
 *
 * Android allows exactly one honest way to do this: a foreground service with
 * a notification the person can see. That notification is the deal, so it is
 * deliberately quiet: lowest importance, no sound, no badge. remoteMessaging is
 * what this is — messages from another device — and unlike dataSync it has no
 * daily limit and may start when the phone does.
 *
 * There is no iOS half of this file, and there cannot be. iOS suspends an app
 * the moment it leaves the screen; the only way to reach it there is Apple's.
 */
public class WatchService extends Service {

    public static final String CHANNEL = "nikui-watching";
    private static final int ID = 4517; // the port, for want of a more meaningful number

    // Off, waiting for the laptop, or listening. "refused" is the laptop
    // saying the secret is no longer good; the app asks for a new one.
    private static volatile boolean running = false;
    private static volatile String state = "off";

    private final Object lock = new Object();
    private volatile boolean stopping = false;
    private volatile boolean poked = false;
    private volatile HttpURLConnection current;
    private Thread thread;
    private PowerManager.WakeLock wake;
    private ConnectivityManager.NetworkCallback network;

    public static boolean isRunning() { return running; }
    public static String state() { return state; }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    @Override
    public void onCreate() {
        super.onCreate();
        channel();
        Chime.channels(this);
        foreground("Waiting for your laptop");
        running = true;
        PowerManager power = (PowerManager) getSystemService(Context.POWER_SERVICE);
        if (power != null) {
            wake = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "nikui:notify");
            wake.setReferenceCounted(false);
        }
        watchNetwork();
        thread = new Thread(this::loop, "nikui-listen");
        thread.start();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (!Config.enabled(this)) {
            stopSelf();
            return START_NOT_STICKY;
        }
        poke(intent != null && intent.getBooleanExtra("reconnect", false));
        // Restarted by the system if it has to kill us — which is the entire
        // point of being here.
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        stopping = true;
        running = false;
        state = "off";
        poke(true);
        if (network != null) {
            ConnectivityManager connectivity = getSystemService(ConnectivityManager.class);
            try { if (connectivity != null) connectivity.unregisterNetworkCallback(network); }
            catch (Exception ignored) { /* already gone */ }
        }
        if (wake != null && wake.isHeld()) wake.release();
        super.onDestroy();
    }

    /** Try now rather than at the end of a backoff: something changed. */
    private void poke(boolean reconnect) {
        poked = true;
        HttpURLConnection open = current;
        synchronized (lock) { lock.notifyAll(); }
        // A changed secret or origin means the open stream is the wrong one.
        if (reconnect && open != null) open.disconnect();
    }

    private void rest(long ms) {
        synchronized (lock) {
            if (poked || stopping) return;
            try { lock.wait(ms); } catch (InterruptedException ignored) { /* go on */ }
        }
    }

    private void loop() {
        long backoff = 2000;
        String said = null;
        while (!stopping) {
            poked = false;
            if (!Config.ready(this)) {
                state = Config.secret(this) == null && Config.origin(this) != null ? "refused" : "waiting";
                said = say(said, "Open NikUI once to connect");
                rest(10 * 60 * 1000);
                continue;
            }
            state = "connecting";
            boolean heard = false;
            try {
                heard = listen(said);
                said = null;
            } catch (Exception lost) {
                // Not reachable, or reachable and gone. Either way, again shortly.
            } finally {
                current = null;
            }
            if (stopping) break;
            state = Config.ready(this) ? "waiting" : state;
            said = say(said, "Waiting for your laptop");
            if (heard) backoff = 2000;
            rest(backoff);
            backoff = Math.min(backoff * 2, 60000);
        }
    }

    /** One connection, for as long as it lasts. True if it ever got through. */
    private boolean listen(String said) throws Exception {
        String origin = Config.origin(this);
        String secret = Config.secret(this);
        HttpURLConnection http = (HttpURLConnection) new URL(origin + "/notify/listen").openConnection();
        current = http;
        http.setRequestProperty("Authorization", "Bearer " + secret);
        http.setRequestProperty("Accept", "text/event-stream");
        http.setUseCaches(false);
        http.setConnectTimeout(15000);
        // The laptop says something every 30 s; three times that in silence
        // is a connection that died without saying so.
        http.setReadTimeout(100000);
        int code = http.getResponseCode();
        if (code == 401) {
            // Another secret was handed out, or this phone was forgotten.
            if (secret.equals(Config.secret(this))) Config.forgetSecret(this);
            state = "refused";
            return false;
        }
        if (code != 200) throw new IllegalStateException("HTTP " + code);

        state = "listening";
        say(said, "Listening for your laptop");
        BufferedReader in = new BufferedReader(new InputStreamReader(http.getInputStream(), StandardCharsets.UTF_8));
        String event = "";
        StringBuilder data = new StringBuilder();
        String line;
        while (!stopping && (line = in.readLine()) != null) {
            if (line.isEmpty()) {
                if ("notify".equals(event) && data.length() > 0) deliver(data.toString());
                event = "";
                data.setLength(0);
            } else if (line.startsWith("event:")) {
                event = line.substring(6).trim();
            } else if (line.startsWith("data:")) {
                if (data.length() > 0) data.append('\n');
                data.append(line.substring(5).trim());
            }
        }
        http.disconnect();
        return true;
    }

    private void deliver(String text) {
        if (wake != null) wake.acquire(10000);
        try {
            JSONObject message = new JSONObject(text);
            Set<String> kinds = Config.kinds(this);
            if (kinds.contains(message.optString("kind", ""))) Chime.post(this, message);
        } catch (Exception ignored) {
            // Something this version does not understand; the next one will.
        } finally {
            if (wake != null && wake.isHeld()) wake.release();
        }
    }

    /** A network coming back is the moment to try, not the end of a backoff. */
    private void watchNetwork() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return;
        ConnectivityManager connectivity = getSystemService(ConnectivityManager.class);
        if (connectivity == null) return;
        network = new ConnectivityManager.NetworkCallback() {
            @Override
            public void onAvailable(Network n) {
                if (!"listening".equals(state)) poke(false);
            }
        };
        try { connectivity.registerDefaultNetworkCallback(network); }
        catch (Exception ignored) { network = null; }
    }

    private String say(String said, String text) {
        if (text.equals(said)) return said;
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) manager.notify(ID, notification(text));
        return text;
    }

    private void foreground(String text) {
        Notification shown = notification(text);
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(ID, shown, ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING);
        } else {
            startForeground(ID, shown);
        }
    }

    private void channel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null || manager.getNotificationChannel(CHANNEL) != null) return;
        NotificationChannel made = new NotificationChannel(
            CHANNEL, "Listening for your laptop", NotificationManager.IMPORTANCE_MIN);
        made.setDescription("The quiet notification Android requires while NikUI listens in the background");
        made.setShowBadge(false);
        made.setSound(null, null);
        manager.createNotificationChannel(made);
    }

    private Notification notification(String text) {
        Intent open = new Intent(this, com.nikoloz.nikui.MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        int icon = getResources().getIdentifier("ic_stat_nikui", "drawable", getPackageName());

        return new NotificationCompat.Builder(this, CHANNEL)
            .setContentTitle(text)
            .setContentText("So you hear when something needs you")
            .setSmallIcon(icon != 0 ? icon : getApplicationInfo().icon)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setOngoing(true)
            .setShowWhen(false)
            .setOnlyAlertOnce(true)
            .setContentIntent(PendingIntent.getActivity(this, 0, open, flags))
            .build();
    }

    public static void begin(Context context) { begin(context, false); }

    /** Start, or if already running, look again — and with reconnect, drop the stream it holds. */
    public static void begin(Context context, boolean reconnect) {
        Intent intent = new Intent(context, WatchService.class).putExtra("reconnect", reconnect);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent);
            else context.startService(intent);
        } catch (Exception refused) {
            // Started from somewhere Android does not allow it; the app will
            // start it next time it opens.
        }
    }

    public static void end(Context context) {
        context.stopService(new Intent(context, WatchService.class));
        running = false;
        state = "off";
    }
}
