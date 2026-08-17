import Foundation
import Combine

private struct OwnerAuthStatus: Decodable {
    let configured: Bool?
    let authenticated: Bool?
    let ok: Bool?
}

private struct OwnerLoginRequest: Encodable {
    let password: String
}

@MainActor
final class OwnerSessionService: ObservableObject {
    @Published private(set) var configured = false
    @Published private(set) var authenticated = false
    @Published private(set) var isLoading = false
    @Published private(set) var error: String?

    func refreshStatus(baseURL: URL) async {
        guard baseURL.scheme?.lowercased() == "https" else {
            authenticated = false
            error = "Owner session requires HTTPS"
            return
        }

        isLoading = true
        defer { isLoading = false }

        do {
            let endpoint = baseURL.appendingPathComponent("api/auth")
            var request = URLRequest(url: endpoint)
            request.httpMethod = "GET"
            request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
            request.timeoutInterval = 10
            request.setValue("no-cache", forHTTPHeaderField: "Cache-Control")

            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse,
                  (200..<300).contains(http.statusCode) else {
                throw URLError(.badServerResponse)
            }

            let decoded = try JSONDecoder().decode(OwnerAuthStatus.self, from: data)
            configured = decoded.configured ?? configured
            authenticated = decoded.authenticated ?? false
            error = nil
        } catch {
            authenticated = false
            self.error = error.localizedDescription
        }
    }

    func login(baseURL: URL, password: String) async -> Bool {
        guard baseURL.scheme?.lowercased() == "https" else {
            authenticated = false
            error = "Owner session requires HTTPS"
            return false
        }
        guard !password.isEmpty else {
            error = "Owner password is required"
            return false
        }

        isLoading = true
        defer { isLoading = false }

        do {
            let endpoint = baseURL.appendingPathComponent("api/auth")
            var request = URLRequest(url: endpoint)
            request.httpMethod = "POST"
            request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
            request.timeoutInterval = 10
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.setValue("no-cache", forHTTPHeaderField: "Cache-Control")
            request.httpBody = try JSONEncoder().encode(OwnerLoginRequest(password: password))

            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                throw URLError(.badServerResponse)
            }
            guard (200..<300).contains(http.statusCode) else {
                authenticated = false
                if http.statusCode == 401 {
                    error = "Owner authentication failed"
                    return false
                }
                throw URLError(.badServerResponse)
            }

            let decoded = try JSONDecoder().decode(OwnerAuthStatus.self, from: data)
            guard decoded.ok == true || decoded.authenticated == true else {
                throw URLError(.cannotParseResponse)
            }

            configured = true
            authenticated = true
            error = nil
            return true
        } catch {
            authenticated = false
            self.error = error.localizedDescription
            return false
        }
    }
}
