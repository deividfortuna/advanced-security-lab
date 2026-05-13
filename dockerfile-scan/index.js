#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { DockerfileParser } = require("dockerfile-ast");
const {
  SarifBuilder,
  SarifRunBuilder,
  SarifRuleBuilder,
  SarifResultBuilder,
} = require("node-sarif-builder");

const RULE_ID = "TEST_CHAINGUARD_1";
const RULE_NAME = "Ensure Docker base images come from Chainguard";
const CHAINGUARD_REGEX = /^(--platform=[^ ]+\s+)?(cgr\.dev\/chainguard\/|chainguard\/).+/;

const TOOL_NAME = "dockerfile-scan";
const TOOL_VERSION = require("./package.json").version;

function parseArgs(argv) {
  const args = {
    directory: process.env.INPUT_DIRECTORY || ".",
    output: process.env.INPUT_OUTPUT || "results.sarif",
    failOnFindings:
      (process.env.INPUT_FAIL_ON_FINDINGS || "false").toLowerCase() === "true",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-d" || a === "--directory") {
      args.directory = argv[++i];
    } else if (a === "-o" || a === "--output") {
      args.output = argv[++i];
    } else if (a === "--fail-on-findings") {
      args.failOnFindings = true;
    } else if (a === "-h" || a === "--help") {
      args.help = true;
    } else {
      args.directory = a;
    }
  }
  return args;
}

function appendFile(envVar, text) {
  const target = process.env[envVar];
  if (!target) return;
  try {
    fs.appendFileSync(target, text);
  } catch {}
}

function emitWorkflowAnnotation(fileUri, v) {
  if (!process.env.GITHUB_ACTIONS) return;
  const msg = `${RULE_ID}: base image "${v.value}" is not from Chainguard (cgr.dev/chainguard/ or chainguard/).`;
  process.stdout.write(
    `::warning file=${fileUri},line=${v.startLine},col=${v.startColumn},endLine=${v.endLine},endColumn=${v.endColumn},title=${RULE_ID}::${msg}\n`,
  );
}

function isDockerfile(name) {
  return (
    name === "Dockerfile" ||
    name.endsWith(".Dockerfile") ||
    name.startsWith("Dockerfile.")
  );
}

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".github",
  ".checkov",
  "dist",
  "build",
  ".cache",
]);

function findDockerfiles(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(full);
      } else if (entry.isFile() && isDockerfile(entry.name)) {
        out.push(full);
      }
    }
  }
  return out.sort();
}

function scanFile(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  const dockerfile = DockerfileParser.parse(content);
  const violations = [];

  for (const from of dockerfile.getFROMs()) {
    const value = from.getArgumentsContent();
    if (value === null) continue;
    const normalized = value.replace(/\s+/g, " ").trim();
    if (CHAINGUARD_REGEX.test(normalized)) continue;

    const range = from.getImageRange() || from.getRange();
    violations.push({
      value: normalized,
      startLine: range.start.line + 1,
      startColumn: range.start.character + 1,
      endLine: range.end.line + 1,
      endColumn: range.end.character + 1,
    });
  }

  return violations;
}

function toFileUri(filePath, root) {
  const rel = path.relative(root, filePath);
  return rel.split(path.sep).join("/");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(
      `Usage: dockerfile-scan [-d <dir>] [-o <output.sarif>]\n` +
        `  Scans Dockerfiles for ${RULE_ID}: base images must come from Chainguard.\n`,
    );
    return 0;
  }

  const root = path.resolve(args.directory);
  const files = findDockerfiles(root);

  const sarifBuilder = new SarifBuilder();
  const runBuilder = new SarifRunBuilder().initSimple({
    toolDriverName: TOOL_NAME,
    toolDriverVersion: TOOL_VERSION,
  });

  runBuilder.addRule(
    new SarifRuleBuilder().initSimple({
      ruleId: RULE_ID,
      shortDescriptionText: RULE_NAME,
      fullDescriptionText:
        "FROM instructions must reference images published under cgr.dev/chainguard/ or chainguard/.",
    }),
  );

  let totalViolations = 0;
  for (const file of files) {
    let violations;
    try {
      violations = scanFile(file);
    } catch (err) {
      process.stderr.write(`Failed to parse ${file}: ${err.message}\n`);
      continue;
    }
    const fileUri = toFileUri(file, root);
    for (const v of violations) {
      totalViolations++;
      runBuilder.addResult(
        new SarifResultBuilder().initSimple({
          level: "warning",
          ruleId: RULE_ID,
          messageText: `Base image "${v.value}" is not from Chainguard (cgr.dev/chainguard/ or chainguard/).`,
          fileUri,
          startLine: v.startLine,
          startColumn: v.startColumn,
          endLine: v.endLine,
          endColumn: v.endColumn,
        }),
      );
      process.stdout.write(
        `${fileUri}:${v.startLine}:${v.startColumn} ${RULE_ID} ${v.value}\n`,
      );
      emitWorkflowAnnotation(fileUri, v);
    }
  }

  sarifBuilder.addRun(runBuilder);
  const outPath = path.resolve(args.output);
  sarifBuilder.generateSarifFileSync(outPath);

  process.stdout.write(
    `Scanned ${files.length} Dockerfile(s); ${totalViolations} violation(s). SARIF written to ${outPath}\n`,
  );

  appendFile(
    "GITHUB_OUTPUT",
    `sarif-file=${outPath}\nviolations=${totalViolations}\nfiles-scanned=${files.length}\n`,
  );
  appendFile(
    "GITHUB_STEP_SUMMARY",
    `## ${RULE_ID} — ${RULE_NAME}\n\n` +
      `- Files scanned: **${files.length}**\n` +
      `- Violations: **${totalViolations}**\n` +
      `- SARIF: \`${path.relative(root, outPath) || outPath}\`\n`,
  );

  if (args.failOnFindings && totalViolations > 0) return 1;
  return 0;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = { scanFile, findDockerfiles, CHAINGUARD_REGEX };
