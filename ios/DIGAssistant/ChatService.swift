import Foundation

struct ChatMessage: Codable, Identifiable {
    let id: UUID
    let role: String
    let content: String
    let speaker: String?

    init(id: UUID = UUID(), role: String, content: String, speaker: String? = nil) {
        self.id = id
        self.role = role
        self.content = content
        self.speaker = speaker
    }
}

enum DIGAgent: String, CaseIterable, Identifiable {
    case researcher
    case coder
    case system
    case qa

    var id: String { rawValue }

    var title: String {
        switch self {
        case .researcher: return "Security Researcher"
        case .coder: return "Coder"
        case .system: return "System"
        case .qa: return "QA"
        }
    }
}

private struct ChatRequest: Encodable {
    let message: String
    let history: [HistoryItem]
    let ownerMode: Bool
    let agent: String
}

private struct HistoryItem: Encodable {
    let role: String
    let content: String
}

private struct ChatResponse: Decodable {
    let reply: String
    let model: String?
    let agentName: String?
}

@MainActor
final class ChatService: ObservableObject {
    @Published var messages: [ChatMessage] = []
    @Published var isSending = false
    @Published var lastError: String?
    @Published var lastModel: String?

    var serverURL: URL? {
        get {
            guard let raw = UserDefaults.standard.string(forKey: "digServerURL") else { return nil }
            return URL(string: raw)
        }
        set {
            UserDefaults.standard.set(newValue?.absoluteString, forKey: "digServerURL")
        }
    }

    func send(_ text: String, agent: DIGAgent, ownerMode: Bool) async throws -> String {
        guard let base = serverURL else {
            throw URLError(.badURL)
        }

        let history = messages.suffix(32).compactMap { item -> HistoryItem? in
            guard item.role == "user" || item.role == "assistant" else { return nil }
            return HistoryItem(role: item.role, content: item.content)
        }

        let requestBody = ChatRequest(
            message: text,
            history: Array(history),
            ownerMode: ownerMode,
            agent: agent.rawValue
        )
        let endpoint = base.appendingPathComponent("api/chat")

        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 90
        request.httpBody = try JSONEncoder().encode(requestBody)

        isSending = true
        lastError = nil
        defer { isSending = false }

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw URLError(.badServerResponse)
        }

        if !(200..<300).contains(http.statusCode) {
            let message = String(data: data, encoding: .utf8) ?? "HTTP \(http.statusCode)"
            lastError = message
            throw URLError(.badServerResponse)
        }

        let decoded = try JSONDecoder().decode(ChatResponse.self, from: data)
        lastModel = decoded.model
        messages.append(ChatMessage(role: "user", content: text, speaker: "أنت"))
        messages.append(ChatMessage(role: "assistant", content: decoded.reply, speaker: decoded.agentName ?? agent.title))
        return decoded.reply
    }

    func clear() {
        messages.removeAll()
        lastError = nil
    }
}
