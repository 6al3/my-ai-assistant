import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const root = path.resolve(process.env.PROJECT_ROOT || process.cwd());
const maxFileBytes = 2 * 1024 * 1024;

function lexicalPath(input = "") {
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

async function canonicalRoot() {
  return fs.realpath(root);
}

function assertWithin(base, candidate) {
  const relative = path.relative(base, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Resolved path escapes project root.");
  }
}

async function assertNoSymlinkSegments(relative, { allowMissingTail = false } = {}) {
  if (relative === ".") return;
  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw new Error("Symbolic links are not allowed in editable paths.");
    } catch (error) {
      if (error?.code === "ENOENT" && allowMissingTail) return;
      throw error;
    }
  }
}

async function validateResolvedPath(input, { allowMissingTail = false } = {}) {
  const candidate = lexicalPath(input);
  const base = await canonicalRoot();
  assertWithin(base, await fs.realpath(root));
  await assertNoSymlinkSegments(candidate.relative, { allowMissingTail });

  if (!allowMissingTail) {
    const real = await fs.realpath(candidate.resolved);
    assertWithin(base, real);
    return { ...candidate, real };
  }

  let ancestor = candidate.resolved;
  while (true) {
    try {
      const real = await fs.realpath(ancestor);
      assertWithin(base, real);
      break;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
  return candidate;
}

async function atomicWrite(existingPath, data) {
  const dir = path.dirname(existingPath);
  const temp = path.join(dir, `.dig-write-${process.pid}-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fs.open(temp, "wx", 0o600);
    await handle.writeFile(data, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temp, existingPath);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fs.unlink(temp).catch(() => {});
  }
}

export async function listProjectFiles(relativePath = ".") {
  const { resolved, relative } = await validateResolvedPath(relativePath);
  const stat = await fs.lstat(resolved);
  if (!stat.isDirectory()) throw new Error("Not a directory.");

  const entries = await fs.readdir(resolved, { withFileTypes: true });
  const rows = entries
    .filter((entry) => entry.name !== ".git" && !entry.isSymbolicLink())
    .map((entry) => ({
      name: entry.name,
      path: relative === "." ? entry.name : path.posix.join(relative.split(path.sep).join("/"), entry.name),
      type: entry.isDirectory() ? "directory" : "file"
    }))
    .sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
  return rows;
}

export async function readProjectFile(filePath) {
  const { resolved, relative } = await validateResolvedPath(filePath);
  const stat = await fs.lstat(resolved);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Not an editable file.");
  if (stat.size > maxFileBytes) throw new Error("File is too large for the in-app editor.");
  const content = await fs.readFile(resolved, "utf8");
  return { path: relative.split(path.sep).join("/"), content, bytes: stat.size };
}

export async function writeProjectFile(filePath, content) {
  const { resolved, relative } = await validateResolvedPath(filePath);
  const stat = await fs.lstat(resolved);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Target must be an existing regular file.");

  const data = String(content ?? "");
  const bytes = Buffer.byteLength(data, "utf8");
  if (bytes > maxFileBytes) throw new Error("File is too large.");
  await atomicWrite(resolved, data);
  return { path: relative.split(path.sep).join("/"), bytes };
}

export async function createProjectFile(filePath, content = "") {
  const { resolved, relative } = await validateResolvedPath(filePath, { allowMissingTail: true });
  if (relative === ".") throw new Error("Cannot create over the project root.");

  const data = String(content ?? "");
  const bytes = Buffer.byteLength(data, "utf8");
  if (bytes > maxFileBytes) throw new Error("File is too large.");

  const parent = path.dirname(resolved);
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  await validateResolvedPath(path.relative(root, parent));

  const handle = await fs.open(resolved, "wx", 0o600);
  try {
    await handle.writeFile(data, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  return { path: relative.split(path.sep).join("/"), bytes };
}

export async function deleteProjectFile(filePath) {
  const { resolved, relative } = await validateResolvedPath(filePath);
  if (relative === ".") throw new Error("Project root cannot be deleted.");

  const stat = await fs.lstat(resolved);
  if (stat.isSymbolicLink()) throw new Error("Symbolic links cannot be deleted through this API.");
  if (stat.isDirectory()) {
    throw new Error("Recursive directory deletion is disabled.");
  }
  if (!stat.isFile()) throw new Error("Unsupported file type.");
  await fs.unlink(resolved);
  return { path: relative.split(path.sep).join("/") };
}
