import express from "express";
import { decodeAddress, encodeAddress } from "@polkadot/util-crypto";
import db from "../db.js";
import { getTreasuryByCid } from "../treasuryConfig.js";

const KSM_SS58_PREFIX = 2;
const USDC_GENERAL_INDEX = "1,337";
const USDC_DECIMALS = 6;
const KSM_DECIMALS = 12;
// Bridge fees on small amounts can take up to ~19% of the sent amount; the
// remaining 5% buffer absorbs variability between Polkadot/Kusama bridge hops.
const BRIDGE_FEE_TOLERANCE_PCT = 25n;
// Bridge end-to-end delivery time observed in the indexer ranges up to ~11 min;
// 30 min covers congestion and gives a generous match window.
const BRIDGE_DELIVERY_WINDOW_MS = 30 * 60 * 1000;

const leaderboard = express.Router();

const stripCommas = (s) =>
    s == null ? null : String(s).replace(/,/g, "");
const toBigInt = (s) => (s == null ? 0n : BigInt(stripCommas(s) ?? "0"));
const sumBigInt = (arr) => arr.reduce((a, b) => a + b, 0n);

/**
 * Re-encode an AccountId32 hex (0x...) to the Kusama-prefix ss58 string.
 * Returns null on malformed input.
 */
function hexToKsmSs58(hex) {
    if (typeof hex !== "string") return null;
    try {
        return encodeAddress(hex, KSM_SS58_PREFIX);
    } catch {
        return null;
    }
}

/**
 * Re-encode any ss58 address to Kusama prefix (2). Identity is keyed by public
 * key, not prefix — so to collapse "same donor, different prefix" rows in the
 * leaderboard we canonicalise every donor address before grouping. Returns the
 * input unchanged on decode failure.
 */
function toCanonicalSs58(ss58) {
    if (typeof ss58 !== "string") return ss58;
    try {
        return encodeAddress(decodeAddress(ss58), KSM_SS58_PREFIX);
    } catch {
        return ss58;
    }
}

/**
 * Returns true if a `transferAssetsUsingTypeAndThen` args object targets the
 * Kusama ecosystem (parents: 2, X2[GlobalConsensus(Kusama), Parachain(_)]).
 */
function isKusamaBound(args) {
    const dest = args?.dest?.V5 || args?.dest?.V4;
    const gc = dest?.interior?.X2?.[0]?.GlobalConsensus;
    if (gc === "Kusama") return true;
    if (gc && typeof gc === "object" && "Kusama" in gc) return true;
    return false;
}

/**
 * Yield every `polkadotXcm.transferAssetsUsingTypeAndThen`-like call args found
 * inside an extrinsic. The dapp wraps the donation in `utility.batchAll` (to
 * pre-swap USDC→DOT for bridge fees), so the source call may sit one level
 * below the top-level extrinsic. Supports both nested utility.batch* and
 * direct polkadotXcm.transferAssetsUsingTypeAndThen.
 */
function extractTutCalls(extrinsic) {
    if (
        extrinsic.section === "polkadotXcm" &&
        extrinsic.method === "transferAssetsUsingTypeAndThen"
    ) {
        return [extrinsic.args];
    }
    if (
        extrinsic.section === "utility" &&
        (extrinsic.method === "batch" ||
            extrinsic.method === "batchAll" ||
            extrinsic.method === "forceBatch")
    ) {
        const calls = extrinsic.args?.calls;
        if (!Array.isArray(calls)) return [];
        return calls
            .filter(
                (c) =>
                    c?.section === "polkadotXcm" &&
                    c?.method === "transferAssetsUsingTypeAndThen",
            )
            .map((c) => c.args);
    }
    return [];
}

/**
 * Match a cross-chain KAH `foreignAssets.Deposited` event back to its source
 * PAH extrinsic by scanning DepositAsset beneficiaries within the bridge
 * delivery window. Looks at direct `polkadotXcm.transferAssetsUsingTypeAndThen`
 * AND `utility.batch*`-wrapped calls (the dapp's actual pattern when an
 * upfront USDC→DOT fee swap is needed).
 *
 * Returns the donor ss58 (top-level signer of the PAH extrinsic) if found.
 */
