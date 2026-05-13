#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import * as core from "@actions/core";
import { DockerfileParser } from "dockerfile-ast";
import {
  SarifBuilder,
  SarifRunBuilder,
  SarifRuleBuilder,
  SarifResultBuilder,
} from "node-sarif-builder";
import pkg from "./package.json" with { type: "json" };
import chainguardSuggestions from "./chainguard-suggestions.json" with { type: "json" };

const RULE_ID = "TEST_CHAINGUARD_1";
const RULE_NAME = "Ensure Docker base images come from Chainguard";
const CHAINGUARD_REGEX = /^(--platform=[^ ]+\s+)?(cgr\.dev\/chainguard\/|chainguard\/).+/;

const TOOL_NAME = "dockerfile-scan";
const TOOL_VERSION = pkg.version;

function suggestChainguardImage(image) {
  if (!image) return null;
  const repo = image.split(/[:@]/)[0];
  const direct = chainguardSuggestions[repo];
  if (direct) return direct;
  if (
    repo === "gcr.io/distroless/static" ||
    /^gcr\.io\/distroless\/static-debian\d+$/.test(repo)
  ) {
    return "cgr.dev/chainguard/static:latest";
  }
  if (repo.startsWith("gcr.io/distroless/base")) {
    return "cgr.dev/chainguard/glibc-dynamic:latest";
  }
  if (repo.startsWith("gcr.io/distroless/cc")) {
    return "cgr.dev/chainguard/cc-dynamic:latest";
  }
  return null;
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

function isDockerfile(name) {
  return (
    name === "Dockerfile" ||
    name.endsWith(".Dockerfile") ||
    name.startsWith("Dockerfile.")
  );
}

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

    const imageRange = from.getImageRange();
    const range = imageRange || from.getRange();
    const image = from.getImage();
    const suggestion = suggestChainguardImage(image);
    violations.push({
      value: normalized,
      image,
      suggestion,
      startLine: range.start.line + 1,
      startColumn: range.start.character + 1,
      endLine: range.end.line + 1,
      endColumn: range.end.character + 1,
      imageRange: imageRange
        ? {
            startLine: imageRange.start.line + 1,
            startColumn: imageRange.start.character + 1,
            endLine: imageRange.end.line + 1,
            endColumn: imageRange.end.character + 1,
          }
        : null,
    });
  }

  return violations;
}

function toFileUri(filePath, root) {
  return path.relative(root, filePath).split(path.sep).join("/");
}

async function run() {
  const directory = core.getInput("working-directory") || ".";
  const output = core.getInput("output") || "results.sarif";
  const failOnFindings = core.getBooleanInput("fail-on-findings");

  const root = path.resolve(directory);
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
      helpUri: "https://chainguard.dev/docs",
    }),
  );

  let totalViolations = 0;
  for (const file of files) {
    let violations;
    try {
      violations = scanFile(file);
    } catch (err) {
      core.warning(`Failed to parse ${file}: ${err.message}`);
      continue;
    }
    const fileUri = toFileUri(file, root);
    for (const v of violations) {
      totalViolations++;
      const suggestionSuffix = v.suggestion
        ? ` Suggested replacement: ${v.suggestion}.`
        : "";
      const messageText = `Base image "${v.value}" is not from Chainguard (cgr.dev/chainguard/ or chainguard/).${suggestionSuffix}`;

      const resultBuilder = new SarifResultBuilder().initSimple({
        level: "warning",
        ruleId: RULE_ID,
        messageText,
        fileUri,
        startLine: v.startLine,
        startColumn: v.startColumn,
        endLine: v.endLine,
        endColumn: v.endColumn,
      });

      if (v.suggestion && v.imageRange) {
        resultBuilder.result.fixes = [
          {
            description: {
              text: `Replace base image with the Chainguard equivalent: ${v.suggestion}.`,
            },
            artifactChanges: [
              {
                artifactLocation: { uri: fileUri },
                replacements: [
                  {
                    deletedRegion: {
                      startLine: v.imageRange.startLine,
                      startColumn: v.imageRange.startColumn,
                      endLine: v.imageRange.endLine,
                      endColumn: v.imageRange.endColumn,
                    },
                    insertedContent: { text: v.suggestion },
                  },
                ],
              },
            ],
          },
        ];
      }

      runBuilder.addResult(resultBuilder);
      core.warning(`${RULE_ID}: ${messageText}`, {
        title: RULE_ID,
        file: fileUri,
        startLine: v.startLine,
        startColumn: v.startColumn,
        endLine: v.endLine,
        endColumn: v.endColumn,
      });
    }
  }

  sarifBuilder.addRun(runBuilder);
  const outPath = path.resolve(output);
  sarifBuilder.generateSarifFileSync(outPath);

  core.info(
    `Scanned ${files.length} Dockerfile(s); ${totalViolations} violation(s). SARIF written to ${outPath}`,
  );
  core.setOutput("sarif-file", outPath);
  core.setOutput("violations", totalViolations);
  core.setOutput("files-scanned", files.length);

  await core.summary
    .addHeading(`${RULE_ID} — ${RULE_NAME}`, 2)
    .addList([
      `Files scanned: ${files.length}`,
      `Violations: ${totalViolations}`,
      `SARIF: ${path.relative(root, outPath) || outPath}`,
    ])
    .write();

  if (failOnFindings && totalViolations > 0) {
    core.setFailed(
      `${totalViolations} ${RULE_ID} violation(s) found across ${files.length} Dockerfile(s).`,
    );
  }
}

run().catch((err) => core.setFailed(err.stack || err.message));
