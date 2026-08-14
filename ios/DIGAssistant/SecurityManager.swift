import Foundation
import LocalAuthentication

@MainActor
final class SecurityManager: ObservableObject {
    @Published private(set) var isUnlocked = false
    @Published private(set) var ownerVerified = false
    @Published private(set) var lastError: String?

    func authenticateOwner() async -> Bool {
        let context = LAContext()
        var error: NSError?

        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
            lastError = error?.localizedDescription ?? "Device authentication is unavailable."
            return false
        }

        do {
            let ok = try await context.evaluatePolicy(
                .deviceOwnerAuthentication,
                localizedReason: "Unlock your private DIG assistant"
            )
            isUnlocked = ok
            ownerVerified = ok
            lastError = nil
            return ok
        } catch {
            isUnlocked = false
            ownerVerified = false
            lastError = error.localizedDescription
            return false
        }
    }

    func lock() {
        isUnlocked = false
        ownerVerified = false
    }
}
