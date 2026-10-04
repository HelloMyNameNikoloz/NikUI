package com.nikoloz.nikui.watcher;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;

import java.util.HashSet;
import java.util.Set;

/**
 * What the listener needs while the app is not running: where the laptop is,
 * the secret it handed this phone for listening and nothing else, and which
 * kinds of news are wanted. The JavaScript says all three; the service only
 * ever reads them.
 *
 * The secret cannot sign anything, open a socket or send a prompt. The device
 * key that can is in the Keystore, behind a face or a finger, which is exactly
 * why it cannot be used from here.
 */
final class Config {

    private static final String FILE = "nikui.watcher";

    private Config() {}

    private static SharedPreferences prefs(Context context) {
        return context.getApplicationContext().getSharedPreferences(FILE, Context.MODE_PRIVATE);
    }

    static boolean enabled(Context context) { return prefs(context).getBoolean("enabled", false); }
    static String origin(Context context) { return prefs(context).getString("origin", null); }
    static String secret(Context context) { return prefs(context).getString("secret", null); }

    static boolean ready(Context context) {
        return enabled(context) && origin(context) != null && secret(context) != null;
    }

    static void setEnabled(Context context, boolean on) {
        prefs(context).edit().putBoolean("enabled", on).apply();
    }

    /** A different laptop means the old secret is for somebody else. */
    static void setOrigin(Context context, String origin) {
        SharedPreferences.Editor edit = prefs(context).edit();
        if (origin == null || !origin.equals(origin(context))) edit.remove("secret");
        edit.putString("origin", origin).apply();
    }

    static void setSecret(Context context, String secret) {
        prefs(context).edit().putString("secret", secret).commit();
    }

    static void forgetSecret(Context context) {
        prefs(context).edit().remove("secret").commit();
    }

    static void setKinds(Context context, JSONArray kinds) {
        prefs(context).edit().putString("kinds", kinds == null ? "[]" : kinds.toString()).apply();
    }

    static Set<String> kinds(Context context) {
        Set<String> out = new HashSet<>();
        try {
            JSONArray list = new JSONArray(prefs(context).getString("kinds", "[]"));
            for (int i = 0; i < list.length(); i++) out.add(list.getString(i));
        } catch (Exception ignored) { /* nothing wanted */ }
        return out;
    }
}
