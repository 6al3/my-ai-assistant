import SwiftUI

struct FileEditorView: View {
    @EnvironmentObject private var audit: AuditLogger
    @StateObject private var files = OwnerFileService()

    let boxURL: URL?
    let ownerToken: String

    @State private var newPath = ""
    @State private var showingNewFile = false

    var body: some View {
        VStack(spacing: 10) {
            HStack {
                Text(files.currentPath)
                    .font(.caption.monospaced())
                    .lineLimit(1)
                Spacer()
                Button("جديد") { showingNewFile = true }
                Button("تحديث") { Task { await files.list(files.currentPath) } }
            }

            if let error = files.errorMessage {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
            }

            if files.selectedPath.isEmpty {
                List(files.entries) { entry in
                    Button {
                        Task {
                            if entry.type == "directory" {
                                await files.list(entry.path)
                            } else {
                                await files.open(entry.path)
                                audit.record("owner_file_opened", detail: entry.path)
                            }
                        }
                    } label: {
                        HStack {
                            Image(systemName: entry.type == "directory" ? "folder" : "doc.text")
                            Text(entry.name)
                            Spacer()
                        }
                    }
                }
            } else {
                HStack {
                    Button("رجوع") { files.selectedPath = "" }
                    Spacer()
                    Text(files.selectedPath)
                        .font(.caption.monospaced())
                        .lineLimit(1)
                }

                TextEditor(text: $files.content)
                    .font(.system(.body, design: .monospaced))
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(.secondary.opacity(0.25)))

                Button("حفظ التعديل") {
                    Task {
                        await files.save()
                        if files.errorMessage == nil {
                            audit.record("owner_file_saved", detail: files.selectedPath)
                        }
                    }
                }
                .buttonStyle(.borderedProminent)
            }
        }
        .padding()
        .navigationTitle("ملفات النظام")
        .onAppear {
            files.boxURL = boxURL
            files.ownerToken = ownerToken
            Task { await files.list() }
        }
        .sheet(isPresented: $showingNewFile) {
            NavigationStack {
                Form {
                    TextField("المسار مثل notes/test.txt", text: $newPath)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }
                .navigationTitle("ملف جديد")
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("إلغاء") { showingNewFile = false }
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("إنشاء") {
                            let path = newPath.trimmingCharacters(in: .whitespacesAndNewlines)
                            guard !path.isEmpty else { return }
                            Task {
                                await files.create(path: path)
                                if files.errorMessage == nil {
                                    audit.record("owner_file_created", detail: path)
                                    newPath = ""
                                    showingNewFile = false
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
