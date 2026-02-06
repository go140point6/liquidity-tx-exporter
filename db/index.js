const fs = require("fs");
const path = require("path");

function initSchema(db) {
  const schemaPath = path.join(__dirname, "schema.sql");
  const sql = fs.readFileSync(schemaPath, "utf8");
  db.exec(sql);
}

module.exports = { initSchema };
