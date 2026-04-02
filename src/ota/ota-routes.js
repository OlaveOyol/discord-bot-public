const express = require("express");

function registerOtaRoutes(app, { logger, otaRuntime }) {
  const supervisorJsonParser = express.json({ limit: "64kb" });
  const supervisorRoute = (handler) => async (req, res) => {
    if (!otaRuntime.requireSupervisorAccess(req, res)) {
      return;
    }

    try {
      res.setHeader("Cache-Control", "no-store");
      await handler(req, res);
    } catch (error) {
      logger.warn(`Supervisor route error: ${error.message}`);
      res.status(400).json({
        error: error?.message || "Supervisor request failed.",
        supervisor: otaRuntime.buildSupervisorSnapshot(),
      });
    }
  };

  app.get("/internal/ota/status", supervisorRoute(async (_req, res) => {
    await otaRuntime.syncPendingUpdateState();
    res.json(otaRuntime.buildSupervisorSnapshot());
  }));

  app.post("/internal/ota/stage", supervisorJsonParser, supervisorRoute(async (req, res) => {
    const result = await otaRuntime.stagePendingUpdateRequest(req.body || {});
    res.status(result.statusCode).json(result.body);
  }));

  app.post("/internal/ota/prepare", supervisorJsonParser, supervisorRoute(async (req, res) => {
    const body = req.body || {};
    const result = await otaRuntime.prepareForPendingUpdateApply({
      force: Boolean(body.force),
      reason: typeof body.reason === "string" && body.reason.trim().length > 0
        ? body.reason.trim()
        : "supervisor prepare request",
    });

    let statusCode = 202;
    if (!result.prepared && result.reason === "no_pending_update") {
      statusCode = 404;
    } else if (!result.prepared) {
      statusCode = 409;
    }

    res.status(statusCode).json(result);
  }));

  app.post("/internal/ota/clear", supervisorJsonParser, supervisorRoute(async (req, res) => {
    const result = await otaRuntime.clearPendingUpdateRequest({
      force: Boolean(req.body?.force),
    });
    res.status(result.statusCode).json(result.body);
  }));
}

module.exports = {
  registerOtaRoutes,
};
