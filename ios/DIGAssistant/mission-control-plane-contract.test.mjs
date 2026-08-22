import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('./', import.meta.url);

async function source(name) {
  return readFile(new URL(name, root), 'utf8');
}

test('mission telemetry remains HTTPS-only and read-only', async () => {
  const control = await source('MissionControlPlane.swift');

  assert.match(control, /baseURL\.scheme\?\.lowercased\(\) == "https"/);
  assert.match(control, /appendingPathComponent\("api\/missions"\)/);
  assert.match(control, /request\.httpMethod = "GET"/);
  assert.doesNotMatch(control, /request\.httpMethod = "(?:POST|PUT|PATCH|DELETE)"/);
  assert.doesNotMatch(control, /api\/(?:claim|complete|cancel|retry|dispatch)/i);
});

test('mission telemetry explicitly handles expired owner sessions', async () => {
  const control = await source('MissionControlPlane.swift');

  assert.match(control, /http\.statusCode == 401/);
  assert.match(control, /requiresOwnerSession = true/);
  assert.match(control, /Owner session required/);
});

test('owner session login uses the existing auth endpoint without persisting password', async () => {
  const auth = await source('OwnerSessionService.swift');

  assert.match(auth, /appendingPathComponent\("api\/auth"\)/);
  assert.match(auth, /request\.httpMethod = "POST"/);
  assert.match(auth, /OwnerLoginRequest\(password: password\)/);
  assert.doesNotMatch(auth, /UserDefaults/);
  assert.doesNotMatch(auth, /Keychain|SecItemAdd|SecItemUpdate/);
  assert.doesNotMatch(auth, /Authorization|Bearer/i);
});

test('dashboard clears the typed password after login and exposes no mutation controls', async () => {
  const dashboard = await source('MissionDashboardView.swift');

  assert.match(dashboard, /ownerPassword = ""/);
  assert.match(dashboard, /MissionDashboardView/);
  assert.match(dashboard, /قراءة فقط/);
  assert.doesNotMatch(dashboard, /claim|complete|cancel|retry|dispatch/i);
});

test('owner panel links mission dashboard only for HTTPS base URLs', async () => {
  const content = await source('ContentView.swift');

  assert.match(content, /missionURL\.scheme\?\.lowercased\(\) == "https"/);
  assert.match(content, /MissionDashboardView\(baseURL: missionURL\)/);
});
