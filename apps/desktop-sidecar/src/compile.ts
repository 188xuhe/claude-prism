import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { mkdir, rm, writeFile, readFile, access, cp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

const MAX_CONCURRENT = 3;
const COMPILE_TIMEOUT_MS = 30000;

let activeCompilations = 0;

function sanitizePath(workDir: string, filePath: string): string | null {
  if (filePath.includes("..")) return null;
  const normalized = resolve(workDir, filePath);
  if (!normalized.startsWith(`${workDir}/`) && normalized !== workDir) {
    return null;
  }
  return normalized;
}

interface Resource {
  path?: string;
  content?: string;
  file?: string;
  main?: boolean;
}

interface CompileRequest {
  compiler?: string;
  resources?: Resource[];
  projectDir?: string;
  mainFile?: string;
}

interface CompileError {
  error: string;
  details?: string;
  log_files?: Record<string, string>;
}

const runWithTimeout = (
  cmd: string[],
  cwd: string,
): Promise<{ exitCode: number; timedOut: boolean }> => {
  return new Promise((resolve) => {
    const [command, ...args] = cmd;
    const proc = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, COMPILE_TIMEOUT_MS);
    proc.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ exitCode: code ?? 1, timedOut });
    });
    proc.on("error", () => {
      clearTimeout(timeout);
      resolve({ exitCode: 1, timedOut: false });
    });
  });
};

export const compileRoutes = new Hono();

compileRoutes.use("/builds/*", bodyLimit({ maxSize: 10 * 1024 * 1024 }));

compileRoutes.get("/", (c) => {
  return c.json({ status: "ok", service: "open-prism-sidecar" });
});

compileRoutes.post("/builds/sync", async (c) => {
  if (activeCompilations >= MAX_CONCURRENT) {
    return c.json(
      { error: "Server busy, try again later" } satisfies CompileError,
      503,
    );
  }

  const body = await c.req.json<CompileRequest>();
  const { compiler = "pdflatex", resources, projectDir, mainFile } = body;

  // Mode 1: Project directory mode (desktop app)
  if (projectDir) {
    return handleProjectDirCompile(c, compiler, projectDir, mainFile || "document.tex");
  }

  // Mode 2: Resource upload mode (legacy/web compatibility)
  if (!resources || resources.length === 0) {
    return c.json(
      { error: "No resources or projectDir provided" } satisfies CompileError,
      400,
    );
  }

  return handleResourceCompile(c, compiler, resources);
});

