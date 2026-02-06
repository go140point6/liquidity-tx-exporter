const path = require("path");
const Database = require("better-sqlite3");

require("dotenv").config({
  path: path.join(__dirname, "..", ".env"),
  quiet: true,
});

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`[resetStabilityPool] Missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

const DB_PATH = requireEnv("DB_PATH");

function main() {
  const db = new Database(DB_PATH);
  try {
    db.exec(`
      DELETE FROM sp_cursors;
      DELETE FROM sp_deposit_ops;
      DELETE FROM sp_deposit_updates;
    `);
    console.log("[resetStabilityPool] Cleared sp_cursors, sp_deposit_ops, sp_deposit_updates.");
  } finally {
    db.close();
  }
}

main();
