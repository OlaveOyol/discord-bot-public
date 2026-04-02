const fs = require("node:fs");
const path = require("node:path");

const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const packageMetadata = require(path.join(PROJECT_ROOT, "package.json"));

const PACKAGE_NAME =
  typeof packageMetadata.name === "string" && packageMetadata.name.trim().length > 0
    ? packageMetadata.name.trim()
    : "discord-bot";
const PACKAGE_VERSION =
  typeof packageMetadata.version === "string" && packageMetadata.version.trim().length > 0
    ? packageMetadata.version.trim()
    : "0.0.0";
const BUILD_ID =
  typeof process.env.BOT_BUILD_ID === "string" && process.env.BOT_BUILD_ID.trim().length > 0
    ? process.env.BOT_BUILD_ID.trim()
    : null;
const RELEASE_METADATA_PATH = path.join(PROJECT_ROOT, ".release.json");

function loadReleaseMetadata() {
  try {
    return JSON.parse(fs.readFileSync(RELEASE_METADATA_PATH, "utf8"));
  } catch {
    return null;
  }
}

const RELEASE_METADATA = loadReleaseMetadata();
const EFFECTIVE_BUILD_ID =
  typeof RELEASE_METADATA?.buildId === "string" && RELEASE_METADATA.buildId.trim().length > 0
    ? RELEASE_METADATA.buildId.trim()
    : BUILD_ID;
const RELEASE_ID = `${PACKAGE_VERSION}${EFFECTIVE_BUILD_ID ? `+${EFFECTIVE_BUILD_ID}` : ""}`;

function getRuntimeVersion() {
  return {
    name: PACKAGE_NAME,
    version: PACKAGE_VERSION,
    buildId: EFFECTIVE_BUILD_ID,
    releaseId: RELEASE_ID,
    nodeVersion: process.version,
  };
}

function formatRuntimeVersion() {
  return `${PACKAGE_NAME}@${RELEASE_ID}`;
}

module.exports = {
  formatRuntimeVersion,
  getRuntimeVersion,
};
