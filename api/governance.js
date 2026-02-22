import express from "express";
import db from "../db.js";

const governance = express.Router();

// State from .toJSON() is { variantName: null | data }, e.g. { enacted: null }
function stateKey(state) {
    if (typeof state === "string") return state.toLowerCase();
    if (typeof state === "object" && state !== null) return Object.keys(state)[0];
    return "";
}

const TERMINAL_KEYS = new Set(["enacted", "approved", "rejected", "supersededby", "supersededBy"]);

function isTerminal(state) {
    return TERMINAL_KEYS.has(stateKey(state));
}

const STATE_LABELS = {
    enacted: "Enacted",
    approved: "Approved",
    rejected: "Rejected",
    ongoing: "Ongoing",
    confirming: "Confirming",
    supersededBy: "SupersededBy",
};

function stateLabel(state) {
    return STATE_LABELS[stateKey(state)] || stateKey(state) || "Unknown";
}

function actionSummary(action) {
    if (!action || typeof action !== "object") return String(action);
    const variant = Object.keys(action)[0];
    const args = action[variant];
    switch (variant) {
        case "updateNominalIncome":
            return `Update nominal income for ${cidShort(args[0])} to ${formatFixedPoint(args[1])}`;
        case "updateDemurrage":
            return `Update demurrage for ${cidShort(args[0])}`;
        case "addLocation":
            return `Add location to ${cidShort(args[0])}`;
        case "removeLocation":
            return `Remove location from ${cidShort(args[0])}`;
        case "updateCommunityMetadata":
            return `Update metadata for ${cidShort(args[0])}`;
        case "setInactivityTimeout":
            return `Set inactivity timeout to ${args}`;
        case "petition":
            return `Petition: ${args[1] || ""}`.slice(0, 120);
        case "spendNative":
            return `Spend ${formatNativeBalance(args[2])} KSM to ${addrShort(args[1])}`;
        case "spendAsset":
            return `Spend asset to ${addrShort(args[1])}`;
        case "issueSwapNativeOption":
            return `Issue swap native option for ${cidShort(args[0])}`;
        case "issueSwapAssetOption":
            return `Issue swap asset option for ${cidShort(args[0])}`;
        default:
            return variant;
    }
}

function cidShort(cid) {
    if (!cid) return "?";
    if (typeof cid === "string") return cid.slice(0, 10);
    // { geohash, digest } — hex-encoded
    const geo = cid.geohash || cid.Geohash || "";
    return typeof geo === "string" ? geo.slice(0, 12) : JSON.stringify(cid).slice(0, 20);
}

function addrShort(addr) {
    if (!addr) return "?";
    return String(addr).slice(0, 8) + "...";
}

// FixedI64F64 { bits: i128 } — 64.64 fixed point (community currency amounts)
function formatFixedPoint(raw) {
    if (raw === undefined || raw === null) return "?";
    const bits = typeof raw === "object" && raw.bits !== undefined ? raw.bits : raw;
    const n = BigInt(bits);
    const intPart = Number(n >> 64n);
    const fracPart = Number(n & ((1n << 64n) - 1n)) / 2 ** 64;
    return (intPart + fracPart).toFixed(1);
}

// Plain Balance u128 — 12 decimal places (KSM)
function formatNativeBalance(raw) {
    if (raw === undefined || raw === null) return "?";
    return (Number(BigInt(raw)) / 1e12).toFixed(2);
}

function actionType(action) {
    if (!action || typeof action !== "object") return String(action);
    return Object.keys(action)[0];
}

// Extract community identifier string from action, or null for global actions
function actionCommunityId(action) {
    if (!action || typeof action !== "object") return null;
    const variant = Object.keys(action)[0];
    const args = action[variant];
    if (variant === "setInactivityTimeout") return null;
    // First arg is CommunityIdentifier or Option<CommunityIdentifier>
    const cid = Array.isArray(args) ? args[0] : args;
    if (!cid || typeof cid !== "object" || !cid.geohash) return null;
    return `${cid.geohash}:${cid.digest}`;
}

/**
 * @swagger
 * /v1/governance/proposals:
 *   get:
 *     description: Retrieve all encointer democracy proposals with tallies
 *     tags:
 *       - governance
 *     responses:
 *       '200':
 *         description: Array of proposals
 */