async function findCrossChainDonor(dep, treasuryKahSs58) {
    const t = dep.timestamp;
    const depAmount = toBigInt(dep.data?.amount);
    const candidates = await db.indexerAssetHubPolkadot
        .collection("extrinsics")
        .find({
            success: true,
            timestamp: { $gte: t - BRIDGE_DELIVERY_WINDOW_MS, $lte: t + 60_000 },
            $or: [
                {
                    section: "polkadotXcm",
                    method: "transferAssetsUsingTypeAndThen",
                },
                {
                    section: "utility",
                    method: {
                        $in: ["batch", "batchAll", "forceBatch"],
                    },
                    "args.calls.section": "polkadotXcm",
                    "args.calls.method": "transferAssetsUsingTypeAndThen",
                },
            ],
        })
        .toArray();

    for (const x of candidates) {
        const inner = extractTutCalls(x);
        for (const args of inner) {
            if (!isKusamaBound(args)) continue;
            // Total source-side amount being transferred (used as upper bound
            // for Wild deposit attribution).
            const totalAssets =
                args?.assets?.V5 || args?.assets?.V4 || [];
            const totalSrcAmt = totalAssets.reduce((acc, a) => {
                const f = a?.fun?.Fungible;
                return f == null ? acc : acc + toBigInt(f);
            }, 0n);

            const xcm =
                args?.custom_xcm_on_dest?.V5 ||
                args?.custom_xcm_on_dest?.V4;
            if (!Array.isArray(xcm)) continue;
            for (const ins of xcm) {
                const dep2 = ins?.DepositAsset;
                if (!dep2) continue;
                const benHex =
                    dep2.beneficiary?.interior?.X1?.[0]?.AccountId32?.id;
                const benSs58 = hexToKsmSs58(benHex);
                if (benSs58 !== treasuryKahSs58) continue;

                // Definite: amount-bound check (avoids attributing a tiny
                // unrelated source to a large destination inflow).
                const definite = dep2.assets?.Definite;
                if (Array.isArray(definite)) {
                    for (const a of definite) {
                        const fung = a?.fun?.Fungible;
                        if (fung == null) continue;
                        const srcAmt = toBigInt(fung);
                        const slack =
                            (srcAmt * BRIDGE_FEE_TOLERANCE_PCT) / 100n;
                        if (
                            srcAmt >= depAmount &&
                            srcAmt - depAmount <= slack
                        ) {
                            return x.signer?.Id ?? null;
                        }
                    }
                }

                // Wild: "deposit residue to this beneficiary". The exact amount
                // is computed at destination after BuyExecution + earlier
                // Definite deposits. Match on beneficiary alone, but require
                // the source's total transferred amount to be plausible
                // (≥ depAmount, otherwise it can't be the source).
                if (dep2.assets?.Wild && totalSrcAmt >= depAmount) {
                    return x.signer?.Id ?? null;
                }
            }
        }
    }
    return null;
}

/**
 * Build the donor leaderboard for a USDC treasury on KAH.
 */
