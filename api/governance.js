import express from "express";
import db from "../db.js";

const governance = express.Router();

const TERMINAL_STATES = new Set(["Enacted", "Approved", "Rejected"]);

function isTerminal(state) {
    if (typeof state === "string") return TERMINAL_STATES.has(state);
    // { supersededBy: id } or { confirming: { since } }
    if (typeof state === "object" && state !== null) {
        return "supersededBy" in state;
    }
    return false;
}

function stateLabel(state) {
    if (typeof state === "string") return state;
    if (state?.supersededBy !== undefined) return "SupersededBy";
    if (state?.confirming !== undefined) return "Confirming";
    return "Unknown";
}

function actionSummary(action) {
    if (!action || typeof action !== "object") return String(action);
    const variant = Object.keys(action)[0];
    const args = action[variant];
    switch (variant) {
        case "updateNominalIncome":
            return `Update nominal income for ${cidShort(args[0])} to ${formatBalance(args[1])}`;
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
            return `Spend ${formatBalance(args[2])} native to ${addrShort(args[1])}`;
        case "spendAsset":
            return `Spend ${formatBalance(args[2])} asset to ${addrShort(args[1])}`;
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

function formatBalance(raw) {
    if (raw === undefined || raw === null) return "?";
    // NominalIncomeType is i128 with 18-decimal fixed point (BalanceType)
    const n = typeof raw === "string" ? BigInt(raw) : BigInt(raw);
    const whole = n / BigInt(1e12);
    const frac = Number(n % BigInt(1e12)) / 1e12;
    return (Number(whole) + frac).toFixed(1);
}

function actionType(action) {
    if (!action || typeof action !== "object") return String(action);
    return Object.keys(action)[0];
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
