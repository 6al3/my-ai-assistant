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
    @State private var uiError: String?
    @State private var connectionMessage = ""

    var body: some View {
        NavigationStack {
            Group {
                if security.isUnlocked {
                    chatView
                } else {
                    lockedView
                }
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
            if let url = chat.boxURL {
                boxURL = url.absoluteString
            }
            audit.record("app_open")
        }
    }

    private var lockedView: some View {
        VStack(spacing: 20) {
            Image(systemName: "faceid")
                .font(.system(size: 56))

            Text("التطبيق مقفول")
                .font(.title2.bold())

            Text("استخدم Face ID أو رمز الجهاز لفتح جلسة المالك.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)

            if let error = security.lastError, !error.isEmpty {
                errorBanner(error)
            }

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
                Circle()
                    .frame(width: 9, height: 9)
                Text(ownerMode.isActive ? "Owner Mode" : "Private Mode")
                    .font(.caption.bold())
                Spacer()
                Button("مسح المحادثة") {
                    chat.clear()
                    uiError = nil
                    audit.record("chat_cleared")
                }
                .font(.caption)
            }

            VStack(alignment: .leading, spacing: 6) {
                Text("اتصال الـBox")
                    .font(.caption.bold())

                HStack {
                    TextField("https://box.example", text: $boxURL)
                        .textInputAutocapitalization(.never)
                        .keyboardType(.URL)
                        .textFieldStyle(.roundedBorder)
                        .onSubmit(saveBoxURL)

                    Button("حفظ") {
                        saveBoxURL()
                    }
                    .buttonStyle(.bordered)
                }

                if !connectionMessage.isEmpty {
                    Text(connectionMessage)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            if let error = uiError, !error.isEmpty {
                errorBanner(error)
            }

            if ownerMode.isActive {
                ownerPanel
            }

            ScrollView {
                LazyVStack(alignment: .leading, spacing: 10) {
                    if chat.messages.isEmpty {
                        ContentUnavailableView(
                            "لا توجد محادثة بعد",
                            systemImage: "bubble.left.and.bubble.right",
                            description: Text("تأكد من عنوان الـBox ثم اكتب رسالتك بالأسفل.")
                        )
                        .padding(.top, 24)
                    }

                    ForEach(chat.messages) { item in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(item.role == "user" ? "أنت" : "DIG")
                                .font(.caption.bold())
                            Text(item.content)
                                .textSelection(.enabled)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(10)
                        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 12))
                    }
                }
            }

            if chat.isSending {
                HStack(spacing: 8) {
                    ProgressView()
                    Text("جاري إرسال الطلب...")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Spacer()
                }
            }

            HStack(alignment: .bottom) {
                TextField("اكتب أمرك...", text: $input, axis: .vertical)
                    .textFieldStyle(.roundedBorder)
                    .lineLimit(1...6)

                Button("إرسال") {
                    send()
                }
                .disabled(input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || chat.isSending)
            }
        }
        .padding()
    }

    private func errorBanner(_ text: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
            Text(text)
                .font(.caption)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(10)
        .background(.red.opacity(0.12), in: RoundedRectangle(cornerRadius: 10))
        .foregroundStyle(.red)
    }

    private var ownerPanel: some View {
        VStack(spacing: 8) {
            TextField("عنوان خدمة ملفات الـBox", text: $fileBoxURL)
                .textInputAutocapitalization(.never)
                .keyboardType(.URL)
                .textFieldStyle(.roundedBorder)

            SecureField("Owner pairing token", text: $ownerToken)
                .textFieldStyle(.roundedBorder)

            HStack {
                Button("حفظ إعدادات المالك") {
                    UserDefaults.standard.set(fileBoxURL, forKey: "fileBoxURL")
                    OwnerSecretStore.shared.saveToken(ownerToken)
                    audit.record("owner_settings_saved")
                }

                Spacer()

                if let fileURL = URL(string: fileBoxURL), !ownerToken.isEmpty {
                    NavigationLink("ملفات النظام") {
                        FileEditorView(boxURL: fileURL, ownerToken: ownerToken)
                    }
                }
            }
            .font(.caption.bold())
        }
        .padding(10)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 12))
    }

    private func saveBoxURL() {
        guard let url = URL(string: boxURL), ["http", "https"].contains(url.scheme?.lowercased() ?? "") else {
            connectionMessage = ""
            uiError = "عنوان الـBox غير صحيح. استخدم رابط يبدأ بـ http:// أو https://"
            audit.record("box_url_invalid")
            return
        }

        chat.boxURL = url
        uiError = nil
        connectionMessage = "تم حفظ الاتصال: \(url.host ?? url.absoluteString)"
        audit.record("box_url_changed", detail: url.host ?? "")
    }

    private func send() {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }

        guard chat.boxURL != nil else {
            uiError = "احفظ عنوان الـBox أولاً قبل إرسال الرسائل."
            return
        }

        input = ""
        uiError = nil

        let activated = ownerMode.inspect(message: text, ownerVerified: security.ownerVerified)
        if activated {
            audit.record("owner_mode_activated")
        }

        Task {
            do {
                _ = try await chat.send(text, ownerMode: ownerMode.isActive)
                audit.record("message_sent", detail: ownerMode.isActive ? "owner_mode" : "private_mode")
            } catch {
                uiError = readableError(error)
                audit.record("message_failed", detail: error.localizedDescription)
            }
        }
    }

    private func readableError(_ error: Error) -> String {
        if let urlError = error as? URLError {
            switch urlError.code {
            case .badURL:
                return "عنوان الـBox غير صالح."
            case .cannotConnectToHost, .cannotFindHost, .networkConnectionLost, .notConnectedToInternet:
                return "تعذر الاتصال بالـBox. تأكد أن السيرفر يعمل وأن الآيفون يقدر يوصل له."
            case .timedOut:
                return "انتهت مهلة الاتصال بالـBox."
            case .badServerResponse:
                return "الـBox رجّع استجابة غير صحيحة."
            default:
                break
            }
        }
        return error.localizedDescription
    }
}
