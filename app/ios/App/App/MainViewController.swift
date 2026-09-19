import UIKit
import Capacitor

/// Where this app's own plugins are handed to the bridge.
///
/// Android finds a plugin by looking for its annotation; iOS does not. A plugin
/// that lives in the app rather than in a package has to be registered here, by
/// name, or it simply is not there — `window.Capacitor.Plugins` has everything
/// that came from a pod and nothing of ours, and the JavaScript falls back to
/// its browser path without anything having gone wrong that it could report.
///
/// That is exactly how this was found: the app said it would keep its key "here"
/// on an iPhone, which is the wording for the browser fallback, and nothing in
/// any log said why.
///
/// It is instantiated by SceneDelegate, which builds the root view controller
/// itself. Naming this class in Main.storyboard does nothing — nothing reads
/// the storyboard — and that cost an afternoon.
class MainViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(SecureKeyPlugin())
        bridge?.registerPluginInstance(AppleTokenPlugin())
    }
}
