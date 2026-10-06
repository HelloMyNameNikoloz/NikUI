package com.nikoloz.nikui.watcher;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.net.Uri;
import android.os.Build;
import android.os.VibrationEffect;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

import org.json.JSONObject;

/**
 * A notification from NikUI, sounding and feeling like the laptop's.
 *
 * The sound is the laptop's own chime — three glassy notes rising, G B D — and
 * the buzz is the same three steps: a pulse on each note, 90 ms apart, each a
 * little longer and, where the phone can do it, a little stronger than the
 * last. So it can be told apart from every other buzz in a pocket.
 *
 * A channel's sound and vibration are fixed once it exists, which is why these
 * are new channels rather than the two the app had before, and why those two
 * are deleted here.
 */
public final class Chime {

    public static final String URGENT = "nikui-chime-urgent";
    public static final String NEWS = "nikui-chime";
    public static final String EXTRA_SESSION = "nikui.session";
    public static final String EXTRA_CONVERSATION = "nikui.conversation";

    // Pulses at 0, 90 and 180 ms — when tools/sound.js strikes each note.
    static final long[] PATTERN = { 0, 50, 40, 60, 30, 160 };
    private static final int[] STRENGTH = { 0, 110, 0, 170, 0, 255 };

    private Chime() {}

    static Uri sound(Context context) {
        return Uri.parse("android.resource://" + context.getPackageName() + "/raw/nikui_done");
    }

    public static void channels(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) return;
        manager.deleteNotificationChannel("nikui-needs-you");
        manager.deleteNotificationChannel("nikui-news");
        make(manager, context, URGENT, "Needs an answer", "An instance is waiting for you, or Slack is",
            NotificationManager.IMPORTANCE_HIGH);
        make(manager, context, NEWS, "Everything else", "Finished turns, CI, failures, the usage limit",
            NotificationManager.IMPORTANCE_DEFAULT);
    }

    private static void make(NotificationManager manager, Context context, String id, String name,
                             String description, int importance) {
        if (manager.getNotificationChannel(id) != null) return;
        NotificationChannel made = new NotificationChannel(id, name, importance);
        made.setDescription(description);
        made.setSound(sound(context), new AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_NOTIFICATION)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build());
        made.enableVibration(true);
        made.setVibrationPattern(PATTERN);
        if (Build.VERSION.SDK_INT >= 36) {
            made.setVibrationEffect(VibrationEffect.createWaveform(PATTERN, STRENGTH, -1));
        }
        made.setLockscreenVisibility(NotificationCompat.VISIBILITY_PRIVATE);
        manager.createNotificationChannel(made);
    }

    /**
     * The same small number the JavaScript makes from a tag (idFor in
     * shell/notify.js), so the same news replaces itself whichever side raised it.
     */
    static int idFor(String tag) {
        String text = tag == null || tag.isEmpty() ? "nikui" : tag;
        long hash = 5381;
        for (int i = 0; i < text.length(); i++) hash = ((hash * 33) ^ text.charAt(i)) & 0xFFFFFFFFL;
        return (int) (hash % 2000000000L) + 1;
    }

    static void post(Context context, JSONObject message) {
        String kind = message.optString("kind", "");
        String title = clip(message.optString("title", "NikUI"), 120);
        String body = clip(message.optString("body", ""), 300);
        String tag = message.optString("tag", "");
        String session = message.optString("session", "");
        String conversation = message.optString("conversation", "");
        // Slack rings the same alarm as needs-you: unseen and waiting is the
        // same state, whichever side it is waiting on.
        boolean urgent = "needs-you".equals(kind) || "slack".equals(kind);
        int id = idFor(tag.isEmpty() ? kind : tag);

        Intent open = new Intent(context, com.nikoloz.nikui.MainActivity.class);
        open.setAction("nikui.open." + id);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (!session.isEmpty()) open.putExtra(EXTRA_SESSION, session);
        if (!conversation.isEmpty()) open.putExtra(EXTRA_CONVERSATION, conversation);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;

        int icon = context.getResources().getIdentifier("ic_stat_nikui", "drawable", context.getPackageName());
        NotificationCompat.Builder built = new NotificationCompat.Builder(context, urgent ? URGENT : NEWS)
            .setSmallIcon(icon != 0 ? icon : context.getApplicationInfo().icon)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setGroup("nikui")
            .setAutoCancel(true)
            .setShowWhen(true)
            .setPriority(urgent ? NotificationCompat.PRIORITY_HIGH : NotificationCompat.PRIORITY_DEFAULT)
            .setSound(sound(context))
            .setVibrate(PATTERN)
            .setContentIntent(PendingIntent.getActivity(context, id, open, flags));
        try {
            NotificationManagerCompat.from(context).notify(id, built.build());
        } catch (SecurityException refused) {
            // Notifications are switched off for this app; nothing here can change that.
        }
    }

    private static String clip(String text, int max) {
        return text.length() > max ? text.substring(0, max) : text;
    }
}
