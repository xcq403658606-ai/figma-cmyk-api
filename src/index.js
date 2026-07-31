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

function shutdown(signal) {
  console.log(JSON.stringify({ level: "info", message: "Shutting down", signal }));
  server.close((error) => {
    if (error) {
      console.error(error);
      process.exitCode = 1;
    }
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
