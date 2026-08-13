export default async function handler(request) {
  if (request.method !== "GET") {
    return Response.json(
      { error: "Only GET requests are allowed." },
      { status: 405 }
    );
  }

  const hasToken = Boolean(process.env.HF_TOKEN);
  const model = process.env.MODEL || "Qwen/Qwen2.5-7B-Instruct";
  const debug = process.env.DEBUG === "true";

  return Response.json({
    ok: true,
    service: "my-ai-assistant",
    provider: "huggingface",
    configured: hasToken,
    model,
    debug,
    timestamp: new Date().toISOString()
  });
}
