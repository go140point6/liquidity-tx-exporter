# Liquidity TX Exporter

Local Node.js app to scan Flare (Enosys Liquity v2 fork) and export:
- Trove activity (redemptions, adjustments, opens/closes) for a single address.
- Stability Pool activity (deposits/withdrawals) and derived “exchange” rows.

Data is stored in a local SQLite DB and exported to CSV for review.

## Setup

1. Install dependencies:
```
npm install
```

2. Configure `.env`:
- `DB_PATH`
- `FLR_MAINNET_SCAN`
- `FLR_MAINNET_SCAN_BLOCKS`
- `FLR_MAINNET_SCAN_PAUSE_MS`
- `SCAN_OVERLAP_BLOCKS`
- `TRACK_ADDRESS`

## Commands

### Trove / Loan Scans

- Scan loan NFT transfers + trove manager events:
```
npm run scan:redemptions
```

- Rescan only trove manager events (clears and rebuilds trove_events):
```
npm run rescan:trove-events
```

### Trove Reports

- Recent trove activity (human-readable):
```
npm run report:recent -- --limit=10
```

- Recent trove activity (CSV output):
```
npm run report:recent -- --csv --out=./data/tx_report.csv
```

- Report a single redemption tx:
```
npm run report:redemption -- --tx=0x...
```

### Stability Pool Scans

- Scan stability pool events:
```
npm run scan:sp
```

- Reset stability pool tables and cursors (full rescan):
```
npm run rescan:sp
npm run scan:sp
```

### Stability Pool Reports

- Report stability pool events (CSV output):
```
npm run report:sp -- --csv --out=./data/sp_report.csv
```

Notes:
- `report:sp` includes “EXCHANGE” rows when a deposit loss + collateral gain happened.
- It also includes “EXCHPENDING” rows, computed from current on-chain state since last operation.

## Output Files

- Trove report CSV: `./data/tx_report.csv` (default)
- Stability Pool report CSV: `./data/sp_report.csv` (default)

## Data Sources

- Loan NFT contracts and start blocks: `data/loan_contracts.json`
- Stability pools: `data/stability_pools.json`
- ABIs: `abi/`
