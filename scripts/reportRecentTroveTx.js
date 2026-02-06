const fs = require("fs");
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
    console.error(`[reportRecentTroveTx] Missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

const DB_PATH = requireEnv("DB_PATH");

function parseArgs() {
  const args = process.argv.slice(2);
  const limitArg = args.find((a) => a.startsWith("--limit="));
  const limit = limitArg ? Number(limitArg.split("=")[1]) : null;
  if (limit !== null && (!Number.isInteger(limit) || limit <= 0)) {
    console.error("[reportRecentTroveTx] --limit must be a positive integer");
    process.exit(1);
  }
  const onlyFxrp = args.includes("--FXRP");
  const onlyWflr = args.includes("--WFLR");
  if (onlyFxrp && onlyWflr) {
    console.error("[reportRecentTroveTx] Use only one of --FXRP or --WFLR (or neither for both)");
    process.exit(1);
  }
  const csv = args.includes("--csv");
  const outArg = args.find((a) => a.startsWith("--out="));
  const outPath = outArg ? outArg.split("=")[1] : "./data/tx_report.csv";
  const showTrove = args.includes("--show-trove");
  const contractKeys = onlyFxrp
    ? ["enosys_fxrp"]
    : onlyWflr
      ? ["enosys_wflr"]
      : ["enosys_fxrp", "enosys_wflr"];

  return { limit, contractKeys, showTrove, csv, outPath };
}

function formatUnitsFixed(value, decimals, fixedDigits, { signed = false } = {}) {
  if (value == null) return null;
  let n;
  try {
    n = BigInt(value);
  } catch (_) {
    return null;
  }
  const sign = signed && n < 0n ? "-" : "";
  const abs = n < 0n ? -n : n;
  const fmt = ethers.formatUnits(abs.toString(), decimals);
  const num = Number(fmt);
  if (!Number.isFinite(num)) return null;
  return `${sign}${num.toFixed(fixedDigits)}`;
}

function formatSignedUnits(value, decimals, fixedDigits = 3) {
  return formatUnitsFixed(value, decimals, fixedDigits, { signed: true });
}

function formatUnsignedUnits(value, decimals, fixedDigits = 3) {
  return formatUnitsFixed(value, decimals, fixedDigits, { signed: false });
}

function formatRatePct(value) {
  if (value == null) return null;
  try {
    const v = BigInt(value);
    const pct = Number(ethers.formatUnits(v.toString(), 18)) * 100;
    return Number.isFinite(pct) ? `${pct.toFixed(1)}%` : null;
  } catch (_) {
    return null;
  }
}

function parseDataJson(row) {
  try {
    return JSON.parse(row.data_json);
  } catch (_) {
    return {};
  }
}

const CONTRACT_META = {
  enosys_fxrp: { collSymbol: "FXRP", collDecimals: 6 },
  enosys_wflr: { collSymbol: "WFLR", collDecimals: 18 },
};

const OP_LABELS = {
  0: "openTrove (open)",
  1: "closeTrove (close)",
  2: "adjustTrove (deposit/withdraw/borrow/repay)",
  3: "adjustTroveInterestRate (rate change)",
  4: "applyPendingDebt (interest/redistribution applied)",
  5: "liquidate (liquidation)",
  6: "redeemCollateral (redemption)",
  7: "openTroveAndJoinBatch (open + join batch)",
  8: "setInterestBatchManager (batch assignment)",
  9: "removeFromBatch (leave batch)",
};

function csvEscape(v) {
  if (v == null) return "";
  const s = String(v);
  if (s.includes("\"")) {
    const escaped = s.replace(/\"/g, "\"\"");
    return `"${escaped}"`;
  }
  if (s.includes(",") || s.includes("\n")) {
    return `"${s}"`;
  }
  return s;
}

function buildTradeSummary(opCode, meta, opData, feeData) {
  const debtDeltaRaw = opData._debtChangeFromOperation;
  const collDeltaRaw = opData._collChangeFromOperation;
  if (opCode === "6") {
    const collAbs = formatUnsignedUnits(collDeltaRaw, meta.collDecimals, 3);
    let collToRedeemer = collAbs;
    if (feeData._ETHFee != null && collDeltaRaw != null) {
      const fee = BigInt(feeData._ETHFee || "0");
      const collAbsRaw =
        BigInt(collDeltaRaw || "0") < 0n ? -BigInt(collDeltaRaw || "0") : BigInt(collDeltaRaw || "0");
      const toRedeemerRaw = collAbsRaw - fee;
      collToRedeemer = formatUnsignedUnits(toRedeemerRaw.toString(), meta.collDecimals, 3);
    }
    const debtAbs = formatUnsignedUnits(debtDeltaRaw, 18, 3);
    return {
      soldAmount: collToRedeemer,
      soldSymbol: meta.collSymbol,
      boughtAmount: debtAbs,
      boughtSymbol: "CDP",
    };
  }

  if (opCode === "2") {
    const debtDelta = BigInt(debtDeltaRaw || "0");
    const collDelta = BigInt(collDeltaRaw || "0");
    let soldAmount = null;
    let soldSymbol = null;
    let boughtAmount = null;
    let boughtSymbol = null;

    if (debtDelta > 0n) {
      boughtAmount = formatUnsignedUnits(debtDelta.toString(), 18, 3);
      boughtSymbol = "CDP";
    } else if (debtDelta < 0n) {
      soldAmount = formatUnsignedUnits((-debtDelta).toString(), 18, 3);
      soldSymbol = "CDP";
    }

    if (collDelta > 0n) {
      boughtAmount = formatUnsignedUnits(collDelta.toString(), meta.collDecimals, 3);
      boughtSymbol = meta.collSymbol;
    } else if (collDelta < 0n) {
      soldAmount = formatUnsignedUnits((-collDelta).toString(), meta.collDecimals, 3);
      soldSymbol = meta.collSymbol;
    }

    return { soldAmount, soldSymbol, boughtAmount, boughtSymbol };
  }

  return { soldAmount: null, soldSymbol: null, boughtAmount: null, boughtSymbol: null };
}

async function main() {
  const { limit, contractKeys, showTrove, csv, outPath } = parseArgs();
  const db = new Database(DB_PATH);
  let outStream = null;
  try {
    const provider = csv
      ? new ethers.JsonRpcProvider(requireEnv("FLR_MAINNET_SCAN"))
      : null;
    const blockTsCache = new Map();

    const baseSql = `
      SELECT tx_hash,
             MAX(block_number) AS block_number,
             COUNT(*) AS event_count
      FROM trove_events
      WHERE contract_key IN (${contractKeys.map(() => "?").join(",")})
      GROUP BY tx_hash
      ORDER BY block_number DESC
    `;
    const txs = limit === null
      ? db.prepare(baseSql).all(...contractKeys)
      : db.prepare(baseSql + " LIMIT ?").all(...contractKeys, limit);

    if (!txs.length) {
      console.log("[reportRecentTroveTx] No trove_events found.");
      return;
    }

    if (csv) {
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      outStream = fs.createWriteStream(outPath, { encoding: "utf8" });
      outStream.write(
        [
          "datetime_utc",
          "tx_hash",
          "block_number",
          "contract",
          "trove_id",
          "op_code",
          "op_label",
          "sold_amount",
          "sold_symbol",
          "bought_amount",
          "bought_symbol",
          "debt_delta_cdp",
          "coll_delta",
          "coll_symbol",
          "debt_now_cdp",
          "coll_now",
          "ir_pct",
        ].join(",") + "\n"
      );
    } else {
      console.log(
        `\n=== Recent Trove Transactions (limit=${limit ?? "all"}) ===`
      );
    }
    for (const t of txs) {
      const events = db
        .prepare(
          `SELECT event_name, contract_key, trove_id, block_number, log_index, data_json
           FROM trove_events
           WHERE tx_hash = ?
             AND contract_key IN (${contractKeys.map(() => "?").join(",")})
           ORDER BY log_index`
        )
        .all(t.tx_hash, ...contractKeys);

      const grouped = new Map();
      for (const ev of events) {
        const key = `${ev.contract_key}:${ev.trove_id}`;
        if (!grouped.has(key)) {
          grouped.set(key, { contract_key: ev.contract_key, trove_id: ev.trove_id });
        }
        const g = grouped.get(key);
        if (ev.event_name === "TroveOperation") g.op = ev;
        if (ev.event_name === "TroveUpdated") g.updated = ev;
        if (ev.event_name === "RedemptionFeePaidToTrove") g.fee = ev;
      }

      if (grouped.size === 0) {
        console.log(
          `tx=${t.tx_hash} block=${t.block_number} events=${t.event_count} note=no_trove_events`
        );
        continue;
      }

      for (const g of grouped.values()) {
        const meta = CONTRACT_META[g.contract_key] || {
          collSymbol: "COLL",
          collDecimals: 18,
        };
        const opData = g.op ? parseDataJson(g.op) : {};
        const updData = g.updated ? parseDataJson(g.updated) : {};
        const feeData = g.fee ? parseDataJson(g.fee) : {};

        const debtDelta = formatSignedUnits(opData._debtChangeFromOperation, 18, 3);
        const collDelta = formatSignedUnits(opData._collChangeFromOperation, meta.collDecimals, 3);
        const collDeltaAbs = formatUnsignedUnits(opData._collChangeFromOperation, meta.collDecimals, 3);
        const irPct = formatRatePct(opData._annualInterestRate ?? updData._annualInterestRate);
        const debtNow = updData._debt ? formatUnsignedUnits(updData._debt, 18, 3) : null;
        const collNow = updData._coll
          ? formatUnsignedUnits(updData._coll, meta.collDecimals, 3)
          : null;
        const fee = feeData._ETHFee ? formatUnsignedUnits(feeData._ETHFee, meta.collDecimals, 3) : null;
        const collToRedeemer =
          feeData._ETHFee != null && opData._collChangeFromOperation != null
            ? formatUnsignedUnits(
                (BigInt(opData._collChangeFromOperation || "0") < 0n
                  ? -BigInt(opData._collChangeFromOperation || "0")
                  : BigInt(opData._collChangeFromOperation || "0")) - BigInt(feeData._ETHFee || "0"),
                meta.collDecimals,
                3
              )
            : null;

        const closed = updData._debt === "0" && updData._coll === "0";
        const opCode = opData._operation ?? "n/a";
        const opLabel =
          opCode !== "n/a" && OP_LABELS[Number(opCode)] ? OP_LABELS[Number(opCode)] : null;

        if (csv) {
          let iso = "";
          if (provider) {
            const blockNumber = g.updated?.block_number ?? t.block_number;
            if (!blockTsCache.has(blockNumber)) {
              blockTsCache.set(blockNumber, provider.getBlock(blockNumber));
            }
            const block = await blockTsCache.get(blockNumber);
            if (block?.timestamp) {
              iso = new Date(block.timestamp * 1000).toISOString();
            }
          }

          const trade = buildTradeSummary(opCode, meta, opData, feeData);
          const row = [
            iso,
            t.tx_hash,
            t.block_number,
            g.contract_key,
            g.trove_id,
            opCode,
            opLabel || "",
            trade.soldAmount || "",
            trade.soldSymbol || "",
            trade.boughtAmount || "",
            trade.boughtSymbol || "",
            debtDelta || "",
            collDelta || "",
            meta.collSymbol,
            debtNow || "",
            collNow || "",
            irPct || "",
          ].map(csvEscape);
          outStream.write(row.join(",") + "\n");
          continue;
        }

        let summary = `op=${opCode}${opLabel ? `(${opLabel})` : ""}`;

        if (opCode === "6" && debtDelta && collDeltaAbs) {
          const spentColl = collToRedeemer || collDeltaAbs;
          summary = `Spent ${spentColl} ${meta.collSymbol} to reduce debt by ${formatUnsignedUnits(
            opData._debtChangeFromOperation,
            18,
            3
          )} CDP.`;
        } else if (opCode === "2" && debtDelta && collDelta) {
          summary = `Adjusted trove: debtΔ=${debtDelta} CDP, collΔ=${collDelta} ${meta.collSymbol}.`;
        } else if (opCode === "3" && irPct) {
          summary = `Adjusted interest rate to ${irPct}.`;
        } else if (opCode === "1") {
          summary = "Closed trove.";
        } else if (opCode === "0") {
          summary = "Opened trove.";
        } else if (opLabel) {
          summary = `${opLabel}.`;
        }

        console.log(
          [
            summary,
            showTrove ? `Trove ${g.trove_id}` : null,
            irPct && !summary.includes("interest rate") ? `IR ${irPct}` : null,
            debtNow ? `Debt now ${debtNow} CDP` : null,
            collNow ? `Coll now ${collNow} ${meta.collSymbol}` : null,
            closed ? "Status closed" : null,
          ]
            .filter(Boolean)
            .join(" ")
        );
      }
    }
  } finally {
    if (csv) {
      outStream?.end();
      console.log(`[reportRecentTroveTx] CSV written to ${outPath}`);
    }
    db.close();
  }
}

main().catch((err) => {
  console.error("[reportRecentTroveTx] FATAL:", err);
  process.exit(1);
});
