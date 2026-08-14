import Foundation

struct ProjectEntry: Identifiable, Decodable {
    var id: String { path }
    let name: String
    let path: String
    let type: String
}

struct ProjectFilePayload: Decodable {
    let path: String
    let content: String
    let bytes: Int?
}

@MainActor
final class OwnerFileService: ObservableObject {
    @Published var entries: [ProjectEntry] = []
    @Published var currentPath = "."
    @Published var selectedPath = ""
    @Published var content = ""
    @Published var isBusy = false
    @Published var errorMessage: String?

    var boxURL: URL?
    var ownerToken: String = ""

    private func request(path: String, method: String = "GET", body: Data? = nil) throws -> URLRequest {
        guard let boxURL else { throw URLError(.badURL) }
        var url = boxURL
        url.appendPathComponent(path)
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("Bearer \(ownerToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = body
        return request
    }

    func list(_ path: String = ".") async {
        isBusy = true
        defer { isBusy = false }
        do {
            guard var components = URLComponents(url: boxURL?.appendingPathComponent("files") ?? URL(string: "http://invalid")!, resolvingAgainstBaseURL: false) else { throw URLError(.badURL) }
            components.queryItems = [URLQueryItem(name: "path", value: path)]
            guard let url = components.url else { throw URLError(.badURL) }
            var req = URLRequest(url: url)
            req.setValue("Bearer \(ownerToken)", forHTTPHeaderField: "Authorization")
            let (data, response) = try await URLSession.shared.data(for: req)
            try Self.check(response: response, data: data)
            let decoded = try JSONDecoder().decode([String: [ProjectEntry]].self, from: data)
            entries = decoded["items"] ?? []
            currentPath = path
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func open(_ path: String) async {
        isBusy = true
        defer { isBusy = false }
        do {
            guard var components = URLComponents(url: boxURL?.appendingPathComponent("file") ?? URL(string: "http://invalid")!, resolvingAgainstBaseURL: false) else { throw URLError(.badURL) }
            components.queryItems = [URLQueryItem(name: "path", value: path)]
            guard let url = components.url else { throw URLError(.badURL) }
            var req = URLRequest(url: url)
            req.setValue("Bearer \(ownerToken)", forHTTPHeaderField: "Authorization")
            let (data, response) = try await URLSession.shared.data(for: req)
            try Self.check(response: response, data: data)
            let file = try JSONDecoder().decode(ProjectFilePayload.self, from: data)
            selectedPath = file.path
            content = file.content
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func save() async {
        guard !selectedPath.isEmpty else { return }
        await write(path: selectedPath, content: content, create: false)
    }

    func create(path: String, content: String = "") async {
        await write(path: path, content: content, create: true)
    }

    private func write(path: String, content: String, create: Bool) async {
        isBusy = true
        defer { isBusy = false }
        do {
            let payload = try JSONSerialization.data(withJSONObject: ["path": path, "content": content])
            let req = try request(path: "file", method: create ? "POST" : "PUT", body: payload)
            let (data, response) = try await URLSession.shared.data(for: req)
            try Self.check(response: response, data: data)
            errorMessage = nil
            if create { await list(currentPath) }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private static func check(response: URLResponse, data: Data) throws {
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        guard (200...299).contains(http.statusCode) else {
            let message = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
            throw NSError(domain: "DIG.OwnerFiles", code: http.statusCode, userInfo: [NSLocalizedDescriptionKey: message ?? "Request failed"])
        }
    }
}
