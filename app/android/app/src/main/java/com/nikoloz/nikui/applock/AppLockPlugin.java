package com.nikoloz.nikui.applock;

import android.content.pm.PackageManager;
import android.os.Build;
import android.view.View;
import android.view.ViewTreeObserver;

import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.fragment.app.FragmentActivity;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.concurrent.Executor;

/**
 * Proving it is you, in order to open the app.
 *
 * Deliberately not part of SecureKeyPlugin, which is about a key: that one
 * answers "sign this" and the Keystore decides whether to, and the biometric
 * check is a property of the key itself. This answers a different question —
 * "is the person holding the phone the person it belongs to" — and the answer
 * is worth nothing cryptographically. It gates a screen, not a signature.
 *
 * One thing Android does not let an app do, and it is worth saying plainly
 * rather than pretending: it cannot ask for a finger rather than a face.
 * BiometricPrompt takes a *strength* — and BIOMETRIC_STRONG is what a lock
 * should ask for — and the system then offers whatever is enrolled, in the
 * order the phone's own settings say. What this reports is which hardware is
 * fitted, so the screen can at least use the right word.
 */
@CapacitorPlugin(name = "AppLock")
public class AppLockPlugin extends Plugin {

    private static final int STRONG = BiometricManager.Authenticators.BIOMETRIC_STRONG;

    @PluginMethod
    public void available(PluginCall call) {
        BiometricManager manager = BiometricManager.from(getContext());
        int verdict = manager.canAuthenticate(STRONG);
        PackageManager packages = getContext().getPackageManager();

        boolean finger = packages.hasSystemFeature(PackageManager.FEATURE_FINGERPRINT);
        boolean face = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
            && packages.hasSystemFeature(PackageManager.FEATURE_FACE);

        JSObject out = new JSObject();
        out.put("available", verdict == BiometricManager.BIOMETRIC_SUCCESS);
        // Fingerprint wins the naming when a phone has both, because that is
        // what most Android phones actually use and what the person expects the
        // screen to say. It is a word, not a choice: see the note above.
        out.put("kind", finger ? "finger" : face ? "face" : "none");
        out.put("finger", finger);
        out.put("face", face);
        out.put("enrolled", verdict != BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED);
        out.put("reason", reasonFor(verdict));
        call.resolve(out);
    }

    private String reasonFor(int verdict) {
        switch (verdict) {
            case BiometricManager.BIOMETRIC_SUCCESS:
                return "";
            case BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED:
                return "no fingerprint or face is set up on this phone";
            case BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE:
                return "this phone cannot check a fingerprint or a face";
            case BiometricManager.BIOMETRIC_ERROR_HW_UNAVAILABLE:
                return "the sensor is busy — use the passcode";
            default:
                return "this phone will not check a fingerprint right now";
        }
    }

    // One prompt on screen at a time. Every screen of the app is its own page,
    // so a page that loads while the prompt is up asks again: that ask takes
    // over the prompt already showing rather than putting up a second one,
    // which is what used to dismiss the first and drop straight to the keypad.
    private BiometricPrompt showing;
    private PluginCall waiting;
    private ViewTreeObserver.OnWindowFocusChangeListener focusWait;

    @PluginMethod
    public void prompt(final PluginCall call) {
        final FragmentActivity activity = getActivity();
        if (activity == null) {
            call.reject("nothing on screen to ask with", "UNAVAILABLE");
            return;
        }
        int verdict = BiometricManager.from(getContext()).canAuthenticate(STRONG);
        if (verdict != BiometricManager.BIOMETRIC_SUCCESS) {
            call.reject(reasonFor(verdict),
                verdict == BiometricManager.BIOMETRIC_ERROR_HW_UNAVAILABLE ? "LOCKED_OUT" : "UNAVAILABLE");
            return;
        }
        activity.runOnUiThread(() -> {
            PluginCall before = waiting;
            waiting = call;
            if (before != null) before.reject("asked again", "REPLACED");
            if (showing != null || focusWait != null) return;
            whenFocused(activity);
        });
    }

