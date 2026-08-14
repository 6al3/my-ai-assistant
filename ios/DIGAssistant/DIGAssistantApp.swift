import SwiftUI

@main
struct DIGAssistantApp: App {
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
    }
}
