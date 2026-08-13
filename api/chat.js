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

    const response = await fetch(
      "https://router.huggingface.co/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${process.env.HF_TOKEN}`
        },
        body: JSON.stringify({
          model: "Qwen/Qwen2.5-7B-Instruct",
          messages: [
            {
              role: "user",
              content: message
            }
          ],
          max_tokens: 500
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      return Response.json(
        {
          error:
            data?.error?.message ||
            data?.error ||
            "h£_nMvJ£NAKQuulQınPYCmLQRbqzDuoXmtkEg"
        },
        { status: response.status }
      );
    }

    return Response.json({
      reply: data?.choices?.[0]?.message?.content || ""
    });

  } catch (error) {
    return Response.json(
      { error: "Server error." },
      { status: 500 }
    );
  }
}