governance.get("/proposals", async function (req, res, next) {
    try {
        const api = req.app.get("api");
        const proposalCount =
            (await api.query.encointerDemocracy.proposalCount()).toJSON() || 0;

        const proposalLifetime =
            api.consts.encointerDemocracy.proposalLifetime?.toJSON();
        const confirmationPeriod =
            api.consts.encointerDemocracy.confirmationPeriod?.toJSON();

        const results = [];

        for (let id = 1; id <= proposalCount; id++) {
            // Check cache for terminal proposals
            const cached = await db.getFromGeneralCache(
                "governance-proposal",
                { id }
            );
            if (cached.length > 0) {
                results.push(cached[0]);
                continue;
            }

            const [proposalRaw, tallyRaw] = await Promise.all([
                api.query.encointerDemocracy.proposals(id),
                api.query.encointerDemocracy.tallies(id),
            ]);

            if (proposalRaw.isNone) continue;

            const proposal = proposalRaw.toJSON();
            const tally = tallyRaw.isSome ? tallyRaw.toJSON() : { turnout: 0, ayes: 0 };

            const electorate = proposal.electorateSize || proposal.electorate_size || 0;
            const turnout = tally.turnout || 0;
            const ayes = tally.ayes || 0;
            const nays = turnout - ayes;
            const turnoutPct = electorate > 0 ? (turnout / electorate) * 100 : 0;
            const approvalPct = turnout > 0 ? (ayes / turnout) * 100 : 0;

            // AQB threshold: sqrt(electorate) / (sqrt(electorate) + sqrt(turnout)) * 100
            const sqrtE = Math.sqrt(electorate);
            const sqrtT = Math.sqrt(turnout);
            const thresholdPct =
                sqrtE + sqrtT > 0 ? (sqrtE / (sqrtE + sqrtT)) * 100 : 100;

            const state = proposal.state;
            const entry = {
                id,
                start: proposal.start || proposal.startMoment,
                startCindex: proposal.startCindex || proposal.start_cindex,
                actionType: actionType(proposal.action),
                actionSummary: actionSummary(proposal.action),
                communityId: actionCommunityId(proposal.action),
                state: stateLabel(state),
                electorateSize: electorate,
                turnout,
                ayes,
                nays,
                turnoutPct: Math.round(turnoutPct * 10) / 10,
                approvalPct: Math.round(approvalPct * 10) / 10,
                thresholdPct: Math.round(thresholdPct * 10) / 10,
                passing: approvalPct >= thresholdPct && turnout > 0,
                proposalLifetime,
                confirmationPeriod,
            };

            // Cache terminal proposals
            if (isTerminal(state)) {
                await db.insertIntoGeneralCache(
                    "governance-proposal",
                    { id },
                    entry
                );
            }

            results.push(entry);
        }

        res.send(JSON.stringify(results));
    } catch (e) {
        next(e);
    }
});

/**
 * @swagger
 * /v1/governance/vote-timing:
 *   get:
 *     description: Retrieve vote events and attesting phase windows
 *     tags:
 *       - governance
 *     responses:
 *       '200':
 *         description: Votes and attesting windows
 */
governance.get("/vote-timing", async function (req, res, next) {
    try {
        const [votes, attestingWindows] = await Promise.all([
            db.events
                .find({
                    section: "encointerDemocracy",
                    method: "VotePlaced",
                })
                .sort({ timestamp: 1 })
                .toArray(),
            db.blocks
                .aggregate([
                    { $match: { phase: "ATTESTING" } },
                    {
                        $group: {
                            _id: "$cindex",
                            start: { $min: "$timestamp" },
                            end: { $max: "$timestamp" },
                        },
                    },
                    { $sort: { _id: 1 } },
                ])
                .toArray(),
        ]);

        res.send(
            JSON.stringify({
                votes: votes.map((v) => ({
                    proposalId: v.data?.proposalId ?? v.data?.[0],
                    timestamp: v.timestamp,
                    vote:
                        v.data?.vote ??
                        (v.data?.[1] === "Aye" || v.data?.[1]?.aye !== undefined
                            ? "Aye"
                            : "Nay"),
                    numVotes: v.data?.numVotes ?? v.data?.[2],
                })),
                attestingWindows: attestingWindows.map((w) => ({
                    cindex: w._id,
                    start: w.start,
                    end: w.end,
                })),
            })
        );
    } catch (e) {
        next(e);
    }
});

export default governance;
