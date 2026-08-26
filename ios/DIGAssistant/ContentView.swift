import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var security: SecurityManager
    @EnvironmentObject private var ownerMode: OwnerModeManager
    @EnvironmentObject private var audit: AuditLogger
    @StateObject private var chat = ChatService()

    @State private var input = ""
    @State private var boxURL = ""
    @State private var fileBoxURL = UserDefaults.standard.string(forKey: "fileBoxURL") ?? "http://127.0.0.1:8788"
    @State private var ownerToken = OwnerSecretStore.shared.loadToken()

    var body: some View {
        NavigationStack {
            Group {
                if security.isUnlocked { chatView } else { lockedView }
            }
            .navigationTitle("DIG Assistant")
            .toolbar {
                if security.isUnlocked {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("قفل") {
                            audit.record("lock")
                            ownerMode.disable()
                            security.lock()
                        }
                    }
                }
            }
        }
        .task {
            if let url = chat.boxURL { boxURL = url.absoluteString }
            audit.record("app_open")
        }
    }

    private var lockedView: some View {
        VStack(spacing: 20) {
            Image(systemName: "faceid").font(.system(size: 56))
            Text("التطبيق مقفول").font(.title2.bold())
            Button("فتح بـ Face ID / رمز الجهاز") {
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
        VStack(spacing: 12) {
            HStack {
                Circle().frame(width: 9, height: 9)
                Text(ownerMode.isActive ? "Owner Mode" : "Private Mode").font(.caption.bold())
                Spacer()
                Button("مسح المحادثة") {
                    chat.clear()
                    audit.record("chat_cleared")
                }.font(.caption)
            }

            Picker("الموديل", selection: $chat.selectedModelId) {
                ForEach(chat.models) { model in
                    Text(model.name).tag(model.id)
                }
            }
            .pickerStyle(.segmented)
            .onChange(of: chat.selectedModelId) { _, value in
                audit.record("model_selected", detail: value)
            }

            Text("المحدد: \(chat.models.first(where: { $0.id == chat.selectedModelId })?.name ?? chat.selectedModelId)")
                .font(.caption)
                .frame(maxWidth: .infinity, alignment: .leading)

            TextField("عنوان الـBox مثل https://box.example", text: $boxURL)
                .textInputAutocapitalization(.never)
                .keyboardType(.URL)
                .textFieldStyle(.roundedBorder)
                .onSubmit(saveBoxURL)

            if ownerMode.isActive { ownerPanel }

            ScrollView {
                LazyVStack(alignment: .leading, spacing: 10) {
                    ForEach(chat.messages) { item in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(item.role == "user" ? "أنت" : "DIG").font(.caption.bold())
                            Text(item.content).textSelection(.enabled)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(10)
                        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 12))
                    }
                }
            }

            HStack(alignment: .bottom) {
                TextField("اكتب أمرك...", text: $input, axis: .vertical).textFieldStyle(.roundedBorder)
                Button("إرسال") { send() }
                    .disabled(input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || chat.isSending)
            }
        }
        .padding()
    }

    private var ownerPanel: some View {
        VStack(spacing: 8) {
            TextField("عنوان خدمة ملفات الـBox", text: $fileBoxURL)
                .textInputAutocapitalization(.never)
                .keyboardType(.URL)
                .textFieldStyle(.roundedBorder)
            SecureField("Owner pairing token", text: $ownerToken).textFieldStyle(.roundedBorder)
            HStack {
                Button("حفظ إعدادات المالك") {
                    UserDefaults.standard.set(fileBoxURL, forKey: "fileBoxURL")
                    OwnerSecretStore.shared.saveToken(ownerToken)
                    audit.record("owner_settings_saved")
                }
                Spacer()
                if let fileURL = URL(string: fileBoxURL), !ownerToken.isEmpty {
                    NavigationLink("ملفات النظام") { FileEditorView(boxURL: fileURL, ownerToken: ownerToken) }
                }
            }
            .font(.caption.bold())
        }
        .padding(10)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 12))
    }

    private func saveBoxURL() {
        guard let url = URL(string: boxURL), ["http", "https"].contains(url.scheme?.lowercased() ?? "") else {
            audit.record("box_url_invalid")
            return
        }
        chat.boxURL = url
        audit.record("box_url_changed", detail: url.host ?? "")
    }

    private func send() {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        input = ""

        let activated = ownerMode.inspect(message: text, ownerVerified: security.ownerVerified)
        if activated { audit.record("owner_mode_activated") }

        Task {
            do {
                _ = try await chat.send(text, ownerMode: ownerMode.isActive)
                audit.record("message_sent", detail: "model=\(chat.selectedModelId),owner_mode=\(ownerMode.isActive)")
            } catch {
                audit.record("message_failed", detail: error.localizedDescription)
            }
        }
    }
}
