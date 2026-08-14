import fs from "node:fs/promises";
import path from "node:path";

const root = path.resolve(process.env.PROJECT_ROOT || process.cwd());
const maxFileBytes = 2 * 1024 * 1024;

function resolveInsideRoot(input = "") {
  const clean = String(input).replace(/^\/+/, "");
  const resolved = path.resolve(root, clean);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Path escapes project root.");
  }
  if (relative === ".git" || relative.startsWith(`.git${path.sep}`)) {
    throw new Error(".git internals are not editable from the app.");
  }
  return { resolved, relative: relative || "." };
}

export async function listProjectFiles(relativePath = ".") {
  const { resolved, relative } = resolveInsideRoot(relativePath);
  const entries = await fs.readdir(resolved, { withFileTypes: true });
  const rows = entries
    .filter((entry) => entry.name !== ".git")
    .map((entry) => ({
      name: entry.name,
      path: relative === "." ? entry.name : path.posix.join(relative.split(path.sep).join("/"), entry.name),
      type: entry.isDirectory() ? "directory" : "file"
    }))
    .sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
  return rows;
}

export async function readProjectFile(filePath) {
  const { resolved, relative } = resolveInsideRoot(filePath);
  const stat = await fs.stat(resolved);
  if (!stat.isFile()) throw new Error("Not a file.");
  if (stat.size > maxFileBytes) throw new Error("File is too large for the in-app editor.");
  const content = await fs.readFile(resolved, "utf8");
  return { path: relative.split(path.sep).join("/"), content, bytes: stat.size };
}

export async function writeProjectFile(filePath, content) {
  const { resolved, relative } = resolveInsideRoot(filePath);
  const data = String(content ?? "");
  if (Buffer.byteLength(data, "utf8") > maxFileBytes) throw new Error("File is too large.");
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  await fs.writeFile(resolved, data, "utf8");
  return { path: relative.split(path.sep).join("/"), bytes: Buffer.byteLength(data, "utf8") };
}

export async function createProjectFile(filePath, content = "") {
  const { resolved, relative } = resolveInsideRoot(filePath);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  const handle = await fs.open(resolved, "wx");
  try {
    await handle.writeFile(String(content), "utf8");
  } finally {
    await handle.close();
  }
  return { path: relative.split(path.sep).join("/") };
}

export async function deleteProjectFile(filePath) {
  const { resolved, relative } = resolveInsideRoot(filePath);
  const stat = await fs.stat(resolved);
  if (stat.isDirectory()) {
    await fs.rm(resolved, { recursive: true, force: false });
  } else {
    await fs.unlink(resolved);
  }
  return { path: relative.split(path.sep).join("/") };
}
