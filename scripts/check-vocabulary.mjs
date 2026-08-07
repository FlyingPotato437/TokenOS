import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const ignored = new Set([".git", "node_modules", "dist", ".tokenos"]);
const forbidden = [`Snow${"flake"}`, `Cor${"tex"}`];

async function files(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await files(target));
    else found.push(target);
  }
  return found;
}

const offenders = [];
for (const file of await files(process.cwd())) {
  let content;
  try {
    content = await readFile(file, "utf8");
  } catch {
    continue;
  }
  if (forbidden.some((term) => content.toLowerCase().includes(term.toLowerCase()))) {
    offenders.push(path.relative(process.cwd(), file));
  }
}

if (offenders.length) {
  console.error(`Retired product references remain in: ${offenders.join(", ")}`);
  process.exitCode = 1;
} else {
  console.log("Retired integration vocabulary check passed. TokenOS is the product; Raven is the agent service.");
}
