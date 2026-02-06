const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const { ethers } = require("ethers");

require("dotenv").config({
  path: path.join(__dirname, "..", ".env"),
  quiet: true,
});

const { initSchema } = require("../db");
const troveNftAbi = require("../abi/troveNFT.json");
const troveManagerAbi = require("../abi/troveManager.json");

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`[scanRedemptions] Missing required env var: ${name}`);
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
  console.error("[scanRedemptions] FLR_MAINNET_SCAN_BLOCKS must be a positive integer");
  process.exit(1);
}
if (!Number.isInteger(FLR_PAUSE_MS) || FLR_PAUSE_MS < 0) {
  console.error("[scanRedemptions] FLR_MAINNET_SCAN_PAUSE_MS must be a non-negative integer");
  process.exit(1);
}
if (!Number.isInteger(OVERLAP_BLOCKS) || OVERLAP_BLOCKS < 0) {
  console.error("[scanRedemptions] SCAN_OVERLAP_BLOCKS must be a non-negative integer");
  process.exit(1);
}

const TRACK_ADDRESS_EIP55 = ethers.getAddress(TRACK_ADDRESS);
const TRACK_ADDRESS_LOWER = TRACK_ADDRESS_EIP55.toLowerCase();

const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");
const BURN_ADDRS = new Set([
  "0x0000000000000000000000000000000000000000",
  "0x000000000000000000000000000000000000dead",
]);

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

function addressFromTopic(t) {
  return ethers.getAddress("0x" + t.slice(26));
}

