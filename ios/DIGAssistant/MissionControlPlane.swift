import Foundation
import Combine

struct DIGMissionSummary: Codable, Identifiable, Equatable {
    let id: String
    let status: String
    let executionPhase: String?
    let requiredCapabilities: [String]
    let attempts: Int
    let maxAttempts: Int
    let updatedAt: String
}

private struct MissionSnapshotResponse: Decodable {
    let ok: Bool
    let revision: String
    let missions: [DIGMissionSummary]
}

@MainActor
final class MissionControlPlane: ObservableObject {
    @Published private(set) var missions: [DIGMissionSummary] = []
    @Published private(set) var revision: String?
    @Published private(set) var lastChecked: Date?
    @Published private(set) var isLoading = false
    @Published private(set) var requiresOwnerSession = false
    @Published private(set) var error: String?

    /// Read-only by design. Mutating worker controls must use a separately
    /// authenticated command channel and are intentionally not exposed here.
    func refresh(baseURL: URL) async {
        guard baseURL.scheme?.lowercased() == "https" else {
            requiresOwnerSession = false
            error = "Mission telemetry requires HTTPS"
            return
        }

        isLoading = true
        defer { isLoading = false }

        do {
            let url = baseURL.appendingPathComponent("api/missions")
            var request = URLRequest(url: url)
            request.httpMethod = "GET"
            request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
            request.timeoutInterval = 10
            request.setValue("no-cache", forHTTPHeaderField: "Cache-Control")

            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                throw URLError(.badServerResponse)
            }
            if http.statusCode == 401 {
                requiresOwnerSession = true
                error = "Owner session required"
                return
            }
            guard (200..<300).contains(http.statusCode) else {
                throw URLError(.badServerResponse)
            }

            let decoded = try JSONDecoder().decode(MissionSnapshotResponse.self, from: data)
            guard decoded.ok, !decoded.revision.isEmpty else {
                throw URLError(.cannotParseResponse)
            }

            missions = decoded.missions
            revision = decoded.revision
            lastChecked = Date()
            requiresOwnerSession = false
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }
}
