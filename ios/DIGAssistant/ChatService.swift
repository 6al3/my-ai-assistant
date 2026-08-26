import Foundation

struct ChatMessage: Codable, Identifiable {
    let id: UUID
    let role: String
    let content: String

    init(id: UUID = UUID(), role: String, content: String) {
        self.id = id
        self.role = role
        self.content = content
    }
}

struct ModelOption: Identifiable, Hashable {
    let id: String
    let name: String
}

private struct ChatRequest: Encodable {
    let message: String
    let history: [HistoryItem]
    let ownerMode: Bool
    let modelId: String
}

private struct HistoryItem: Encodable {
    let role: String
    let content: String
}

private struct ChatResponse: Decodable {
    let reply: String
    let model: String?
    let modelId: String?
    let modelName: String?
}

@MainActor
final class ChatService: ObservableObject {
    @Published var messages: [ChatMessage] = []
    @Published var isSending = false
    @Published var lastError: String?
    @Published var selectedModelId = "mini"

    let models: [ModelOption] = [
        ModelOption(id: "mini", name: "GPT-5 mini"),
        ModelOption(id: "maxRed", name: "GPT-5 MAX Red")
    ]

    var boxURL: URL? {
        get {
            guard let raw = UserDefaults.standard.string(forKey: "boxURL") else { return nil }
            return URL(string: raw)
        }
        set {
            UserDefaults.standard.set(newValue?.absoluteString, forKey: "boxURL")
        }
    }

    func send(_ text: String, ownerMode: Bool) async throws -> String {
        guard let base = boxURL else { throw URLError(.badURL) }

        let history = messages.suffix(32).map { HistoryItem(role: $0.role, content: $0.content) }
        let requestBody = ChatRequest(message: text, history: Array(history), ownerMode: ownerMode, modelId: selectedModelId)
        let endpoint = base.appendingPathComponent("api/chat")

        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 60
        request.httpBody = try JSONEncoder().encode(requestBody)

        isSending = true
        defer { isSending = false }

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw URLError(.badServerResponse)
        }

        let decoded = try JSONDecoder().decode(ChatResponse.self, from: data)
        messages.append(ChatMessage(role: "user", content: text))
        messages.append(ChatMessage(role: "assistant", content: decoded.reply))
        return decoded.reply
    }

    func clear() { messages.removeAll() }
}
