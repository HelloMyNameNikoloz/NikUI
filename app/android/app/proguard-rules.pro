# What R8 must not remove, and why.
#
# Capacitor finds a plugin's methods by reflection: the bridge reads the
# @CapacitorPlugin annotation, then looks up @PluginMethod members by name at
# the moment JavaScript calls one. Nothing in the compiled code calls them, so
# without these rules R8 removes them from a release build and every plugin
# fails with "method not implemented" — on a release build only, which is the
# worst possible time to find out.

-keep @com.getcapacitor.annotation.CapacitorPlugin public class * {
    @com.getcapacitor.PluginMethod public <methods>;
}
-keep public class * extends com.getcapacitor.Plugin
-keepclassmembers class * extends com.getcapacitor.Plugin {
    @com.getcapacitor.PluginMethod public <methods>;
}

# Anything the WebView is allowed to call directly.
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# The service that keeps the socket open is started by name from a plugin and
# restarted by the system, both of which are reflection as far as R8 can tell.
-keep class com.nikoloz.nikui.watcher.WatchService { *; }

# Line numbers survive, so a stack trace from a phone is worth reading.
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile
