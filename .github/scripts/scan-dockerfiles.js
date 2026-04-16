#!/usr/bin/env node
// Scans the repository for Dockerfiles and writes a SARIF 2.1.0 report
// flagging FROM instructions whose base image is not from cgr.dev/chainguard/.
// Exceptions: `scratch`, references to stage aliases declared earlier in the
// same file via `AS <name>`, and images whose tag contains an unresolved ARG
// substitution (cannot be evaluated statically).

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(process.argv[2] || process.cwd());
const OUTPUT = path.resolve(process.argv[3] || 'dockerfile-base-image.sarif');

const CHAINGUARD_PREFIX = 'cgr.dev/chainguard/';
const IGNORED_DIRS = new Set(['.git', 'node_modules']);
const DOCKERFILE_PATTERNS = [
  /^Dockerfile$/,
  /^Dockerfile\..+$/,
  /\.Dockerfile$/,
  /\.dockerfile$/,
];
const FROM_RE =
  /^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?\s*$/i;

function isDockerfile(name) {
  return DOCKERFILE_PATTERNS.some((re) => re.test(name));
}

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      yield* walk(full);
    } else if (entry.isFile() && isDockerfile(entry.name)) {
      yield full;
    }
  }
}

function parseFromDirectives(content) {
  const rawLines = content.split(/\r?\n/);
  const logical = [];
  let buf = '';
  let startLine = 0;
  for (let i = 0; i < rawLines.length; i++) {
    if (buf === '') startLine = i + 1;
    const line = rawLines[i];
    if (line.endsWith('\\')) {
      buf += line.slice(0, -1) + ' ';
      continue;
    }
    buf += line;
    logical.push({ line: startLine, text: buf });
    buf = '';
  }
  if (buf !== '') logical.push({ line: startLine, text: buf });

  const froms = [];
  for (const { line, text } of logical) {
    const trimmed = text.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const m = trimmed.match(FROM_RE);
    if (m) froms.push({ line, image: m[1], alias: m[2] });
  }
  return froms;
}

function isAllowed(image, aliases) {
  if (image === 'scratch') return true;
  if (image.startsWith(CHAINGUARD_PREFIX)) return true;
  if (aliases.has(image)) return true;
  if (image.includes('$')) return true; // unresolved ARG — skip
  return false;
}

function scanFile(absPath) {
  const content = fs.readFileSync(absPath, 'utf8');
  const rel = path.relative(ROOT, absPath).split(path.sep).join('/');
  const aliases = new Set();
  const violations = [];
  for (const { line, image, alias } of parseFromDirectives(content)) {
    if (!isAllowed(image, aliases)) {
      violations.push({ uri: rel, line, image });
    }
    if (alias) aliases.add(alias);
  }
  return violations;
}

function buildSarif(violations) {
  return {
    $schema:
      'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'dockerfile-base-image-scanner',
            informationUri:
              'https://github.com/deividfortuna/codeql-lab',
            rules: [
              {
                id: 'non-chainguard-base-image',
                name: 'NonChainguardBaseImage',
                shortDescription: {
                  text: 'Base image is not from Chainguard',
                },
                fullDescription: {
                  text:
                    'Dockerfile FROM instructions should use images from cgr.dev/chainguard/ for minimal, hardened, regularly rebuilt base images. Exceptions: `scratch` and references to stage aliases declared earlier in the same Dockerfile.',
                },
                defaultConfiguration: { level: 'warning' },
                helpUri:
                  'https://edu.chainguard.dev/chainguard/chainguard-images/overview/',
              },
            ],
          },
        },
        results: violations.map((v) => ({
          ruleId: 'non-chainguard-base-image',
          level: 'warning',
          message: {
            text: `Base image \`${v.image}\` is not from cgr.dev/chainguard/. Prefer a Chainguard image for a minimal, hardened base.`,
          },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: v.uri },
                region: { startLine: v.line },
              },
            },
          ],
        })),
      },
    ],
  };
}

function main() {
  const violations = [];
  for (const file of walk(ROOT)) {
    violations.push(...scanFile(file));
  }
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, JSON.stringify(buildSarif(violations), null, 2));
  console.log(
    `Scanned ${ROOT}: ${violations.length} violation(s). SARIF written to ${OUTPUT}`,
  );
  for (const v of violations) {
    console.log(`  ${v.uri}:${v.line}  ${v.image}`);
  }
}

main();
