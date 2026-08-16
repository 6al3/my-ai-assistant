import Foundation
import LocalAuthentication

@MainActor
final class SecurityManager: ObservableObject {
    @Published private(set) var isUnlocked = false
    @Published private(set) var ownerVerified = false
    @Published var lastError: String?

    func authenticateOwner() async -> Bool {
        let context = LAContext()
        context.localizedCancelTitle = "إلغاء"

        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
            lastError = error?.localizedDescription ?? "تعذر استخدام مصادقة الجهاز"
            return false
        }

        do {
            let ok = try await context.evaluatePolicy(
                .deviceOwnerAuthentication,
                localizedReason: "افتح DIG بصفتك مالك الجهاز"
            )
            isUnlocked = ok
            ownerVerified = ok
            lastError = nil
            return ok
        } catch {
            lastError = error.localizedDescription
            return false
        }
    }

    func lock() {
        isUnlocked = false
        ownerVerified = false
    }
}
