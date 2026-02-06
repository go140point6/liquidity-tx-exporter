const path = require("path");
const Database = require("better-sqlite3");
const { ethers } = require("ethers");

require("dotenv").config({
  path: path.join(__dirname, "..", ".env"),
  quiet: true,
});

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`[reportRedemptionTx] Missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

const DB_PATH = requireEnv("DB_PATH");

function parseArgs() {
  const args = process.argv.slice(2);
  const txArg = args.find((a) => a.startsWith("--tx="));
  const latest = args.includes("--latest");
  const decimalsArg = args.find((a) => a.startsWith("--decimals="));
  const decimals = decimalsArg ? Number(decimalsArg.split("=")[1]) : 18;

  if (!Number.isInteger(decimals) || decimals < 0) {
    console.error("[reportRedemptionTx] --decimals must be a non-negative integer");
    process.exit(1);
  }

  if (!txArg && !latest) {
    console.error("[reportRedemptionTx] Provide --tx=0x... or --latest");
    process.exit(1);
  }

  if (txArg && latest) {
    console.error("[reportRedemptionTx] Use only one of --tx or --latest");
    process.exit(1);
  }

  const tx = txArg ? txArg.split("=")[1] : null;
  if (tx && !/^0x[a-fA-F0-9]{64}$/.test(tx)) {
    console.error("[reportRedemptionTx] Invalid tx hash format");
    process.exit(1);
  }

  return { tx, latest, decimals };
}

function formatUnitsSafe(value, decimals) {
  if (value == null) return null;
  try {
    return ethers.formatUnits(value.toString(), decimals);
  } catch (_) {
    return null;
  }
}

function bigIntOrNull(v) {
  if (v == null) return null;
  try {
    return BigInt(v);
  } catch (_) {
    return null;
  }
}

function printKV(label, value) {
  console.log(`  ${label}: ${value}`);
}

function loadTxFromDb(db, txHash) {
  const redemptions = db
    .prepare(
      `SELECT * FROM redemption_events
       WHERE tx_hash = ?
       ORDER BY log_index`
    )
    .all(txHash);

  const troveEvents = db
    .prepare(
      `SELECT * FROM trove_events
       WHERE tx_hash = ?
       ORDER BY log_index`
    )
    .all(txHash);

  return { redemptions, troveEvents };
}

function loadLatestTx(db) {
  const row = db
    .prepare(
      `SELECT tx_hash, MAX(block_number) AS block_number
       FROM trove_events
       GROUP BY tx_hash
       ORDER BY block_number DESC
       LIMIT 1`
    )
    .get();
  return row?.tx_hash || null;
}

function loadPrevTroveUpdated(db, contractKey, troveId, blockNumber, logIndex) {
  const row = db
    .prepare(
      `SELECT * FROM trove_events
       WHERE contract_key = ?
         AND trove_id = ?
         AND event_name = 'TroveUpdated'
         AND (
           block_number < ?
           OR (block_number = ? AND log_index < ?)
         )
       ORDER BY block_number DESC, log_index DESC
       LIMIT 1`
    )
    .get(contractKey, troveId, blockNumber, blockNumber, logIndex);
  return row || null;
}

function parseDataJson(row) {
  try {
    return JSON.parse(row.data_json);
  } catch (_) {
    return {};
  }
}

function formatDelta(newVal, oldVal, decimals) {
  const n = bigIntOrNull(newVal);
  const o = bigIntOrNull(oldVal);
  if (n == null || o == null) return null;
  const d = n - o;
  const raw = d.toString();
  const fmt = formatUnitsSafe(d.toString(), decimals);
  return { raw, fmt };
}

function printRedemptionSummary(db, txHash, decimals) {
  const { redemptions, troveEvents } = loadTxFromDb(db, txHash);

  if (!redemptions.length && !troveEvents.length) {
    console.log(`[reportRedemptionTx] No data found for tx ${txHash}`);
    return;
  }

  console.log(`\n=== Redemption Summary ===`);
  printKV("tx", txHash);

  if (redemptions.length) {
    console.log(`\nRedemption events (all troves): ${redemptions.length}`);
    for (const r of redemptions) {
      console.log(`\n- contract=${r.contract_key} block=${r.block_number} log=${r.log_index}`);
      printKV("attempted_bold_raw", r.attempted_bold);
      printKV("actual_bold_raw", r.actual_bold);
      printKV("eth_sent_raw", r.eth_sent);
      printKV("eth_fee_raw", r.eth_fee);
      printKV("price_raw", r.price);
      printKV("redemption_price_raw", r.redemption_price);

      const attemptedFmt = formatUnitsSafe(r.attempted_bold, decimals);
      const actualFmt = formatUnitsSafe(r.actual_bold, decimals);
      const ethSentFmt = formatUnitsSafe(r.eth_sent, decimals);
      const ethFeeFmt = formatUnitsSafe(r.eth_fee, decimals);

      if (attemptedFmt != null) printKV(`attempted_bold_${decimals}dp`, attemptedFmt);
      if (actualFmt != null) printKV(`actual_bold_${decimals}dp`, actualFmt);
      if (ethSentFmt != null) printKV(`eth_sent_${decimals}dp`, ethSentFmt);
      if (ethFeeFmt != null) printKV(`eth_fee_${decimals}dp`, ethFeeFmt);
    }
  }

  if (troveEvents.length) {
    console.log(`\nYour trove events: ${troveEvents.length}`);
    for (const ev of troveEvents) {
      console.log(
        `\n- contract=${ev.contract_key} trove_id=${ev.trove_id} event=${ev.event_name} block=${ev.block_number} log=${ev.log_index}`
      );
      const data = parseDataJson(ev);
      for (const [k, v] of Object.entries(data)) {
        printKV(k, v);
      }

      if (ev.event_name === "TroveUpdated") {
        const prev = loadPrevTroveUpdated(
          db,
          ev.contract_key,
          ev.trove_id,
          ev.block_number,
          ev.log_index
        );
        if (prev) {
          const prevData = parseDataJson(prev);
          const debtDelta = formatDelta(data._debt, prevData._debt, decimals);
          const collDelta = formatDelta(data._coll, prevData._coll, decimals);
          if (debtDelta) {
            printKV("debt_delta_raw", debtDelta.raw);
            if (debtDelta.fmt != null) printKV(`debt_delta_${decimals}dp`, debtDelta.fmt);
          }
          if (collDelta) {
            printKV("coll_delta_raw", collDelta.raw);
            if (collDelta.fmt != null) printKV(`coll_delta_${decimals}dp`, collDelta.fmt);
          }
        } else {
          printKV("delta_note", "no previous TroveUpdated found for delta");
        }
      }
    }
  }
}

function main() {
  const { tx, latest, decimals } = parseArgs();
  const db = new Database(DB_PATH);
  try {
    const txHash = latest ? loadLatestTx(db) : tx;
    if (!txHash) {
      console.log("[reportRedemptionTx] No trove events found to determine --latest");
      return;
    }
    printRedemptionSummary(db, txHash, decimals);
  } finally {
    db.close();
  }
}

main();
