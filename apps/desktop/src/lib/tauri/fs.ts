import {
  readTextFile,
  writeTextFile,
  readDir,
  exists,
  mkdir,
  readFile,
  copyFile,
  remove,
  rename,
} from "@tauri-apps/plugin-fs";
import { join } from "@tauri-apps/api/path";
import { convertFileSrc } from "@tauri-apps/api/core";

export interface FsProjectFile {
  relativePath: string;
  absolutePath: string;
  type: "tex" | "image" | "bib";
}

const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".svg",
  ".bmp",
  ".webp",
  ".pdf",
]);

function getFileType(name: string): "tex" | "image" | "bib" | null {
  const lower = name.toLowerCase();
  if (lower.endsWith(".tex")) return "tex";
  if (lower.endsWith(".bib")) return "bib";
  for (const ext of IMAGE_EXTENSIONS) {
    if (lower.endsWith(ext)) return "image";
  }
  return null;
}

export async function scanProjectFolder(
  rootPath: string,
): Promise<FsProjectFile[]> {
  const results: FsProjectFile[] = [];

  async function walk(dir: string, prefix: string) {
    const entries = await readDir(dir);
    for (const entry of entries) {
      const entryPath = await join(dir, entry.name);
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;

      if (entry.isDirectory) {
        // Skip hidden directories and common non-project dirs
        if (entry.name.startsWith(".") || entry.name === "node_modules") {
          continue;
        }
        await walk(entryPath, relativePath);
      } else {
        const type = getFileType(entry.name);
        if (type) {
          results.push({
            relativePath,
            absolutePath: entryPath,
            type,
          });
        }
      }
    }
  }

  await walk(rootPath, "");
  return results;
}

export async function readTexFileContent(
  absolutePath: string,
): Promise<string> {
  return readTextFile(absolutePath);
}

export async function writeTexFileContent(
  absolutePath: string,
  content: string,
): Promise<void> {
  return writeTextFile(absolutePath, content);
}

export async function readImageAsDataUrl(
  absolutePath: string,
): Promise<string> {
  const data = await readFile(absolutePath);
  const ext = absolutePath.split(".").pop()?.toLowerCase() || "png";
  const mimeMap: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    svg: "image/svg+xml",
    bmp: "image/bmp",
    webp: "image/webp",
  };
  const mime = mimeMap[ext] || "image/png";

  let binary = "";
  for (let i = 0; i < data.length; i++) {
    binary += String.fromCharCode(data[i]);
  }
  const base64 = btoa(binary);
  return `data:${mime};base64,${base64}`;
}

export function getAssetUrl(absolutePath: string): string {
  return convertFileSrc(absolutePath);
}

export async function createFileOnDisk(
  rootPath: string,
  name: string,
  content: string,
): Promise<string> {
  const fullPath = await join(rootPath, name);
  // Ensure parent directory exists
  const parentDir = fullPath.substring(0, fullPath.lastIndexOf("/"));
  if (parentDir && !(await exists(parentDir))) {
    await mkdir(parentDir, { recursive: true });
  }
  await writeTextFile(fullPath, content);
  return fullPath;
}

export async function copyFileToProject(
  rootPath: string,
  sourcePath: string,
  targetName: string,
): Promise<string> {
  const fullPath = await join(rootPath, targetName);
  await copyFile(sourcePath, fullPath);
  return fullPath;
}

export async function deleteFileFromDisk(absolutePath: string): Promise<void> {
  await remove(absolutePath);
}

export async function renameFileOnDisk(
  oldPath: string,
  newPath: string,
): Promise<void> {
  await rename(oldPath, newPath);
}

export { exists, join };
