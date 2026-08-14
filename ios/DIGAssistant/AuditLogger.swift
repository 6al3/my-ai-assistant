import Foundation

struct AuditEvent: Codable, Identifiable {
    let id: UUID
    let timestamp: Date
    let type: String
    let detail: String
}

@MainActor
final class AuditLogger: ObservableObject {
    @Published private(set) var events: [AuditEvent] = []
    private let retentionDays = 30
    private let fileURL: URL

    init() {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        fileURL = base.appendingPathComponent("audit-log.json")
        load()
        purgeExpired()
    }

    func record(_ type: String, detail: String = "") {
        events.append(AuditEvent(id: UUID(), timestamp: Date(), type: type, detail: detail))
        purgeExpired()
        save()
    }

    func purgeExpired() {
        let cutoff = Calendar.current.date(byAdding: .day, value: -retentionDays, to: Date()) ?? .distantPast
        events.removeAll { $0.timestamp < cutoff }
        save()
    }

    func clear() {
        events.removeAll()
        save()
    }

    private func load() {
        guard let data = try? Data(contentsOf: fileURL),
              let decoded = try? JSONDecoder().decode([AuditEvent].self, from: data) else { return }
        events = decoded
    }

    private func save() {
        guard let data = try? JSONEncoder().encode(events) else { return }
        try? data.write(to: fileURL, options: .atomic)
    }
}
