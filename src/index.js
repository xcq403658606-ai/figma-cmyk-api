import { createApp } from "./app.js";
import { config } from "./config.js";

const app = createApp();
const server = app.listen(config.port, "0.0.0.0", () => {
  console.log(JSON.stringify({
    level: "info",
    message: "EDC Box image API started",
    port: config.port,
    region: config.region
  }));
});
server.requestTimeout = config.requestTimeoutMs;
server.headersTimeout = Math.min(config.headersTimeoutMs, config.requestTimeoutMs);
server.keepAliveTimeout = config.keepAliveTimeoutMs;
server.timeout = config.processingTimeoutMs;
server.on("error", (error) => {
  console.error(JSON.stringify({
    level: "error",
    message: "HTTP server error",
    code: error.code
  }));
});

function shutdown(signal) {
  console.log(JSON.stringify({ level: "info", message: "Shutting down", signal }));
  server.close((error) => {
    if (error) {
      console.error(error);
      process.exitCode = 1;
    }
  });
  setTimeout(() => {
    console.error(JSON.stringify({
      level: "error",
      message: "Forced shutdown after grace period",
      signal
    }));
    process.exit(1);
  }, config.shutdownGraceMs).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
