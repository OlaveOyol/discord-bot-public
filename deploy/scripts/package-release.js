#!/usr/bin/env node

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const archiver = require("archiver");

const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const PACKAGE_JSON_PATH = path.join(PROJECT_ROOT, "package.json");

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) {
      args._.push(value);
      continue;
    }

    const [rawKey, inlineValue] = value.slice(2).split("=", 2);
    if (inlineValue !== undefined) {
      args[rawKey] = inlineValue;
      continue;
    }

    const nextValue = argv[index + 1];
    if (nextValue && !nextValue.startsWith("--")) {
      args[rawKey] = nextValue;
      index += 1;
    } else {
      args[rawKey] = true;
    }
  }
  return args;
}

function normalizeString(value, fallback = null) {
  if (typeof value !== "string") {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function sanitizeSegment(value) {
  return String(value || "release").replace(/[^A-Za-z0-9._-]+/g, "-");
}

function formatOutputName(packageName, version, buildId = null) {
  return `${sanitizeSegment(packageName)}-${sanitizeSegment(version)}${buildId ? `+${sanitizeSegment(buildId)}` : ""}`;
}

function buildReleaseId(version, buildId = null) {
  return `${version}${buildId ? `+${buildId}` : ""}`;
}

async function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function createArchive({ outputPath, ignore, releaseMetadata }) {
  await fsp.mkdir(path.dirname(outputPath), { recursive: true });
  await fsp.rm(outputPath, { force: true }).catch(() => {});

  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outputPath);
    const archive = archiver("tar", {
      gzip: true,
      gzipOptions: { level: 9 },
    });

    output.on("close", resolve);
    output.on("error", reject);
    archive.on("error", reject);
    archive.pipe(output);
    archive.glob("**/*", {
      cwd: PROJECT_ROOT,
      dot: true,
      ignore,
    });
    archive.append(`${JSON.stringify(releaseMetadata, null, 2)}\n`, { name: ".release.json" });
    archive.finalize().catch(reject);
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const packageJson = JSON.parse(await fsp.readFile(PACKAGE_JSON_PATH, "utf8"));
  const packageName = normalizeString(args.name, packageJson.name || "discord-bot");
  const version = normalizeString(args.version, packageJson.version);
  if (!version) {
    throw new Error("package.json version is required to package a release.");
  }

  const buildId = normalizeString(args["build-id"], process.env.BOT_BUILD_ID || null);
  const releaseId = buildReleaseId(version, buildId);
  const severity = normalizeString(args.severity, "normal");
  const outputDir = path.resolve(normalizeString(args["output-dir"], path.join(PROJECT_ROOT, "dist", "releases")));
  const outputBaseName = formatOutputName(packageName, version, buildId);
  const artifactPath = path.join(outputDir, `${outputBaseName}.tar.gz`);
  const manifestPath = path.join(outputDir, `${outputBaseName}.manifest.json`);
  const releaseNotesUrl = normalizeString(args["release-notes-url"], null);

  const ignore = [
    ".git/**",
    ".venv/**",
    "node_modules/**",
    "current/**",
    "releases/**",
    "shared/**",
    "staging/**",
    "recordings/**",
    "dist/**",
    ".env",
    ".bot.lock",
    "*.log",
  ];
  if (outputDir.startsWith(PROJECT_ROOT)) {
    ignore.push(`${path.relative(PROJECT_ROOT, outputDir).replaceAll("\\", "/")}/**`);
  }

  await createArchive({
    outputPath: artifactPath,
    ignore,
    releaseMetadata: {
      packageName,
      version,
      buildId,
      releaseId,
      packagedAt: new Date().toISOString(),
    },
  });

  const stats = await fsp.stat(artifactPath);
  const sha256 = await sha256File(artifactPath);
  const manifest = {
    schemaVersion: 1,
    name: packageName,
    version: releaseId,
    packageVersion: version,
    buildId,
    severity: severity === "security" ? "security" : "normal",
    releasedAt: new Date().toISOString(),
    applyAfterIdle: severity !== "security",
    releaseNotesUrl,
    artifact: {
      path: artifactPath,
      sha256,
      sizeBytes: stats.size,
    },
  };

  await fsp.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  process.stdout.write(
    `${JSON.stringify(
      {
        artifactPath,
        manifestPath,
        version: releaseId,
        packageVersion: version,
        buildId,
        sha256,
        sizeBytes: stats.size,
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exit(1);
});