function tokenIdFromTopic(t) {
  return BigInt(t).toString();
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

function isBurn(addrLower) {
  return BURN_ADDRS.has(addrLower);
}

function readJson(p) {
  const raw = fs.readFileSync(p, "utf8");
  return JSON.parse(raw);
}

function scanWindowCount(fromBlock, latestBlock, maxBlocks) {
  return Math.ceil((latestBlock - fromBlock + 1) / (maxBlocks + 1));
}

function parseArgs() {
  const args = process.argv.slice(2);
  const troveOnly = args.includes("--trove-only");
  const resetTroveEvents = args.includes("--reset-trove-events");
  return { troveOnly, resetTroveEvents };
}

function resetTroveEventState(db) {
  console.log("[scanRedemptions] Resetting trove_events and trove_manager cursors...");
  db.prepare("DELETE FROM trove_events").run();
  db.prepare(
    "UPDATE scan_cursors SET last_scanned_block = 0 WHERE cursor_key LIKE 'trove_manager:%'"
  ).run();
}

async function ensureContracts(db, provider, chainId, contracts) {
  const upsert = db.prepare(`
    INSERT INTO contracts (contract_key, protocol, chain_id, address_eip55, default_start_block, trove_manager_address)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(contract_key) DO UPDATE SET
      protocol = excluded.protocol,
      chain_id = excluded.chain_id,
      address_eip55 = excluded.address_eip55,
      default_start_block = excluded.default_start_block,
      trove_manager_address = COALESCE(excluded.trove_manager_address, contracts.trove_manager_address),
      updated_at = datetime('now')
  `);

  for (const c of contracts) {
    const nft = new ethers.Contract(c.address, troveNftAbi, provider);
    const tmAddr = await nft.troveManager();
    upsert.run(c.key, c.protocol, chainId, ethers.getAddress(c.address), c.default_start_block, tmAddr);
    console.log(`[scanRedemptions] contract ${c.key} troveManager=${tmAddr}`);
  }
}

function ensureCursor(db, cursorKey, startBlock) {
  db.prepare(`
    INSERT INTO scan_cursors (cursor_key, start_block, last_scanned_block)
    VALUES (?, ?, 0)
    ON CONFLICT(cursor_key) DO NOTHING
  `).run(cursorKey, startBlock);
}

function updateCursor(db, cursorKey, lastBlock) {
  db.prepare(`
    UPDATE scan_cursors
    SET last_scanned_block = ?, updated_at = datetime('now')
    WHERE cursor_key = ?
  `).run(lastBlock, cursorKey);
}

async function scanLoanNftTransfers(db, provider, contract) {
  const cursorKey = `loan_nft:${contract.key}:transfer`;
  ensureCursor(db, cursorKey, contract.default_start_block);

  const cursor = db
    .prepare("SELECT start_block, last_scanned_block FROM scan_cursors WHERE cursor_key = ?")
    .get(cursorKey);

  const startBlock = cursor.start_block;
  const lastScanned = cursor.last_scanned_block;

  console.log(`\n=== NFT Transfers ${contract.key} ===`);
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

  const insertTransfer = db.prepare(`
    INSERT INTO loan_nft_transfers (
      contract_key, block_number, tx_hash, log_index,
      from_addr, to_addr, token_id, is_burned
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(contract_key, tx_hash, log_index) DO NOTHING
  `);

  const upsertTracked = db.prepare(`
    INSERT INTO tracked_troves (
      contract_key, token_id, first_seen_block, last_seen_block, is_burned, updated_at
    ) VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(contract_key, token_id) DO UPDATE SET
      last_seen_block = excluded.last_seen_block,
      is_burned = excluded.is_burned,
      updated_at = datetime('now')
  `);

  let lastGoodBlock = fromBlock - 1;
  let windowIndex = 0;
  let totalMatches = 0;

  for (let b = fromBlock; b <= latestBlock; b += FLR_SCAN_BLOCKS + 1) {
    const toBlock = Math.min(b + FLR_SCAN_BLOCKS, latestBlock);
    windowIndex++;

    console.log(`  [${windowIndex}/${totalWindows}] blocks ${b} → ${toBlock}`);

    const res = await getLogsWithRetry(provider, {
      address: ethers.getAddress(contract.address),
      fromBlock: b,
      toBlock,
      topics: [TRANSFER_TOPIC],
    });

    if (!res.ok) {
      console.warn(`  🚫 window failed permanently ${b}-${toBlock}`);
      break;
    }

    let matched = 0;
    let skippedNoIndex = 0;

    const tx = db.transaction((events) => {
      for (const e of events) {
        insertTransfer.run(
          contract.key,
          e.blockNumber,
          e.txHash,
          e.logIndex,
          e.fromLower,
          e.toLower,
          e.tokenId,
          e.isBurned ? 1 : 0
        );
        upsertTracked.run(
          contract.key,
          e.tokenId,
          e.blockNumber,
          e.blockNumber,
          e.isBurned ? 1 : 0
        );
      }
    });

    const events = [];
    for (const lg of res.logs) {
      if (!lg.topics || lg.topics.length < 4) continue;
      const li = getStableLogIndex(lg);
      if (li == null) {
        skippedNoIndex++;
        continue;
      }
      const txHash = lg.transactionHash;
      if (!txHash) continue;

      const from = addressFromTopic(lg.topics[1]);
      const to = addressFromTopic(lg.topics[2]);
      const fromLower = from.toLowerCase();
      const toLower = to.toLowerCase();

      if (fromLower !== TRACK_ADDRESS_LOWER && toLower !== TRACK_ADDRESS_LOWER) continue;

      const tokenId = tokenIdFromTopic(lg.topics[3]);
      const isBurned = isBurn(toLower);

      events.push({
        blockNumber: lg.blockNumber,
        txHash,
        logIndex: li,
        fromLower,
        toLower,
        tokenId,
        isBurned,
      });
    }

    if (events.length) {
      tx(events);
      matched += events.length;
    }

    totalMatches += matched;
    if (skippedNoIndex > 0) {
      console.warn(`    ⚠️ skipped ${skippedNoIndex} logs with missing/invalid log index`);
    }

    console.log(`    logs=${res.logs.length} matched=${matched} total_matched=${totalMatches}`);
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

function loadTrackedTroves(db, contractKey) {
  const rows = db
    .prepare("SELECT token_id FROM tracked_troves WHERE contract_key = ?")
    .all(contractKey);
  return new Set(rows.map((r) => r.token_id));
}

function buildEventData(parsed) {
  const data = {};
  const inputs = parsed.fragment?.inputs || [];
  for (let i = 0; i < inputs.length; i += 1) {
    const name = inputs[i]?.name;
    if (!name || name === "_troveId") continue;
    const val = parsed.args?.[i];
    data[name] = val?.toString?.() ?? String(val);
  }
  return data;
}

async function scanTroveManagerEvents(db, provider, contract) {
  const cursorKey = `trove_manager:${contract.key}:events`;
  ensureCursor(db, cursorKey, contract.default_start_block);

  const cursor = db
    .prepare("SELECT start_block, last_scanned_block FROM scan_cursors WHERE cursor_key = ?")
    .get(cursorKey);

  const startBlock = cursor.start_block;
  const lastScanned = cursor.last_scanned_block;

  console.log(`\n=== TroveManager Events ${contract.key} ===`);
  console.log(`  start_block=${startBlock} last_scanned=${lastScanned}`);

  const latestBlock = await provider.getBlockNumber();
  console.log(`  latestBlock=${latestBlock}`);

  let fromBlock = lastScanned > 0 ? Math.max(startBlock, lastScanned - OVERLAP_BLOCKS) : startBlock;
  if (fromBlock > latestBlock) {
    console.log("  ⏭️ nothing to scan");
    return;
  }

  const iface = new ethers.Interface(troveManagerAbi);
  const topics = [
    iface.getEvent("Redemption").topicHash,
    iface.getEvent("RedemptionFeePaidToTrove").topicHash,
    iface.getEvent("TroveUpdated").topicHash,
    iface.getEvent("TroveOperation").topicHash,
  ];

  const tracked = loadTrackedTroves(db, contract.key);
  console.log(`  tracked_troves=${tracked.size}`);

  const totalWindows = scanWindowCount(fromBlock, latestBlock, FLR_SCAN_BLOCKS);
  console.log(
    `  windows=${totalWindows} window_size=${FLR_SCAN_BLOCKS} overlap=${OVERLAP_BLOCKS} pause=${FLR_PAUSE_MS}ms`
  );

  const insertRedemption = db.prepare(`
    INSERT INTO redemption_events (
      contract_key, block_number, tx_hash, log_index,
      attempted_bold, actual_bold, eth_sent, eth_fee, price, redemption_price
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(contract_key, tx_hash, log_index) DO NOTHING
  `);

  const insertTroveEvent = db.prepare(`
    INSERT INTO trove_events (
      contract_key, event_name, block_number, tx_hash, log_index, trove_id, data_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(contract_key, tx_hash, log_index) DO NOTHING
  `);

  let lastGoodBlock = fromBlock - 1;
  let windowIndex = 0;
  let totalEvents = 0;
  let totalRedemptions = 0;
  let totalTroveEvents = 0;

  for (let b = fromBlock; b <= latestBlock; b += FLR_SCAN_BLOCKS + 1) {
    const toBlock = Math.min(b + FLR_SCAN_BLOCKS, latestBlock);
    windowIndex++;

    console.log(`  [${windowIndex}/${totalWindows}] blocks ${b} → ${toBlock}`);

    const res = await getLogsWithRetry(provider, {
      address: ethers.getAddress(contract.troveManager),
      fromBlock: b,
      toBlock,
      topics: [topics],
    });

    if (!res.ok) {
      console.warn(`  🚫 window failed permanently ${b}-${toBlock}`);
      break;
    }

    let skippedNoIndex = 0;
    let windowRedemptions = 0;
    let windowTroveEvents = 0;

    const tx = db.transaction((items) => {
      for (const item of items) {
        if (item.kind === "redemption") {
          insertRedemption.run(
            contract.key,
            item.blockNumber,
            item.txHash,
            item.logIndex,
            item.attemptedBold,
            item.actualBold,
            item.ethSent,
            item.ethFee,
            item.price,
            item.redemptionPrice
          );
        } else if (item.kind === "trove") {
          insertTroveEvent.run(
            contract.key,
            item.eventName,
            item.blockNumber,
            item.txHash,
            item.logIndex,
            item.troveId,
            item.dataJson
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

      if (parsed.name === "Redemption") {
        const args = parsed.args;
        items.push({
          kind: "redemption",
          blockNumber: lg.blockNumber,
          txHash,
          logIndex: li,
          attemptedBold: args._attemptedBoldAmount.toString(),
          actualBold: args._actualBoldAmount.toString(),
          ethSent: args._ETHSent.toString(),
          ethFee: args._ETHFee.toString(),
          price: args._price.toString(),
          redemptionPrice: args._redemptionPrice.toString(),
        });
        windowRedemptions++;
        continue;
      }

      if (
        parsed.name === "RedemptionFeePaidToTrove" ||
        parsed.name === "TroveUpdated" ||
        parsed.name === "TroveOperation"
      ) {
        const troveId = parsed.args._troveId?.toString();
        if (!troveId || !tracked.has(troveId)) continue;
        const data = buildEventData(parsed);

        items.push({
          kind: "trove",
          eventName: parsed.name,
          blockNumber: lg.blockNumber,
          txHash,
          logIndex: li,
          troveId,
          dataJson: JSON.stringify(data),
        });
        windowTroveEvents++;
      }
    }

    if (items.length) {
      tx(items);
    }

    totalEvents += items.length;
    totalRedemptions += windowRedemptions;
    totalTroveEvents += windowTroveEvents;

    if (skippedNoIndex > 0) {
      console.warn(`    ⚠️ skipped ${skippedNoIndex} logs with missing/invalid log index`);
    }

    console.log(
      `    logs=${res.logs.length} items=${items.length} redemptions=${windowRedemptions} trove_events=${windowTroveEvents}`
    );

    lastGoodBlock = toBlock;
    if (FLR_PAUSE_MS > 0) await sleep(FLR_PAUSE_MS);
  }

  if (lastGoodBlock >= fromBlock) {
    updateCursor(db, cursorKey, lastGoodBlock);
    console.log(`  ✅ advanced cursor to ${lastGoodBlock}`);
  } else {
    console.log("  ⏭️ cursor NOT advanced");
  }

  console.log(
    `  totals: redemptions=${totalRedemptions} trove_events=${totalTroveEvents} items=${totalEvents}`
  );
}

async function main() {
  const { troveOnly, resetTroveEvents } = parseArgs();
  const configPath = path.join(__dirname, "..", "data", "loan_contracts.json");
  const cfg = readJson(configPath);
  const chainCfg = cfg?.chains?.FLR;
  if (!chainCfg) {
    console.error("[scanRedemptions] Missing FLR chain config in data/loan_contracts.json");
    process.exit(1);
  }

  const contracts = chainCfg.contracts || [];
  if (!contracts.length) {
    console.error("[scanRedemptions] No contracts found in data/loan_contracts.json");
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(FLR_RPC_URL);
  await provider.getNetwork();

  const db = new Database(DB_PATH);
  try {
    initSchema(db);

    if (resetTroveEvents) {
      resetTroveEventState(db);
    }

    await ensureContracts(db, provider, "FLR", contracts);

    if (!troveOnly) {
      for (const c of contracts) {
        await scanLoanNftTransfers(db, provider, c);
      }
    }

    for (const c of contracts) {
      const row = db
        .prepare("SELECT trove_manager_address FROM contracts WHERE contract_key = ?")
        .get(c.key);
      if (!row?.trove_manager_address) {
        console.warn(`[scanRedemptions] Missing troveManager for ${c.key}, skipping`);
        continue;
      }
      const trackedCount = db
        .prepare("SELECT COUNT(*) AS n FROM tracked_troves WHERE contract_key = ?")
        .get(c.key)?.n;
      if (!trackedCount) {
        console.warn(
          `[scanRedemptions] No tracked troves for ${c.key}. ` +
            "Run without --trove-only to populate tracked_troves."
        );
      }
      await scanTroveManagerEvents(db, provider, {
        ...c,
        troveManager: row.trove_manager_address,
      });
    }

    console.log("\n[scanRedemptions] DONE");
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error("[scanRedemptions] FATAL:", err);
  process.exit(1);
});
