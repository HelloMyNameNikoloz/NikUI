package com.nikoloz.nikui.applock;

import android.content.pm.PackageManager;
import android.os.Build;

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

    @PluginMethod
    public void prompt(final PluginCall call) {
        final FragmentActivity activity = getActivity();
        if (activity == null) {
            call.reject("nothing on screen to ask with", "UNAVAILABLE");
            return;
        }
        String reason = call.getString("reason", "Unlock NikUI");

        int verdict = BiometricManager.from(getContext()).canAuthenticate(STRONG);
        if (verdict != BiometricManager.BIOMETRIC_SUCCESS) {
            call.reject(reasonFor(verdict),
                verdict == BiometricManager.BIOMETRIC_ERROR_HW_UNAVAILABLE ? "LOCKED_OUT" : "UNAVAILABLE");
            return;
        }

        final Executor onMain = androidx.core.content.ContextCompat.getMainExecutor(activity);
        activity.runOnUiThread(() -> {
            BiometricPrompt prompt = new BiometricPrompt(activity, onMain,
                new BiometricPrompt.AuthenticationCallback() {
                    @Override
                    public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
                        JSObject out = new JSObject();
                        out.put("ok", true);
                        call.resolve(out);
                    }

                    @Override
                    public void onAuthenticationError(int code, CharSequence said) {
                        if (code == BiometricPrompt.ERROR_USER_CANCELED
                                || code == BiometricPrompt.ERROR_NEGATIVE_BUTTON
                                || code == BiometricPrompt.ERROR_CANCELED) {
                            call.reject("cancelled", "CANCELLED");
                        } else if (code == BiometricPrompt.ERROR_LOCKOUT
                                || code == BiometricPrompt.ERROR_LOCKOUT_PERMANENT) {
                            call.reject("too many tries — use the passcode", "LOCKED_OUT");
                        } else {
                            call.reject(said == null ? "that did not work" : said.toString(), "UNAVAILABLE");
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
                .setSubtitle(reason)
                // The app's own passcode, not the phone's: it is the one that
                // knows how many tries are left and what happens when they run
                // out. Offering the device credential here would be a second way
                // in with none of that behind it.
                .setNegativeButtonText("Use passcode")
                .setAllowedAuthenticators(STRONG)
                .setConfirmationRequired(false)
                .build();

            prompt.authenticate(info);
        });
    }
}
