import base58 from "bs58";

// State from .toJSON() is { variantName: null | data }, e.g. { enacted: null }
export function stateKey(state) {
    if (typeof state === "string") return state.toLowerCase();
    if (typeof state === "object" && state !== null) return Object.keys(state)[0];
    return "";
}

const TERMINAL_KEYS = new Set(["enacted", "approved", "rejected", "supersededby", "supersededBy"]);

export function isTerminal(state) {
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

export function stateLabel(state) {
    return STATE_LABELS[stateKey(state)] || stateKey(state) || "Unknown";
}

// Convert { geohash: "0x...", digest: "0x..." } to human-readable CID string
export function formatCid(cid) {
    if (!cid || typeof cid !== "object") return cid ? String(cid) : "?";
    const geoHex = (cid.geohash || "").replace(/^0x/, "");
    const digestHex = (cid.digest || "").replace(/^0x/, "");
    const geohash = Buffer.from(geoHex, "hex").toString("ascii");
    const digest = base58.encode(Buffer.from(digestHex, "hex"));
    return geohash + digest;
}

export function addrShort(addr) {
    if (!addr) return "?";
    return String(addr).slice(0, 8) + "...";
}

// Decode PalletString (Text) — may be hex-encoded or plain string
export function decodeText(raw) {
    if (!raw) return "";
    if (typeof raw === "string" && raw.startsWith("0x")) {
        return Buffer.from(raw.slice(2), "hex").toString("utf8");
    }
    return String(raw);
}

// FixedI64F64 { bits: i128 } — 64.64 fixed point (community currency amounts)
export function formatFixedPoint(raw) {
    if (raw === undefined || raw === null) return "?";
    const bits = typeof raw === "object" && raw.bits !== undefined ? raw.bits : raw;
    const n = BigInt(bits);
    const intPart = Number(n >> 64n);
    const fracPart = Number(n & ((1n << 64n) - 1n)) / 2 ** 64;
    return (intPart + fracPart).toFixed(1);
}

// Plain Balance u128 — 12 decimal places (KSM)
export function formatNativeBalance(raw) {
    if (raw === undefined || raw === null) return "?";
    return (Number(BigInt(raw)) / 1e12).toFixed(2);
}

export function actionType(action) {
    if (!action || typeof action !== "object") return String(action);
    return Object.keys(action)[0];
}

// Extract community identifier string from action, or null for global actions
export function actionCommunityId(action) {
    if (!action || typeof action !== "object") return null;
    const variant = Object.keys(action)[0];
    const args = action[variant];
    if (variant === "setInactivityTimeout") return null;
    const cid = Array.isArray(args) ? args[0] : args;
    if (!cid || typeof cid !== "object" || !cid.geohash) return null;
    return formatCid(cid);
}

export function actionSummary(action, cidNameMap) {
    if (!action || typeof action !== "object") return String(action);
    const variant = Object.keys(action)[0];
    const args = action[variant];
    const cn = (cidObj) => {
        const cid = formatCid(cidObj);
        return cidNameMap[cid] || cid;
    };
    switch (variant) {
        case "updateNominalIncome":
            return `Update nominal income for ${cn(args[0])} to ${formatFixedPoint(args[1])}`;
        case "updateDemurrage":
            return `Update demurrage for ${cn(args[0])}`;
        case "addLocation":
            return `Add location to ${cn(args[0])}`;
        case "removeLocation":
            return `Remove location from ${cn(args[0])}`;
        case "updateCommunityMetadata":
            return `Update metadata for ${cn(args[0])}`;
        case "setInactivityTimeout":
            return `Set inactivity timeout to ${args}`;
        case "petition":
            return `Petition: ${decodeText(args[1])}`.slice(0, 200);
        case "spendNative":
            return `Spend ${formatNativeBalance(args[2])} KSM to ${addrShort(args[1])}`;
        case "spendAsset":
            return `Spend asset to ${addrShort(args[1])}`;
        case "issueSwapNativeOption":
            return `Issue swap native option for ${cn(args[0])}`;
        case "issueSwapAssetOption":
            return `Issue swap asset option for ${cn(args[0])}`;
        default:
            return variant;
    }
}
