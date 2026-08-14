const SYSTEM_PROMPT = `You are a helpful AI assistant for the owner of this application. Be concise, practical, and accurate. Follow the user's current request while respecting applicable safety and platform requirements.`;

export default async function handler(request) {
  if (request.method !== "POST") {
    return Response.json({ error: "Only POST requests are allowed." }, { status: 405 });
  }

  try {
    const contentType = request.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      return Response.json({ error: "Content-Type must be application/json." }, { status: 415 });
    }

    const { message } = await request.json();
    if (!message || typeof message !== "string") {
      return Response.json({ error: "Message is required." }, { status: 400 });
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return Response.json({ error: "OPENAI_API_KEY is not configured." }, { status: 500 });
    }

    const model = process.env.OPENAI_MODEL || "gpt-5";

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        input: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: message }
        ],
        store: false
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return Response.json(
        { error: data?.error?.message || "OpenAI request failed." },
        { status: 502 }
      );
    }

    const reply =
      data?.output_text ||
      data?.output?.flatMap(item => item?.content || []).find(part => part?.type === "output_text")?.text ||
      "";

    return Response.json({ reply });
  } catch (error) {
    return Response.json(
      { error: error?.message || "Server error." },
      { status: 500 }
    );
  }
}
