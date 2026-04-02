const packageMetadata = require("./package.json");

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

function getRuntimeVersion() {
  return {
    name: PACKAGE_NAME,
    version: PACKAGE_VERSION,
    buildId: BUILD_ID,
    nodeVersion: process.version,
  };
}

function formatRuntimeVersion() {
  return `${PACKAGE_NAME}@${PACKAGE_VERSION}${BUILD_ID ? `+${BUILD_ID}` : ""}`;
}

module.exports = {
  formatRuntimeVersion,
  getRuntimeVersion,
};
