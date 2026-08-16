import http from "node:http";
import { timingSafeEqual, createHash } from "node:crypto";
import { URL } from "node:url";
import { listProjectFiles, readProjectFile, writeProjectFile, createProjectFile } from "./project-files.mjs";

const host = "127.0.0.1";
const port = Number(process.env.BOX_FILE_PORT || 8788);
const ownerToken = String(process.env.OWNER_TOKEN || "");
if (!ownerToken) throw new Error("OWNER_TOKEN is required.");

const ownerTokenDigest = createHash("sha256").update(ownerToken).digest();

function tokenMatches(value) {
  if (typeof value !== "string" || !value.startsWith("Bearer ")) return false;
  const supplied = value.slice(7);
  const digest = createHash("sha256").update(supplied).digest();
  return digest.length === ownerTokenDigest.length && timingSafeEqual(digest, ownerTokenDigest);
}

function json(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer"
  });
  res.end(JSON.stringify(body));
}

async function body(req) {
  const parts = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 3 * 1024 * 1024) throw Object.assign(new Error("Request too large."), { statusCode: 413 });
    parts.push(chunk);
  }
  if (!parts.length) return {};
  try {
    return JSON.parse(Buffer.concat(parts).toString("utf8"));
  } catch {
    throw Object.assign(new Error("Invalid JSON."), { statusCode: 400 });
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (!tokenMatches(req.headers.authorization)) {
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
    const status = Number.isInteger(error?.statusCode) ? error.statusCode :
      error?.code === "ENOENT" ? 404 :
      error?.code === "EEXIST" ? 409 : 400;
    return json(res, status, { error: error?.message || "Request failed." });
  }
});

server.listen(port, host, () => console.log(`DIG file editor listening on http://${host}:${port}`));
