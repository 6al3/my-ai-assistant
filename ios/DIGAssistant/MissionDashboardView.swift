import SwiftUI

struct MissionDashboardView: View {
    let baseURL: URL

    @StateObject private var missions = MissionControlPlane()
    @StateObject private var ownerSession = OwnerSessionService()
    @State private var ownerPassword = ""

    var body: some View {
        List {
            Section("الاتصال") {
                LabeledContent("الخادم", value: baseURL.host ?? baseURL.absoluteString)
                LabeledContent("الوضع", value: connectionLabel)
                if let checked = missions.lastChecked {
                    LabeledContent("آخر تحديث", value: checked.formatted(date: .abbreviated, time: .standard))
                }
                if let revision = missions.revision {
                    LabeledContent("Revision", value: String(revision.prefix(12)))
                }

                Button {
                    Task { await refresh() }
                } label: {
                    if missions.isLoading || ownerSession.isLoading {
                        HStack {
                            ProgressView()
                            Text("جاري التحديث")
                        }
                    } else {
                        Label("تحديث الحالة", systemImage: "arrow.clockwise")
                    }
                }
                .disabled(missions.isLoading || ownerSession.isLoading)
            }

            if missions.requiresOwnerSession || !ownerSession.authenticated {
                Section("جلسة المالك") {
                    SecureField("كلمة مرور المالك", text: $ownerPassword)
                        .textContentType(.password)

                    Button("تسجيل جلسة آمنة") {
                        Task {
                            let ok = await ownerSession.login(baseURL: baseURL, password: ownerPassword)
                            ownerPassword = ""
                            if ok {
                                await missions.refresh(baseURL: baseURL)
                            }
                        }
                    }
                    .disabled(ownerPassword.isEmpty || ownerSession.isLoading)

                    Text("كلمة المرور لا تُحفظ في التطبيق. الخادم يعيد جلسة Cookie آمنة، وتبقى شاشة المهام للقراءة فقط.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            if let error = ownerSession.error ?? missions.error {
                Section("الحالة") {
                    Text(error)
                        .foregroundStyle(.red)
                }
            }

            Section("المهام") {
                if missions.missions.isEmpty {
                    Text(missions.isLoading ? "جاري تحميل المهام..." : "لا توجد مهام معروضة")
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(missions.missions) { mission in
                        MissionSummaryRow(mission: mission)
                    }
                }
            }
        }
        .navigationTitle("حالة المهام")
        .task {
            await refresh()
        }
        .refreshable {
            await refresh()
        }
    }

    private var connectionLabel: String {
        if missions.isLoading || ownerSession.isLoading { return "جاري الفحص" }
        if ownerSession.authenticated && missions.error == nil { return "متصل — قراءة فقط" }
        if missions.requiresOwnerSession { return "يتطلب جلسة مالك" }
        return "غير متصل"
    }

    private func refresh() async {
        await ownerSession.refreshStatus(baseURL: baseURL)
        guard ownerSession.authenticated else { return }
        await missions.refresh(baseURL: baseURL)
    }
}

private struct MissionSummaryRow: View {
    let mission: DIGMissionSummary

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(mission.id)
                    .font(.headline)
                    .lineLimit(1)
                Spacer()
                Text(mission.status.uppercased())
                    .font(.caption.bold())
            }

            if let phase = mission.executionPhase, !phase.isEmpty {
                Text("Phase: \(phase)")
                    .font(.subheadline)
            }

            if !mission.requiredCapabilities.isEmpty {
                Text(mission.requiredCapabilities.joined(separator: " • "))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            HStack {
                Text("Attempts \(mission.attempts)/\(mission.maxAttempts)")
                Spacer()
                Text(mission.updatedAt)
                    .lineLimit(1)
            }
            .font(.caption2)
            .foregroundStyle(.secondary)
        }
        .padding(.vertical, 4)
    }
}
