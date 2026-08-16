import Foundation

@MainActor
final class OwnerModeManager: ObservableObject {
    @Published private(set) var isActive = false

    private let trigger = "عزيز"

    func inspect(message: String, ownerVerified: Bool) -> Bool {
        guard ownerVerified else { return false }
        let normalized = message.trimmingCharacters(in: .whitespacesAndNewlines)
        guard normalized.contains(trigger) else { return false }
        isActive = true
        return true
    }

    func enable() {
        isActive = true
    }

    func disable() {
        isActive = false
    }
}
