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
    console.error(`[reportStabilityPool] Missing required env var: ${name}`);
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
    console.error("[reportStabilityPool] --limit must be a positive integer");
    process.exit(1);
  }
  const onlyFxrp = args.includes("--FXRP");
  const onlyWflr = args.includes("--WFLR");
  if (onlyFxrp && onlyWflr) {
    console.error("[reportStabilityPool] Use only one of --FXRP or --WFLR (or neither for both)");
    process.exit(1);
  }
  const csv = args.includes("--csv");
  const outArg = args.find((a) => a.startsWith("--out="));
  const outPath = outArg ? outArg.split("=")[1] : "./data/sp_report.csv";
  const poolKeys = onlyFxrp
    ? ["sp_fxrp"]
    : onlyWflr
      ? ["sp_wflr"]
      : ["sp_fxrp", "sp_wflr"];

  return { limit, poolKeys, csv, outPath };
}

const OP_LABELS = {
  0: "provideToSP (deposit)",
  1: "withdrawFromSP (withdraw)",
  2: "claimAllCollGains (claim)",
};

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

async function main() {
  const { limit, poolKeys, csv, outPath } = parseArgs();
  const db = new Database(DB_PATH);
  const rowsOut = [];
  const outLines = [];
  try {
    const provider = csv
      ? new ethers.JsonRpcProvider(requireEnv("FLR_MAINNET_SCAN"))
      : null;
    const blockTsCache = new Map();

    const poolRows = db
      .prepare(
        `SELECT pool_key, protocol, coll_symbol, coll_decimals
         FROM stability_pools
         WHERE pool_key IN (${poolKeys.map(() => "?").join(",")})`
      )
      .all(...poolKeys);

    if (!poolRows.length) {
      console.log("[reportStabilityPool] No stability pools found.");
      return;
    }

    const poolMeta = new Map(poolRows.map((r) => [r.pool_key, r]));

    const baseSql = `
      SELECT pool_key, depositor, block_number, tx_hash, log_index,
             operation, deposit_loss, topup_or_withdrawal, yield_gain_since,
             yield_gain_claimed, coll_gain_since, coll_gain_claimed
      FROM sp_deposit_ops
      WHERE pool_key IN (${poolKeys.map(() => "?").join(",")})
      ORDER BY block_number DESC, log_index DESC
    `;
    const rows = limit === null
      ? db.prepare(baseSql).all(...poolKeys)
      : db.prepare(baseSql + " LIMIT ?").all(...poolKeys, limit);

    if (!rows.length) {
      console.log("[reportStabilityPool] No stability pool events found.");
      return;
    }

    if (csv) {
      outLines.push(
        [
          "row_type",
          "datetime_utc",
          "tx_hash",
          "block_number",
          "pool_key",
          "operation_code",
          "operation_label",
          "cdp_loss",
          "cdp_topup_withdrawal",
          "cdp_yield_gain_since",
          "cdp_yield_gain_claimed",
          "coll_gain_since",
          "coll_gain_claimed",
          "coll_symbol",
          "trade_cdp_spent",
          "trade_coll_received",
        ].join(",")
      );
    } else {
      console.log("\n=== Stability Pool Events ===");
    }

    for (const r of rows) {
      const meta = poolMeta.get(r.pool_key);
      const opLabel = OP_LABELS[Number(r.operation)] || "unknown";

      if (csv) {
        let iso = "";
        if (provider) {
          if (!blockTsCache.has(r.block_number)) {
            blockTsCache.set(r.block_number, provider.getBlock(r.block_number));
          }
          const block = await blockTsCache.get(r.block_number);
          if (block?.timestamp) {
            iso = new Date(block.timestamp * 1000).toISOString();
          }
        }

        const tradeCdpSpent =
          Number(r.deposit_loss) > 0 ? formatUnsignedUnits(r.deposit_loss, 18, 3) : "";
        const tradeCollReceived =
          Number(r.coll_gain_since) > 0
            ? formatUnsignedUnits(r.coll_gain_since, meta.coll_decimals, 3)
            : "";

        const row = [
          "OP",
          iso,
          r.tx_hash,
          r.block_number,
          r.pool_key,
          r.operation,
          opLabel,
          formatUnsignedUnits(r.deposit_loss, 18, 3),
          formatSignedUnits(r.topup_or_withdrawal, 18, 3),
          formatUnsignedUnits(r.yield_gain_since, 18, 3),
          formatUnsignedUnits(r.yield_gain_claimed, 18, 3),
          formatUnsignedUnits(r.coll_gain_since, meta.coll_decimals, 3),
          formatUnsignedUnits(r.coll_gain_claimed, meta.coll_decimals, 3),
          meta.coll_symbol,
          tradeCdpSpent,
          tradeCollReceived,
        ].map(csvEscape);
        rowsOut.push({ blockNumber: r.block_number, iso, row: row.join(",") });

        if (tradeCdpSpent && tradeCollReceived) {
          const tradeRow = [
            "EXCHANGE",
            iso,
            r.tx_hash,
            r.block_number,
            r.pool_key,
            r.operation,
            opLabel,
            "", // cdp_loss
            "", // cdp_topup/withdrawal
            "", // cdp_yield_gain_since
            "", // cdp_yield_gain_claimed
            "", // coll_gain_since
            "", // coll_gain_claimed
            meta.coll_symbol,
            tradeCdpSpent,
            tradeCollReceived,
          ].map(csvEscape);
          rowsOut.push({ blockNumber: r.block_number, iso, row: tradeRow.join(",") });
        }
      } else {
        console.log(
          [
            `pool=${r.pool_key}`,
            `op=${r.operation}(${opLabel})`,
            `cdp_loss=${formatUnsignedUnits(r.deposit_loss, 18, 3)}`,
            `cdp_topup=${formatSignedUnits(r.topup_or_withdrawal, 18, 3)}`,
            `cdp_yield=${formatUnsignedUnits(r.yield_gain_since, 18, 3)}`,
            `coll_gain=${formatUnsignedUnits(r.coll_gain_since, meta.coll_decimals, 3)} ${meta.coll_symbol}`,
          ].join(" ")
        );
      }
    }

    if (csv && provider) {
      for (const p of poolRows) {
        const poolKey = p.pool_key;
        const contractRow = db
          .prepare("SELECT address_eip55 FROM stability_pools WHERE pool_key = ?")
          .get(poolKey);
        if (!contractRow?.address_eip55) continue;

        const sp = new ethers.Contract(contractRow.address_eip55, require("../abi/stabilityPool.json"), provider);
        let iso = "";
        let pendingBlockNumber = null;
        const lastOp = db
          .prepare(
            `SELECT block_number
             FROM sp_deposit_ops
             WHERE pool_key = ?
             ORDER BY block_number DESC, log_index DESC
             LIMIT 1`
          )
          .get(poolKey);
        if (lastOp?.block_number) {
          pendingBlockNumber = lastOp.block_number;
        } else {
          const lastUpd = db
            .prepare(
              `SELECT block_number
               FROM sp_deposit_updates
               WHERE pool_key = ?
               ORDER BY block_number DESC, log_index DESC
               LIMIT 1`
            )
            .get(poolKey);
          if (lastUpd?.block_number) pendingBlockNumber = lastUpd.block_number;
        }

        if (pendingBlockNumber != null) {
          const blk = await provider.getBlock(pendingBlockNumber);
          if (blk?.timestamp) iso = new Date(blk.timestamp * 1000).toISOString();
        }

        const compounded = await sp.getCompoundedBoldDeposit(requireEnv("TRACK_ADDRESS"));
        const collGain = await sp.getDepositorCollGain(requireEnv("TRACK_ADDRESS"));

        const lastUpdate = db
          .prepare(
            `SELECT new_deposit
             FROM sp_deposit_updates
             WHERE pool_key = ?
             ORDER BY block_number DESC, log_index DESC
             LIMIT 1`
          )
          .get(poolKey);

        let pendingCdpSpent = "";
        if (lastUpdate?.new_deposit) {
          const prev = BigInt(lastUpdate.new_deposit);
          const now = BigInt(compounded.toString());
          if (prev > now) {
            pendingCdpSpent = formatUnsignedUnits((prev - now).toString(), 18, 3);
          }
        }
        const pendingCollReceived = formatUnsignedUnits(collGain.toString(), p.coll_decimals, 3);

        if (pendingCdpSpent || (pendingCollReceived && pendingCollReceived !== "0.000")) {
          const row = [
            "EXCHPENDING",
            iso,
            "",
            pendingBlockNumber != null ? String(pendingBlockNumber) : "",
            poolKey,
            "",
            "pending",
            "",
            "",
            "",
            "",
            "",
            "",
            "",
            p.coll_symbol,
            pendingCdpSpent,
            pendingCollReceived,
          ].map(csvEscape);
          rowsOut.push({ blockNumber: pendingBlockNumber, iso, row: row.join(",") });
        }
      }
    }
  } finally {
    if (csv) {
      rowsOut.sort((a, b) => {
        if (a.iso && b.iso) return b.iso.localeCompare(a.iso);
        const aBlock = Number.isFinite(a.blockNumber) ? a.blockNumber : null;
        const bBlock = Number.isFinite(b.blockNumber) ? b.blockNumber : null;
        if (aBlock != null && bBlock != null) return bBlock - aBlock;
        if (aBlock != null) return -1;
        if (bBlock != null) return 1;
        return 0;
      });
      for (const r of rowsOut) {
        outLines.push(r.row);
      }
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, outLines.join("\n") + "\n", "utf8");
      console.log(`[reportStabilityPool] CSV written to ${outPath}`);
    }
    db.close();
  }
}

main().catch((err) => {
  console.error("[reportStabilityPool] FATAL:", err);
  process.exit(1);
});
