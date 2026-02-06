const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const { ethers } = require("ethers");

require("dotenv").config({
  path: path.join(__dirname, "..", ".env"),
  quiet: true,
});

const { initSchema } = require("../db");
const stabilityPoolAbi = require("../abi/stabilityPool.json");

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`[scanStabilityPool] Missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

const DB_PATH = requireEnv("DB_PATH");
const FLR_RPC_URL = requireEnv("FLR_MAINNET_SCAN");
const FLR_SCAN_BLOCKS = Number(requireEnv("FLR_MAINNET_SCAN_BLOCKS"));
const FLR_PAUSE_MS = Number(requireEnv("FLR_MAINNET_SCAN_PAUSE_MS"));
const OVERLAP_BLOCKS = Number(requireEnv("SCAN_OVERLAP_BLOCKS"));
const TRACK_ADDRESS = requireEnv("TRACK_ADDRESS");

if (!Number.isInteger(FLR_SCAN_BLOCKS) || FLR_SCAN_BLOCKS <= 0) {
  console.error("[scanStabilityPool] FLR_MAINNET_SCAN_BLOCKS must be a positive integer");
  process.exit(1);
}
if (!Number.isInteger(FLR_PAUSE_MS) || FLR_PAUSE_MS < 0) {
  console.error("[scanStabilityPool] FLR_MAINNET_SCAN_PAUSE_MS must be a non-negative integer");
  process.exit(1);
}
if (!Number.isInteger(OVERLAP_BLOCKS) || OVERLAP_BLOCKS < 0) {
  console.error("[scanStabilityPool] SCAN_OVERLAP_BLOCKS must be a non-negative integer");
  process.exit(1);
}

const TRACK_ADDRESS_EIP55 = ethers.getAddress(TRACK_ADDRESS);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfterMs(err) {
  const msg = String(err?.message || "");
  const m = msg.match(/retry in\s+(\d+)\s*s/i);
  if (!m) return null;
  const sec = Number(m[1]);
  return Number.isFinite(sec) && sec > 0 ? sec * 1000 : null;
}

function isRateLimitError(err) {
  const msg = String(err?.message || "").toLowerCase();
  return msg.includes("rate limit") || msg.includes("too many requests") || msg.includes("-32090");
}

async function getLogsWithRetry(provider, filter, { maxAttempts = 6 } = {}) {
  let attempt = 0;
  let backoffMs = 750;
  while (attempt < maxAttempts) {
    attempt++;
    try {
      return { ok: true, logs: await provider.getLogs(filter) };
    } catch (err) {
      const retryAfter = parseRetryAfterMs(err);
      const shouldRetry = isRateLimitError(err) || retryAfter != null;
      console.warn(
        `    ❌ getLogs failed (attempt ${attempt}/${maxAttempts}): ${err.message}`
      );
      if (!shouldRetry || attempt >= maxAttempts) return { ok: false, error: err };
      await sleep(retryAfter ?? backoffMs);
      backoffMs = Math.min(backoffMs * 2, 10000);
    }
  }
  return { ok: false, error: new Error("exhausted retries") };
}

function getStableLogIndex(lg) {
  if (Number.isInteger(lg?.index) && lg.index >= 0) return lg.index;
  const li = lg?.logIndex;
  if (typeof li === "number" && Number.isInteger(li) && li >= 0) return li;
  if (typeof li === "string") {
    const n = li.startsWith("0x") ? Number.parseInt(li, 16) : Number.parseInt(li, 10);
    if (Number.isInteger(n) && n >= 0) return n;
  }
  return null;
}

function scanWindowCount(fromBlock, latestBlock, maxBlocks) {
  return Math.ceil((latestBlock - fromBlock + 1) / (maxBlocks + 1));
}

function readJson(p) {
  const raw = fs.readFileSync(p, "utf8");
  return JSON.parse(raw);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const onlyFxrp = args.includes("--FXRP");
  const onlyWflr = args.includes("--WFLR");
  if (onlyFxrp && onlyWflr) {
    console.error("[scanStabilityPool] Use only one of --FXRP or --WFLR (or neither for both)");
    process.exit(1);
  }
  const poolKeys = onlyFxrp
    ? ["sp_fxrp"]
    : onlyWflr
      ? ["sp_wflr"]
      : ["sp_fxrp", "sp_wflr"];
  return { poolKeys };
}

function ensurePool(db, pool) {
  const upsert = db.prepare(`
    INSERT INTO stability_pools (
      pool_key, protocol, chain_id, address_eip55,
      default_start_block, coll_symbol, coll_decimals
    ) VALUES (?, ?, 'FLR', ?, ?, ?, ?)
    ON CONFLICT(pool_key) DO UPDATE SET
      protocol = excluded.protocol,
      address_eip55 = excluded.address_eip55,
      default_start_block = excluded.default_start_block,
      coll_symbol = excluded.coll_symbol,
      coll_decimals = excluded.coll_decimals,
      updated_at = datetime('now')
  `);
  upsert.run(
    pool.key,
    pool.protocol,
    ethers.getAddress(pool.address),
    pool.default_start_block,
    pool.coll_symbol,
    pool.coll_decimals
  );
}

function ensureCursor(db, cursorKey, startBlock) {
  db.prepare(`
    INSERT INTO sp_cursors (cursor_key, start_block, last_scanned_block)
    VALUES (?, ?, 0)
    ON CONFLICT(cursor_key) DO NOTHING
  `).run(cursorKey, startBlock);
}

function updateCursor(db, cursorKey, lastBlock) {
  db.prepare(`
    UPDATE sp_cursors
    SET last_scanned_block = ?, updated_at = datetime('now')
    WHERE cursor_key = ?
  `).run(lastBlock, cursorKey);
}

async function scanPool(db, provider, pool) {
  ensurePool(db, pool);
  const cursorKey = `sp:${pool.key}:deposit_ops`;
  ensureCursor(db, cursorKey, pool.default_start_block);

  const cursor = db
    .prepare("SELECT start_block, last_scanned_block FROM sp_cursors WHERE cursor_key = ?")
    .get(cursorKey);

  const startBlock = cursor.start_block;
  const lastScanned = cursor.last_scanned_block;

  console.log(`\n=== Stability Pool ${pool.key} ===`);
  console.log(`  start_block=${startBlock} last_scanned=${lastScanned}`);

  const latestBlock = await provider.getBlockNumber();
  console.log(`  latestBlock=${latestBlock}`);

  let fromBlock = lastScanned > 0 ? Math.max(startBlock, lastScanned - OVERLAP_BLOCKS) : startBlock;
  if (fromBlock > latestBlock) {
    console.log("  ⏭️ nothing to scan");
    return;
  }

  const totalWindows = scanWindowCount(fromBlock, latestBlock, FLR_SCAN_BLOCKS);
  console.log(
    `  windows=${totalWindows} window_size=${FLR_SCAN_BLOCKS} overlap=${OVERLAP_BLOCKS} pause=${FLR_PAUSE_MS}ms`
  );

  const iface = new ethers.Interface(stabilityPoolAbi);
  const depositOp = iface.getEvent("DepositOperation").topicHash;
  const depositUpdated = iface.getEvent("DepositUpdated").topicHash;
  const depositorTopic = ethers.zeroPadValue(TRACK_ADDRESS_EIP55, 32);

  const insert = db.prepare(`
    INSERT INTO sp_deposit_ops (
      pool_key, depositor, block_number, tx_hash, log_index,
      operation, deposit_loss, topup_or_withdrawal, yield_gain_since,
      yield_gain_claimed, coll_gain_since, coll_gain_claimed
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(pool_key, tx_hash, log_index) DO NOTHING
  `);
  const insertUpdate = db.prepare(`
    INSERT INTO sp_deposit_updates (
      pool_key, depositor, block_number, tx_hash, log_index,
      new_deposit, stashed_coll, snapshot_p, snapshot_s, snapshot_b, snapshot_scale
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(pool_key, tx_hash, log_index) DO NOTHING
  `);

  let lastGoodBlock = fromBlock - 1;
  let windowIndex = 0;

  for (let b = fromBlock; b <= latestBlock; b += FLR_SCAN_BLOCKS + 1) {
    const toBlock = Math.min(b + FLR_SCAN_BLOCKS, latestBlock);
    windowIndex++;
    console.log(`  [${windowIndex}/${totalWindows}] blocks ${b} → ${toBlock}`);

    const res = await getLogsWithRetry(provider, {
      address: ethers.getAddress(pool.address),
      fromBlock: b,
      toBlock,
      topics: [[depositOp, depositUpdated], depositorTopic],
    });

    if (!res.ok) {
      console.warn(`  🚫 window failed permanently ${b}-${toBlock}`);
      break;
    }

    let skippedNoIndex = 0;
    let parsedCount = 0;

    const tx = db.transaction((items) => {
      for (const it of items) {
        if (it.kind === "op") {
          insert.run(
            pool.key,
            it.depositor,
            it.blockNumber,
            it.txHash,
            it.logIndex,
            it.operation,
            it.depositLoss,
            it.topupOrWithdrawal,
            it.yieldGainSince,
            it.yieldGainClaimed,
            it.collGainSince,
            it.collGainClaimed
          );
        } else if (it.kind === "update") {
          insertUpdate.run(
            pool.key,
            it.depositor,
            it.blockNumber,
            it.txHash,
            it.logIndex,
            it.newDeposit,
            it.stashedColl,
            it.snapshotP,
            it.snapshotS,
            it.snapshotB,
            it.snapshotScale
          );
        }
      }
    });

    const items = [];
    for (const lg of res.logs) {
      const li = getStableLogIndex(lg);
      if (li == null) {
        skippedNoIndex++;
        continue;
      }
      const txHash = lg.transactionHash;
      if (!txHash) continue;

      let parsed;
      try {
        parsed = iface.parseLog({ topics: lg.topics, data: lg.data });
      } catch (_) {
        continue;
      }
      if (parsed.name === "DepositOperation") {
        items.push({
          kind: "op",
          depositor: TRACK_ADDRESS_EIP55,
          blockNumber: lg.blockNumber,
          txHash,
          logIndex: li,
          operation: parsed.args._operation.toString(),
          depositLoss: parsed.args._depositLossSinceLastOperation.toString(),
          topupOrWithdrawal: parsed.args._topUpOrWithdrawal.toString(),
          yieldGainSince: parsed.args._yieldGainSinceLastOperation.toString(),
          yieldGainClaimed: parsed.args._yieldGainClaimed.toString(),
          collGainSince: parsed.args._ethGainSinceLastOperation.toString(),
          collGainClaimed: parsed.args._ethGainClaimed.toString(),
        });
      } else if (parsed.name === "DepositUpdated") {
        items.push({
          kind: "update",
          depositor: TRACK_ADDRESS_EIP55,
          blockNumber: lg.blockNumber,
          txHash,
          logIndex: li,
          newDeposit: parsed.args._newDeposit.toString(),
          stashedColl: parsed.args._stashedColl.toString(),
          snapshotP: parsed.args._snapshotP.toString(),
          snapshotS: parsed.args._snapshotS.toString(),
          snapshotB: parsed.args._snapshotB.toString(),
          snapshotScale: parsed.args._snapshotScale.toString(),
        });
      }
    }

    if (items.length) {
      tx(items);
      parsedCount = items.length;
    }

    if (skippedNoIndex > 0) {
      console.warn(`    ⚠️ skipped ${skippedNoIndex} logs with missing/invalid log index`);
    }

    console.log(`    logs=${res.logs.length} parsed=${parsedCount}`);
    lastGoodBlock = toBlock;

    if (FLR_PAUSE_MS > 0) await sleep(FLR_PAUSE_MS);
  }

  if (lastGoodBlock >= fromBlock) {
    updateCursor(db, cursorKey, lastGoodBlock);
    console.log(`  ✅ advanced cursor to ${lastGoodBlock}`);
  } else {
    console.log("  ⏭️ cursor NOT advanced");
  }
}

async function main() {
  const { poolKeys } = parseArgs();
  const cfg = readJson(path.join(__dirname, "..", "data", "stability_pools.json"));
  const pools = cfg?.chains?.FLR?.contracts || [];
  const selected = pools.filter((p) => poolKeys.includes(p.key));
  if (!selected.length) {
    console.error("[scanStabilityPool] No pools found for selection.");
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(FLR_RPC_URL);
  await provider.getNetwork();

  const db = new Database(DB_PATH);
  try {
    initSchema(db);
    for (const pool of selected) {
      await scanPool(db, provider, pool);
    }
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error("[scanStabilityPool] FATAL:", err);
  process.exit(1);
});