async function handleProjectDirCompile(
  c: any,
  compiler: string,
  projectDir: string,
  mainFile: string,
) {
  const workDir = join(tmpdir(), `latex-${randomUUID()}`);
  await mkdir(workDir, { recursive: true });

  activeCompilations++;
  try {
    // Copy project to temp dir to avoid polluting with aux files
    await cp(projectDir, workDir, { recursive: true });

    const mainFileName = mainFile.replace(/\.tex$/, "");
    const compilerCmd =
      compiler === "xelatex"
        ? "xelatex"
        : compiler === "lualatex"
          ? "lualatex"
          : "pdflatex";

    // Check for .bib files
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(workDir, { recursive: true });
    const hasBib = files.some((f: string) => f.endsWith(".bib"));

    const latexCmd = [compilerCmd, "-interaction=nonstopmode", mainFile];

    if (hasBib) {
      let result = await runWithTimeout(latexCmd, workDir);
      if (result.timedOut) {
        return c.json({ error: "Compilation timed out" } satisfies CompileError, 500);
      }

      const auxPath = join(workDir, `${mainFileName}.aux`);
      const auxExists = await access(auxPath).then(() => true).catch(() => false);
      if (auxExists) {
        result = await runWithTimeout(["bibtex", mainFileName], workDir);
        if (result.timedOut) {
          return c.json({ error: "BibTeX timed out" } satisfies CompileError, 500);
        }
      }

      for (let i = 0; i < 2; i++) {
        result = await runWithTimeout(latexCmd, workDir);
        if (result.timedOut) {
          return c.json({ error: "Compilation timed out" } satisfies CompileError, 500);
        }
      }
    } else {
      for (let i = 0; i < 2; i++) {
        const result = await runWithTimeout(latexCmd, workDir);
        if (result.timedOut) {
          return c.json({ error: "Compilation timed out" } satisfies CompileError, 500);
        }
      }
    }

    const pdfPath = join(workDir, `${mainFileName}.pdf`);
    const logPath = join(workDir, `${mainFileName}.log`);

    let logContent = "";
    try {
      logContent = await readFile(logPath, "utf-8");
    } catch {}

    try {
      const pdfBuffer = await readFile(pdfPath);
      return new Response(pdfBuffer, {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `inline; filename=${mainFileName}.pdf`,
        },
      });
    } catch {
      return c.json(
        {
          error: "Compilation failed",
          details: extractErrorLines(logContent),
          log_files: { "__main_document__.log": logContent },
        } satisfies CompileError,
        500,
      );
    }
  } finally {
    activeCompilations--;
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

function extractErrorLines(log: string): string {
  if (!log) return "";
  const lines = log.split("\n");
  const errorLines = lines.filter(
    (l) => l.startsWith("!") || l.includes("Error:") || l.includes("error:"),
  );
  return errorLines.slice(0, 10).join("\n") || log.slice(-500);
}

async function handleResourceCompile(
  c: any,
  compiler: string,
  resources: Resource[],
) {
  const mainResource = resources.find((r) => r.main) || resources[0];
  const mainPath = mainResource.path || "main.tex";
  const mainFileName = mainPath.replace(/\.tex$/, "");

  const workDir = join(tmpdir(), `latex-${randomUUID()}`);
  await mkdir(workDir, { recursive: true });

  activeCompilations++;
  try {
    const hasBib = resources.some((r) => r.path?.endsWith(".bib"));

    for (const resource of resources) {
      const filePath =
        resource.path || (resource.main ? "main.tex" : `file-${randomUUID()}`);
      const fullPath = sanitizePath(workDir, filePath);

      if (!fullPath) {
        return c.json({ error: "Invalid path" } satisfies CompileError, 400);
      }

      const parentDir = fullPath.substring(0, fullPath.lastIndexOf("/"));
      if (parentDir && parentDir !== workDir) {
        await mkdir(parentDir, { recursive: true });
      }

      if (resource.file) {
        const buffer = Buffer.from(resource.file, "base64");
        await writeFile(fullPath, buffer);
      } else if (resource.content) {
        await writeFile(fullPath, resource.content, "utf-8");
      }
    }

    const compilerCmd =
      compiler === "xelatex"
        ? "xelatex"
        : compiler === "lualatex"
          ? "lualatex"
          : "pdflatex";

    const latexCmd = [compilerCmd, "-interaction=nonstopmode", mainPath];

    if (hasBib) {
      let result = await runWithTimeout(latexCmd, workDir);
      if (result.timedOut) {
        return c.json({ error: "Compilation timed out" } satisfies CompileError, 500);
      }

      const auxPath = join(workDir, `${mainFileName}.aux`);
      const auxExists = await access(auxPath).then(() => true).catch(() => false);
      if (auxExists) {
        result = await runWithTimeout(["bibtex", mainFileName], workDir);
        if (result.timedOut) {
          return c.json({ error: "BibTeX timed out" } satisfies CompileError, 500);
        }
      }

      for (let i = 0; i < 2; i++) {
        result = await runWithTimeout(latexCmd, workDir);
        if (result.timedOut) {
          return c.json({ error: "Compilation timed out" } satisfies CompileError, 500);
        }
      }
    } else {
      for (let i = 0; i < 2; i++) {
        const result = await runWithTimeout(latexCmd, workDir);
        if (result.timedOut) {
          return c.json({ error: "Compilation timed out" } satisfies CompileError, 500);
        }
      }
    }

    const pdfPath = join(workDir, `${mainFileName}.pdf`);
    const logPath = join(workDir, `${mainFileName}.log`);

    let logContent = "";
    try {
      logContent = await readFile(logPath, "utf-8");
    } catch {}

    try {
      const pdfBuffer = await readFile(pdfPath);
      return new Response(pdfBuffer, {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `inline; filename=${mainFileName}.pdf`,
        },
      });
    } catch {
      return c.json(
        {
          error: "Compilation failed",
          details: extractErrorLines(logContent),
          log_files: { "__main_document__.log": logContent },
        } satisfies CompileError,
        500,
      );
    }
  } finally {
    activeCompilations--;
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
