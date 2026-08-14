export default async function handler(request) {
  if (request.method !== "GET") {
    return Response.json({ error: "Only GET requests are allowed." }, { status: 405 });
  }

  return Response.json(
    {
      ok: true,
      service: "my-ai-assistant",
      provider: "openai",
      configured: Boolean(process.env.OPENAI_API_KEY),
      model: process.env.OPENAI_MODEL || "gpt-5",
      timestamp: new Date().toISOString()
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
