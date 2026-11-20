import UIKit

/// A synchronous scene window covers SwiftUI sheets and full-screen viewers as
/// soon as the scene becomes inactive, before the app-switcher takes a snapshot.
@MainActor final class PrivacyShield {
    private var windows: [UIWindow] = []
    private var covered = false

    func cover() {
        covered = true
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        for scene in scenes where !windows.contains(where: { $0.windowScene === scene }) {
            let window = UIWindow(windowScene: scene)
            window.windowLevel = .alert + 1
            let controller = UIViewController()
            controller.view.backgroundColor = .systemBackground
            controller.view.accessibilityViewIsModal = true
            let icon = UIImageView(image: UIImage(systemName: "lock.fill"))
            icon.tintColor = .secondaryLabel
            icon.contentMode = .scaleAspectFit
            icon.translatesAutoresizingMaskIntoConstraints = false
            icon.isAccessibilityElement = true
            icon.accessibilityLabel = "NikUI is private"
            controller.view.addSubview(icon)
            NSLayoutConstraint.activate([
                icon.centerXAnchor.constraint(equalTo: controller.view.centerXAnchor),
                icon.centerYAnchor.constraint(equalTo: controller.view.centerYAnchor),
                icon.widthAnchor.constraint(equalToConstant: 44),
                icon.heightAnchor.constraint(equalToConstant: 44),
            ])
            window.rootViewController = controller
            windows.append(window)
        }
        for window in windows { window.isHidden = false }
    }

    func revealAfterUpdate() {
        covered = false
        // Let the gated SwiftUI root commit before exposing the scene again.
        DispatchQueue.main.async { [weak self] in
            guard let self, !self.covered else { return }
            for window in self.windows { window.isHidden = true }
        }
    }
}
