export default async function handler(request) {
  if (request.method !== "POST") {
    return Response.json(
      { error: "Only POST requests are allowed." },
      { status: 405 }
    );
  }

  try {
    const { message } = await request.json();

    if (!message || typeof message !== "string") {
      return Response.json(
        { error: "Message is required." },
        { status: 400 }
      );
    }

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-5.6",
        input: message
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return Response.json(
        { error: data?.error?.message || "OpenAI API error" },
        { status: response.status }
      );
    }

    return Response.json({
      reply: data.output_text || ""
    });

  } catch (error) {
    return Response.json(
      { error: "Server error." },
      { status: 500 }
    );
  }
}