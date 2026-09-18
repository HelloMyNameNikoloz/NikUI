package com.nikoloz.nikui.watcher;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;

import androidx.core.app.NotificationCompat;

/**
 * Keeps this app alive while it is not on screen, so the socket to the laptop
 * stays open and a notification arrives while the phone is in a pocket.
 *
 * Android allows exactly one honest way to do this: a foreground service with a
 * notification the person can see. That notification is the deal — the system
 * will not let an app listen in the background without telling its owner that
 * it is. So it is deliberately quiet: lowest importance, no sound, no badge,
 * ongoing, and it says what it is for in words rather than in a product name.
 *
 * There is no iOS half of this file, and there cannot be. iOS suspends an app
 * the moment it leaves the screen and offers no entitlement that changes it for
 * this purpose. The app says so on the settings screen rather than offering a
 * switch that would do nothing.
 */
public class WatchService extends Service {

    public static final String CHANNEL = "nikui-watching";
    private static final int ID = 4517; // the port, for want of a more meaningful number
    private static boolean running = false;

    public static boolean isRunning() {
        return running;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        channel();
        startForeground(ID, notification());
        running = true;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // Restarted by the system if it has to kill us — which is the entire
        // point of being here.
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        running = false;
        super.onDestroy();
    }

    private void channel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null || manager.getNotificationChannel(CHANNEL) != null) return;
        NotificationChannel made = new NotificationChannel(
            CHANNEL, "Watching your laptop", NotificationManager.IMPORTANCE_MIN);
        made.setDescription("The quiet notification Android requires while NikUI listens in the background");
        made.setShowBadge(false);
        made.setSound(null, null);
        manager.createNotificationChannel(made);
    }

    private Notification notification() {
        Intent open = new Intent(this, com.nikoloz.nikui.MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;

        return new NotificationCompat.Builder(this, CHANNEL)
            .setContentTitle("Watching your laptop")
            .setContentText("So NikUI can tell you when something needs you")
            .setSmallIcon(getApplicationInfo().icon)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setOngoing(true)
            .setShowWhen(false)
            .setContentIntent(PendingIntent.getActivity(this, 0, open, flags))
            .build();
    }

    public static void begin(Context context) {
        Intent intent = new Intent(context, WatchService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent);
        else context.startService(intent);
    }

    public static void end(Context context) {
        context.stopService(new Intent(context, WatchService.class));
        running = false;
    }
}
