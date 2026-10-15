import { parse as parseToml } from "@iarna/toml";
import path from "node:path";

import type { FrameworkDetectionResult } from "../models.js";
import { readText } from "./utils.js";

export async function detectFrameworks(repoPath: string, files: string[]): Promise<FrameworkDetectionResult> {
  const frameworks = new Set<string>();
  const entrypoints = new Set<string>();
  let packageScripts: Record<string, string> = {};
  const fileSet = new Set(files);

  const packageJson = fileSet.has("package.json") ? await readJsonFile(repoPath, "package.json") : {};
  if (packageJson && Object.keys(packageJson).length > 0) {
    const dependencies = {
      ...objectRecord(packageJson.dependencies),
      ...objectRecord(packageJson.devDependencies),
    };
    packageScripts = objectRecord(packageJson.scripts);
    for (const [name, label] of [
      ["next", "Next.js"],
      ["vite", "Vite"],
      ["react", "React"],
      ["vue", "Vue"],
      ["svelte", "Svelte"],
      ["express", "Express"],
      ["@nestjs/core", "NestJS"],
      ["electron", "Electron"],
    ] as const) {
      if (name in dependencies) {
        frameworks.add(label);
      }
    }
    for (const candidate of ["src/main.ts", "src/main.tsx", "src/index.ts", "src/index.tsx", "index.ts", "server.ts"]) {
      if (fileSet.has(candidate)) {
        entrypoints.add(candidate);
      }
    }
  }

  if (fileSet.has("pyproject.toml")) {
    try {
      const data = parseToml(await readText(repoPath, "pyproject.toml")) as Record<string, unknown>;
      const project = asRecord(data.project);
      const rawDeps = Array.isArray(project.dependencies) ? project.dependencies : [];
      const depsText = rawDeps.map((item) => String(item).toLowerCase()).join("\n");
      for (const [name, label] of [["fastapi", "FastAPI"], ["django", "Django"], ["flask", "Flask"], ["pytest", "pytest"]] as const) {
        if (depsText.includes(name)) {
          frameworks.add(label);
        }
      }
    } catch {
      // Ignore malformed TOML.
    }
  }

  if (fileSet.has("requirements.txt")) {
    const depsText = (await readText(repoPath, "requirements.txt")).toLowerCase();
    for (const [name, label] of [["fastapi", "FastAPI"], ["django", "Django"], ["flask", "Flask"]] as const) {
      if (depsText.includes(name)) {
        frameworks.add(label);
      }
    }
  }

  for (const candidate of ["main.py", "app.py", "manage.py", "src/main.py"]) {
    if (fileSet.has(candidate)) {
      entrypoints.add(candidate);
    }
  }

  if (fileSet.has("go.mod")) {
    frameworks.add("Go module");
    for (const candidate of ["main.go", "cmd/main.go"]) {
      if (fileSet.has(candidate)) {
        entrypoints.add(candidate);
      }
    }
  }

  if (fileSet.has("Cargo.toml")) {
    frameworks.add("Rust crate");
    for (const candidate of ["src/main.rs", "src/lib.rs"]) {
      if (fileSet.has(candidate)) {
        entrypoints.add(candidate);
      }
    }
  }

  if (files.some((file) => [".tf", ".tfvars", ".hcl"].includes(path.extname(file)))) {
    frameworks.add("Terraform/HCL");
    for (const candidate of ["main.tf", "variables.tf", "outputs.tf"]) {
      if (fileSet.has(candidate)) {
        entrypoints.add(candidate);
      }
    }
  }

  return {
    frameworks: [...frameworks].sort(),
    entrypoints: [...entrypoints].sort(),
    packageScripts,
  };
}

async function readJsonFile(repoPath: string, relPath: string): Promise<Record<string, unknown>> {
  const text = await readText(repoPath, relPath);
  if (!text) {
    return {};
  }

  try {
    const data = JSON.parse(text);
    return asRecord(data);
  } catch {
    return {};
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function objectRecord(value: unknown): Record<string, string> {
  return Object.fromEntries(
    Object.entries(asRecord(value)).map(([key, item]) => [String(key), String(item)]),
  );
}