    /** Stop asking: the passcode got there first. */
    @PluginMethod
    public void cancel(PluginCall call) {
        FragmentActivity activity = getActivity();
        if (activity != null) activity.runOnUiThread(() -> {
            PluginCall was = waiting;
            waiting = null;
            if (focusWait != null) {
                activity.getWindow().getDecorView().getViewTreeObserver().removeOnWindowFocusChangeListener(focusWait);
                focusWait = null;
            }
            if (showing != null) showing.cancelAuthentication();
            showing = null;
            if (was != null) was.reject("cancelled", "CANCELLED");
        });
        call.resolve();
    }

    // A prompt put up before the window is really on screen — the app still
    // opening, or coming back from behind something — is taken down again by
    // Android as the window settles, a moment after it appeared. So it waits
    // until the window has focus, and appears once it does.
    private void whenFocused(FragmentActivity activity) {
        View root = activity.getWindow().getDecorView();
        if (root.hasWindowFocus()) {
            show(activity);
            return;
        }
        focusWait = (has) -> {
            if (!has || focusWait == null) return;
            ViewTreeObserver.OnWindowFocusChangeListener was = focusWait;
            focusWait = null;
            root.post(() -> {
                root.getViewTreeObserver().removeOnWindowFocusChangeListener(was);
                if (waiting != null && showing == null) show(activity);
            });
        };
        root.getViewTreeObserver().addOnWindowFocusChangeListener(focusWait);
    }

    private void settle(boolean ok, String message, String code) {
        showing = null;
        PluginCall call = waiting;
        waiting = null;
        if (call == null) return;
        if (ok) {
            JSObject out = new JSObject();
            out.put("ok", true);
            call.resolve(out);
        } else {
            call.reject(message, code);
        }
    }

    private void show(FragmentActivity activity) {
        final Executor onMain = androidx.core.content.ContextCompat.getMainExecutor(activity);
        showing = new BiometricPrompt(activity, onMain,
            new BiometricPrompt.AuthenticationCallback() {
                @Override
                public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
                    settle(true, null, null);
                }

                @Override
                public void onAuthenticationError(int code, CharSequence said) {
                    if (code == BiometricPrompt.ERROR_USER_CANCELED
                            || code == BiometricPrompt.ERROR_NEGATIVE_BUTTON) {
                        settle(false, "cancelled", "CANCELLED");
                    } else if (code == BiometricPrompt.ERROR_CANCELED) {
                        // Taken down by the system rather than by them: the app
                        // went behind something, the screen went off. Not a
                        // choice, so not counted as one — the screen asks again
                        // when it is looked at.
                        settle(false, "interrupted", "INTERRUPTED");
                    } else if (code == BiometricPrompt.ERROR_LOCKOUT
                            || code == BiometricPrompt.ERROR_LOCKOUT_PERMANENT) {
                        settle(false, "too many tries — use the passcode", "LOCKED_OUT");
                    } else {
                        settle(false, said == null ? "that did not work" : said.toString(), "UNAVAILABLE");
                    }
                }

                // A finger that did not match is not the end of the attempt:
                // the system lets them try again on the same prompt, and the
                // screen only counts the times the prompt comes back.
                @Override
                public void onAuthenticationFailed() { }
            });

        BiometricPrompt.PromptInfo info = new BiometricPrompt.PromptInfo.Builder()
            .setTitle("Unlock NikUI")
            // The app's own passcode, not the phone's: it is the one that
            // knows how many tries are left and what happens when they run
            // out. Offering the device credential here would be a second way
            // in with none of that behind it.
            .setNegativeButtonText("Use passcode")
            .setAllowedAuthenticators(STRONG)
            .setConfirmationRequired(false)
            .build();

        showing.authenticate(info);
    }
}
