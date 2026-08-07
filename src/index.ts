/**
 * Entrypoint: load config, open the db, start the gateway, wire shutdown.
 *
 * Plan §14: one crash takes everything down (accepted trade), so guard the
 * process against stray rejections/exceptions and let the supervisor restart on
 * a real exit.
 */

import { loadConfig } from "./config.ts";
import { Db } from "./db.ts";
import { Gateway } from "./gateway.ts";
import { errFields, log, setLogLevel } from "./log.ts";

process.on("unhandledRejection", (e) => log.error("unhandledRejection", errFields(e)));
process.on("uncaughtException", (e) => log.error("uncaughtException", errFields(e)));

const config = loadConfig();
setLogLevel(config.logLevel);
const db = new Db(config.dbPath);
const gateway = new Gateway(config, db);

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info("shutdown signal", { signal });
  try {
    await gateway.stop();
  } finally {
    db.close();
  }
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

log.info("starting pilegram", { stateDir: config.stateDir, modelsDir: config.modelsDir, allowed: config.allowedUserIds.size });
await gateway.start();
