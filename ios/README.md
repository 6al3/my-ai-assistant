# DIG for iPhone

This folder contains the SwiftUI client for the DIG agent room.

## Current iPhone mode

- No Qubes or qrexec connection.
- Face ID / device passcode lock through `SecurityManager`.
- Agent selector: Security Researcher, Coder, System, QA.
- Owner Mode can be enabled only after the local device owner has been verified.
- The app stores only the configured DIG server URL in `UserDefaults`; sensitive owner material should remain in Keychain-backed storage.
- Chat is sent to the configured HTTPS DIG endpoint at `/api/chat`.

## Server

For an iPhone build, configure the app to use an HTTPS deployment that exposes the existing `/api/chat` endpoint, for example a Vercel deployment of this repository branch.

The iPhone cannot use a desktop-only `127.0.0.1` Ollama endpoint through Vercel. The deployed `/api/chat` endpoint therefore needs an AI endpoint reachable from the Vercel runtime. Keep provider credentials in Vercel environment variables, never in the Swift source or repository.

## Build / install

1. Open Xcode on a Mac.
2. Create or open an iOS SwiftUI app target named `DIGAssistant`.
3. Add the Swift files in `ios/DIGAssistant/` to the target.
4. Set a unique Bundle Identifier and your Apple Development Team.
5. Add `NSFaceIDUsageDescription` to the target Info settings, e.g. `DIG uses Face ID to unlock Owner access.`
6. Build to your iPhone over cable/Wi-Fi, or archive and distribute through TestFlight.
7. On first launch, unlock with Face ID, open Settings, and enter the HTTPS DIG deployment URL.

## Readiness gate before Qubes

Do not connect this iPhone mode to Qubes yet. First verify:

- app unlock succeeds and relocks correctly;
- all four agents return responses;
- Owner Mode toggles only after verified device-owner authentication;
- invalid or unreachable server URLs fail cleanly;
- no secrets are committed to the repository;
- normal chat and Owner Mode work after app restart.

After those checks pass, Qubes integration can be treated as a separate transport phase rather than mixed into the iPhone client baseline.