async function leaderboardUsdcTreasury(treasury) {
    const kahAccount = treasury.kahAccount;

    // Same-chain donations: foreignAssets.Transferred where data.to === treasury
    const sameChainAgg = await db.indexerAssetHub
        .collection("events")
        .aggregate([
            {
                $match: {
                    section: "foreignAssets",
                    method: "Transferred",
                    "data.to": kahAccount,
                    "data.assetId.interior.X4.3.GeneralIndex":
                        USDC_GENERAL_INDEX,
                },
            },
            {
                $group: {
                    _id: "$data.from",
                    count: { $sum: 1 },
                    totalRaw: {
                        $sum: {
                            $toLong: {
                                $replaceAll: {
                                    input: "$data.amount",
                                    find: ",",
                                    replacement: "",
                                },
                            },
                        },
                    },
                },
            },
        ])
        .toArray();

    // Cross-chain inflows: foreignAssets.Deposited where data.who === treasury.
    // Attribute each to the source PAH signer if reachable, else "anonymous".
    const crossChainEvents = await db.indexerAssetHub
        .collection("events")
        .find({
            section: "foreignAssets",
            method: "Deposited",
            "data.who": kahAccount,
            "data.assetId.interior.X4.3.GeneralIndex": USDC_GENERAL_INDEX,
        })
        .sort({ timestamp: 1 })
        .toArray();

    const crossChainAnonymous = [];
    const crossChainByDonor = new Map();
    for (const e of crossChainEvents) {
        const amt = toBigInt(e.data?.amount);
        const donor = await findCrossChainDonor(e, kahAccount);
        if (donor) {
            const key = toCanonicalSs58(donor);
            const prev = crossChainByDonor.get(key) ?? {
                count: 0,
                totalRaw: 0n,
            };
            prev.count += 1;
            prev.totalRaw += amt;
            crossChainByDonor.set(key, prev);
        } else {
            crossChainAnonymous.push({
                timestamp: e.timestamp,
                amountRaw: amt.toString(),
            });
        }
    }

    // Outflows: same-chain transfers OUT, plus burned (XCM/swap-credit exits).
    const outAgg = await db.indexerAssetHub
        .collection("events")
        .aggregate([
            {
                $match: {
                    section: "foreignAssets",
                    "data.assetId.interior.X4.3.GeneralIndex":
                        USDC_GENERAL_INDEX,
                    $or: [
                        { method: "Transferred", "data.from": kahAccount },
                        { method: "Withdrawn", "data.who": kahAccount },
                        { method: "Burned", "data.owner": kahAccount },
                    ],
                },
            },
            {
                $group: {
                    _id: null,
                    totalRaw: {
                        $sum: {
                            $toLong: {
                                $replaceAll: {
                                    input: "$data.amount",
                                    find: ",",
                                    replacement: "",
                                },
                            },
                        },
                    },
                },
            },
        ])
        .toArray();

    // Merge same-chain + cross-chain into a single ranked donor list, keyed
    // by canonical (Kusama-prefix) ss58 so the same donor donating from both
    // a Kusama-encoded and a Polkadot-encoded address collapses into one row.
    const donorMap = new Map();
    for (const r of sameChainAgg) {
        if (!r._id) continue;
        const key = toCanonicalSs58(r._id);
        const prev = donorMap.get(key) ?? { count: 0, totalRaw: 0n };
        prev.count += r.count;
        prev.totalRaw += BigInt(r.totalRaw);
        donorMap.set(key, prev);
    }
    for (const [ss58, agg] of crossChainByDonor) {
        const prev = donorMap.get(ss58) ?? { count: 0, totalRaw: 0n };
        prev.count += agg.count;
        prev.totalRaw += agg.totalRaw;
        donorMap.set(ss58, prev);
    }

    const donors = [...donorMap.entries()]
        .map(([ss58, v]) => ({
            ss58,
            count: v.count,
            totalRaw: v.totalRaw.toString(),
        }))
        .sort((a, b) => {
            const d = BigInt(b.totalRaw) - BigInt(a.totalRaw);
            return d > 0n ? 1 : d < 0n ? -1 : 0;
        });

    const totalInflowsRaw =
        sumBigInt(sameChainAgg.map((r) => BigInt(r.totalRaw))) +
        sumBigInt(
            [...crossChainByDonor.values()].map((v) => v.totalRaw),
        ) +
        sumBigInt(
            crossChainAnonymous.map((a) => BigInt(a.amountRaw)),
        );
    const totalOutflowsRaw = BigInt(outAgg[0]?.totalRaw ?? 0);

    return {
        recipient: {
            name: treasury.name,
            cid: treasury.cid,
            kahAccount: treasury.kahAccount,
            encointerAccount: treasury.address,
        },
        token: "USDC",
        decimals: USDC_DECIMALS,
        totalInflowsRaw: totalInflowsRaw.toString(),
        totalOutflowsRaw: totalOutflowsRaw.toString(),
        donors,
        crossChainAnonymous,
    };
}

/**
 * Build the donor leaderboard for an Encointer KSM faucet.
 */
