import { readdirSync, statSync } from "node:fs";
import path from "node:path";

type Rule = { negate: boolean; pattern: string; anchored: boolean };

function parseDockerignore(text: string): Rule[] {
  const rules: Rule[] = [];
  for (const raw of text.split("\n")) {
    let line = raw.replace(/\r$/, "").trim();
    if (!line || line.startsWith("#")) continue;
    let negate = false;
    if (line.startsWith("!")) {
      negate = true;
      line = line.slice(1);
    }
    const anchored = line.startsWith("/");
    if (anchored) line = line.slice(1);
    if (line.endsWith("/")) line = line.slice(0, -1);
    if (!line) continue;
    rules.push({ negate, pattern: line, anchored });
  }
  return rules;
}

function globToRegExp(pattern: string): RegExp {
  let source = "";
  for (let i = 0; i < pattern.length; i += 1) {
    if (pattern.startsWith("**", i)) {
      if (pattern[i + 2] === "/") {
        source += "(?:.*/)?";
        i += 2;
      } else {
        source += ".*";
        i += 1;
      }
      continue;
    }
    const char = pattern[i] ?? "";
    if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else if (".+^${}()|[]\\".includes(char)) source += `\\${char}`;
    else source += char;
  }
  return new RegExp(`^${source}$`);
}

function ruleMatches(rule: Rule, filePath: string): boolean {
  if (!rule.anchored && !rule.pattern.includes("/")) {
    const base = filePath.split("/").pop() ?? filePath;
    return globToRegExp(rule.pattern).test(base);
  }
  return globToRegExp(rule.pattern).test(filePath);
}

/** Last matching pattern wins. A path is included unless a rule excludes it. */
export function dockerignoreIncludes(ignoreText: string, filePath: string): boolean {
  const rules = parseDockerignore(ignoreText);
  const normalized = filePath.replace(/^\.\//, "").replace(/\/+$/, "");
  let included = true;
  for (const rule of rules) {
    if (ruleMatches(rule, normalized)) included = rule.negate;
  }
  return included;
}

function childCouldBeIncluded(dir: string, rules: Rule[]): boolean {
  return rules.some((rule) => {
    if (!rule.negate) return false;
    const concrete = rule.pattern.split("**")[0]?.replace(/\/$/, "") ?? "";
    if (!concrete) return true;
    return concrete === dir || concrete.startsWith(`${dir}/`) || dir.startsWith(`${concrete}/`);
  });
}

/** Files a `docker build` in `root` would send, using the same rules as `.dockerignore`. */
export function listDockerContext(root: string, ignoreText: string): string[] {
  const rules = parseDockerignore(ignoreText);
  const out: string[] = [];
  const walk = (rel: string) => {
    const abs = rel ? path.join(root, rel) : root;
    let names: string[];
    try {
      names = readdirSync(abs);
    } catch {
      return;
    }
    for (const name of names) {
      const child = rel ? `${rel}/${name}` : name;
      let isDir = false;
      try {
        isDir = statSync(path.join(abs, name)).isDirectory();
      } catch {
        continue;
      }
      const included = dockerignoreIncludes(ignoreText, child);
      if (isDir) {
        if (!included && !childCouldBeIncluded(child, rules)) continue;
        walk(child);
        continue;
      }
      if (included) out.push(child);
    }
  };
  walk("");
  return out;
}

const MIGRATION_SQL = /^prisma\/migrations\/[^/]+\/migration\.sql$/;

/** True for a SQL dump or an env file. Prisma migration SQL is the one allowed SQL path. */
export function forbiddenDockerContext(filePath: string): boolean {
  const base = filePath.split("/").pop() ?? filePath;
  if (base === ".env" || base.startsWith(".env.")) return true;
  if (base.endsWith(".sql") && !MIGRATION_SQL.test(filePath)) return true;
  if (base.startsWith("linksnap-") && base.endsWith(".csv")) return true;
  return false;
}
