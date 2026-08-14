import Foundation

struct DIGAgentStatus: Codable, Identifiable {
    let id: String
    let name: String
    let role: String
    let auto: Bool
    let status: String
}

private struct AgentStatusResponse: Decodable {
    let ok: Bool
    let count: Int
    let agents: [DIGAgentStatus]
    let timestamp: String
}

@MainActor
final class AgentStatusService: ObservableObject {
    @Published var agents: [DIGAgentStatus] = []
    @Published var isLoading = false
    @Published var lastChecked: Date?
    @Published var error: String?

    func refresh(baseURL: URL) async {
        isLoading = true
        defer { isLoading = false }
        do {
            let url = baseURL.appendingPathComponent("api/agents")
            var request = URLRequest(url: url)
            request.timeoutInterval = 10
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                throw URLError(.badServerResponse)
            }
            let decoded = try JSONDecoder().decode(AgentStatusResponse.self, from: data)
            agents = decoded.agents
            lastChecked = Date()
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }
}
