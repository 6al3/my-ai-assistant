import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var security: SecurityManager
    @EnvironmentObject private var ownerMode: OwnerModeManager
    @EnvironmentObject private var audit: AuditLogger
    @StateObject private var chat = ChatService()

    @State private var input = ""
    @State private var serverURL = UserDefaults.standard.string(forKey: "digServerURL") ?? ""
    @State private var selectedAgent: DIGAgent = .researcher
    @State private var showSettings = false

    var body: some View {
        NavigationStack {
            Group {
                if security.isUnlocked {
                    chatView
                } else {
                    lockedView
                }
            }
            .navigationTitle("DIG")
            .toolbar {
                if security.isUnlocked {
                    ToolbarItemGroup(placement: .topBarTrailing) {
                        Button {
                            showSettings = true
                        } label: {
                            Image(systemName: "gearshape.fill")
                        }

                        Button("قفل") {
                            audit.record("lock")
                            ownerMode.disable()
                            security.lock()
                        }
                    }
                }
            }
        }
        .sheet(isPresented: $showSettings) {
            settingsView
        }
        .task {
            if let url = chat.serverURL, serverURL.isEmpty {
                serverURL = url.absoluteString
            }
            audit.record("app_open")
        }
    }

    private var lockedView: some View {
        VStack(spacing: 20) {
            Image(systemName: "faceid")
                .font(.system(size: 56))
            Text("DIG مقفول")
                .font(.title2.bold())
            Text("الدخول محمي بـ Face ID أو رمز الجهاز")
                .font(.caption)
                .foregroundStyle(.secondary)

            Button("فتح") {
                Task {
                    let ok = await security.authenticateOwner()
                    audit.record(ok ? "login_success" : "login_failed", detail: security.lastError ?? "")
                }
            }
            .buttonStyle(.borderedProminent)
        }
        .padding()
    }

    private var chatView: some View {
        VStack(spacing: 10) {
            HStack(spacing: 8) {
                Circle()
                    .fill(ownerMode.isActive ? .green : .secondary)
                    .frame(width: 9, height: 9)

                Text(ownerMode.isActive ? "OWNER MODE" : "PRIVATE MODE")
                    .font(.caption.bold())

                Spacer()

                if let model = chat.lastModel {
                    Text(model)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }

                Button("مسح") {
                    chat.clear()
                    audit.record("chat_cleared")
                }
                .font(.caption)
            }

            Picker("Agent", selection: $selectedAgent) {
                ForEach(DIGAgent.allCases) { agent in
                    Text(agent.title).tag(agent)
                }
            }
            .pickerStyle(.menu)
            .frame(maxWidth: .infinity, alignment: .leading)

            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 10) {
                        ForEach(chat.messages) { item in
                            VStack(alignment: .leading, spacing: 4) {
                                Text(item.speaker ?? (item.role == "user" ? "أنت" : "DIG"))
                                    .font(.caption.bold())
                                    .foregroundStyle(.secondary)
                                Text(item.content)
                                    .textSelection(.enabled)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(12)
                            .background(item.role == "user" ? Color.blue.opacity(0.12) : Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 14))
                            .id(item.id)
                        }
                    }
                    .padding(.vertical, 4)
                }
                .onChange(of: chat.messages.count) { _, _ in
                    if let id = chat.messages.last?.id {
                        withAnimation { proxy.scrollTo(id, anchor: .bottom) }
                    }
                }
            }

            if let error = chat.lastError {
                Text(error)
                    .font(.caption2)
                    .foregroundStyle(.red)
                    .lineLimit(3)
            }

            HStack(alignment: .bottom, spacing: 8) {
                TextField("اكتب لـ \(selectedAgent.title)…", text: $input, axis: .vertical)
                    .textFieldStyle(.roundedBorder)
                    .lineLimit(1...6)

                Button {
                    send()
                } label: {
                    if chat.isSending {
                        ProgressView()
                    } else {
                        Image(systemName: "arrow.up.circle.fill")
                            .font(.title2)
                    }
                }
                .disabled(input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || chat.isSending)
            }
        }
        .padding()
    }

    private var settingsView: some View {
        NavigationStack {
            Form {
                Section("الاتصال") {
                    TextField("https://your-project.vercel.app", text: $serverURL)
                        .textInputAutocapitalization(.never)
                        .keyboardType(.URL)

                    Button("حفظ عنوان DIG") {
                        saveServerURL()
                    }
                }

                Section("المالك") {
                    Toggle("Owner Mode", isOn: Binding(
                        get: { ownerMode.isActive },
                        set: { enabled in
                            if enabled {
                                guard security.ownerVerified else { return }
                                ownerMode.enable()
                                audit.record("owner_mode_activated")
                            } else {
                                ownerMode.disable()
                                audit.record("owner_mode_disabled")
                            }
                        }
                    ))
                    Text("Owner Mode يغير أسلوب الإدارة داخل DIG. الدخول نفسه يبقى مرتبطًا بفتح الجهاز الموثق.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Section("الحالة") {
                    LabeledContent("Qubes", value: "غير مربوط")
                    LabeledContent("Agent", value: selectedAgent.title)
                }
            }
            .navigationTitle("إعدادات DIG")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("تم") { showSettings = false }
                }
            }
        }
    }

    private func saveServerURL() {
        let raw = serverURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: raw), url.scheme?.lowercased() == "https" else {
            audit.record("server_url_invalid")
            return
        }
        chat.serverURL = url
        audit.record("server_url_changed", detail: url.host ?? "")
    }

    private func send() {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        guard chat.serverURL != nil else {
            showSettings = true
            return
        }
        input = ""

        Task {
            do {
                _ = try await chat.send(text, agent: selectedAgent, ownerMode: ownerMode.isActive)
                audit.record("message_sent", detail: "\(selectedAgent.rawValue):\(ownerMode.isActive ? "owner" : "private")")
            } catch {
                audit.record("message_failed", detail: error.localizedDescription)
            }
        }
    }
}
