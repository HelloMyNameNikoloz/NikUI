package com.nikoloz.nikui;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;
import com.nikoloz.nikui.securekey.SecureKeyPlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // This app's own plugin, and the only one not installed from a package:
        // the key in the Keystore. Registered before the bridge starts, or the
        // first page would look for it and conclude the phone has no chip.
        registerPlugin(SecureKeyPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
