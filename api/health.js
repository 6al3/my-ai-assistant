export default async function handler(request) {
  if (request.method !== "GET") {
    return Response.json({ error: "Only GET requests are allowed." }, { status: 405 });
  }

  const baseUrl = process.env.AI_BASE_URL || "http://127.0.0.1:11434/v1";
  const model = process.env.AI_MODEL || "local-model";

  return Response.json(
    {
      ok: true,
      service: "my-ai-assistant",
      provider: "self-hosted",
      authRequired: false,
      baseUrl,
      model,
      webAccess: true,
      timestamp: new Date().toISOString()
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