async function leaderboardKsmFaucet(account, registryEntry) {
    const sameChainAgg = await db.events
        .aggregate([
            {
                $match: {
                    section: "balances",
                    method: "Transfer",
                    "data.to": account,
                },
            },
            {
                $group: {
                    _id: "$data.from",
                    count: { $sum: 1 },
                    totalRaw: {
                        $sum: {
                            $toLong: {
                                $replaceAll: {
                                    input: "$data.amount",
                                    find: ",",
                                    replacement: "",
                                },
                            },
                        },
                    },
                },
            },
        ])
        .toArray();

    // XCM-delivered deposits land as balances.Deposit (anonymous from our perspective)
    const xcmDeposits = await db.events
        .find({
            section: "balances",
            method: "Deposit",
            "data.who": account,
        })
        .sort({ timestamp: 1 })
        .toArray();

    const outAgg = await db.events
        .aggregate([
            {
                $match: {
                    section: "balances",
                    $or: [
                        { method: "Transfer", "data.from": account },
                        { method: "Withdraw", "data.who": account },
                    ],
                },
            },
            {
                $group: {
                    _id: null,
                    totalRaw: {
                        $sum: {
                            $toLong: {
                                $replaceAll: {
                                    input: "$data.amount",
                                    find: ",",
                                    replacement: "",
                                },
                            },
                        },
                    },
                },
            },
        ])
        .toArray();

    // Collapse same-key donors across prefixes by canonicalising to Kusama ss58.
    const faucetDonorMap = new Map();
    for (const r of sameChainAgg) {
        if (!r._id) continue;
        const key = toCanonicalSs58(r._id);
        const prev = faucetDonorMap.get(key) ?? { count: 0, totalRaw: 0n };
        prev.count += r.count;
        prev.totalRaw += BigInt(r.totalRaw);
        faucetDonorMap.set(key, prev);
    }
    const donors = [...faucetDonorMap.entries()]
        .map(([ss58, v]) => ({
            ss58,
            count: v.count,
            totalRaw: v.totalRaw.toString(),
        }))
        .sort((a, b) => {
            const d = BigInt(b.totalRaw) - BigInt(a.totalRaw);
            return d > 0n ? 1 : d < 0n ? -1 : 0;
        });

    const sameChainTotal = sumBigInt(
        sameChainAgg.map((r) => BigInt(r.totalRaw)),
    );
    const xcmDepositTotal = sumBigInt(
        xcmDeposits.map((e) => toBigInt(e.data?.amount)),
    );

    return {
        recipient: {
            name: registryEntry?.name ?? account,
            account,
        },
        token: "KSM",
        decimals: KSM_DECIMALS,
        totalInflowsRaw: (sameChainTotal + xcmDepositTotal).toString(),
        totalOutflowsRaw: BigInt(outAgg[0]?.totalRaw ?? 0).toString(),
        donors,
        crossChainAnonymous: xcmDeposits.map((e) => ({
            timestamp: e.timestamp,
            amountRaw: toBigInt(e.data?.amount).toString(),
        })),
    };
}

/**
 * Scrape the indexer for all-time faucets. Drained / closed faucets are
 * filtered out so the registry reflects what's currently active.
 *
 * Returns: [{ account, name, createdAtBlock, amountRaw, dripRaw, signer }]
 */
async function discoverFaucets() {
    const created = await db.events
        .find({
            section: "encointerFaucet",
            method: "FaucetCreated",
        })
        .sort({ blockNumber: 1 })
        .toArray();

    // FaucetCreated event data shape (positional): [faucetAccount, name].
    // No Closed/Drained/Dissolved events emitted by the current pallet; all
    // discovered faucets are considered live.
    const out = [];
    for (const e of created) {
        const data = e.data ?? [];
        const account = data[0] ?? null;
        const name = typeof data[1] === "string" ? data[1] : null;
        if (!account) continue;
        out.push({ account, name, createdAtBlock: e.blockNumber });
    }
    return out;
}

/**
 * @swagger
 * /v1/leaderboard/{cid}:
 *   get:
 *     description: Donor leaderboard for a community treasury (USDC on KAH).
 *     parameters:
 *       - in: path
 *         name: cid
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: token
 *         schema: { type: string, default: USDC }
 *     responses:
 *       '200': { description: Success }
 *       '404': { description: Unknown community }
 *       '400': { description: Unsupported token for this recipient }
 */
leaderboard.get("/:cid", async function (req, res, next) {
    try {
        const cid = req.params.cid;
        const token = String(req.query.token ?? "USDC").toUpperCase();
        const treasury = getTreasuryByCid(cid);
        if (!treasury) return res.status(404).send({ error: "unknown cid" });
        if (token !== "USDC") {
            return res
                .status(400)
                .send({ error: "only USDC supported for treasuries" });
        }
        const result = await leaderboardUsdcTreasury(treasury);
        res.send(result);
    } catch (e) {
        next(e);
    }
});

/**
 * @swagger
 * /v1/leaderboard/faucets:
 *   get:
 *     description: Donor leaderboards for every active Encointer KSM faucet.
 *     responses:
 *       '200': { description: Success }
 */
leaderboard.get("/faucets/all", async function (req, res, next) {
    try {
        const registry = await discoverFaucets();
        const faucets = await Promise.all(
            registry.map((entry) =>
                leaderboardKsmFaucet(entry.account, entry).then((board) => ({
                    ...board,
                    createdAtBlock: entry.createdAtBlock,
                })),
            ),
        );
        res.send({ faucets });
    } catch (e) {
        next(e);
    }
});

export default leaderboard;
