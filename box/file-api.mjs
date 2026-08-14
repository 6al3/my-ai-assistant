import http from "node:http";
import { URL } from "node:url";
import { listProjectFiles, readProjectFile, writeProjectFile, createProjectFile } from "./project-files.mjs";

const host = "127.0.0.1";
const port = Number(process.env.BOX_FILE_PORT || 8788);
const ownerToken = String(process.env.OWNER_TOKEN || "");
if (!ownerToken) throw new Error("OWNER_TOKEN is required.");

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

async function body(req) {
  const parts = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 3 * 1024 * 1024) throw new Error("Request too large.");
    parts.push(chunk);
  }
  return parts.length ? JSON.parse(Buffer.concat(parts).toString("utf8")) : {};
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.headers.authorization !== `Bearer ${ownerToken}`) {
      return json(res, 401, { error: "Owner authentication required." });
    }

    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && url.pathname === "/files") {
      return json(res, 200, { items: await listProjectFiles(url.searchParams.get("path") || ".") });
    }

    if (req.method === "GET" && url.pathname === "/file") {
      return json(res, 200, await readProjectFile(url.searchParams.get("path") || ""));
    }

    if (req.method === "PUT" && url.pathname === "/file") {
      const data = await body(req);
      return json(res, 200, await writeProjectFile(data.path, data.content));
    }

    if (req.method === "POST" && url.pathname === "/file") {
      const data = await body(req);
      return json(res, 201, await createProjectFile(data.path, data.content || ""));
    }

    return json(res, 404, { error: "Not found." });
  } catch (error) {
    return json(res, 400, { error: error?.message || "Request failed." });
  }
});

server.listen(port, host, () => console.log(`DIG file editor listening on http://${host}:${port}`));
