import SwiftUI

@main
struct DIGAssistantApp: App {
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var security = SecurityManager()
    @StateObject private var ownerMode = OwnerModeManager()
    @StateObject private var audit = AuditLogger()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(security)
                .environmentObject(ownerMode)
                .environmentObject(audit)
        }
        .onChange(of: scenePhase) { _, newPhase in
            guard newPhase == .background, security.isUnlocked else { return }
            audit.record("auto_lock_background")
            ownerMode.disable()
            security.lock()
        }
    }
}
