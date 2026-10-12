import { rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = join(projectRoot, "dist");

if (dirname(distDir) !== projectRoot || basename(distDir) !== "dist") {
  throw new Error(`Refusing to clean unexpected path: ${distDir}`);
}

rmSync(distDir, { recursive: true, force: true });
