const treasuryMap = {
    HNJDzJEGaBgWRXz7bjERsRidJFQBnj1AZ2Tn3Q9uRGynhwq: {
        name: "Leu Treasury",
        cid: "u0qj944rhWE",
        kahAccount: "DgdA9qwXxBAtdy9veCR4LZpcbYuMgCSL9XpV7gbELFncV2t",
    },
    E9KVuDLEtBBWSqhCiKn31VPBBLe33CbYJTrnWAbjszwskWH: {
        name: "Nyota Treasury",
        cid: "kygch5kVGq7",
        kahAccount: "G8yWL9B48XnbwC5aYpotqUk7ZTcpP7SGQcykoo7TVQTkhwJ",
    },
    E2mZ1u2xepTF8nuEQVkrimPVwqtqq1joC56cUwYPftXAEQL: {
        name: "PayNuQ Treasury",
        cid: "s1vrqQL2SD",
        kahAccount: "CqCAXF5M51M7xttMuK47TmyuSos8iusFm524ZzaAZnNiner",
    },
};

const assedIdMap = {
    USDC: {
        assetId: {
            V5: {
                location: {
                    parents: "1",
                    interior: { X1: [{ Parachain: "1,000" }] },
                },
                assetId: {
                    parents: "2",
                    interior: {
                        X4: [
                            { GlobalConsensus: { Polkadot: null } },
                            { Parachain: "1,000" },
                            { PalletInstance: "50" },
                            { GeneralIndex: "1,337" },
                        ],
                    },
                },
            },
        },
        decimals: 6,
    },
};

export function getTreasuryName(address) {
    return treasuryMap[address].name || address;
}

export function getAssetNameAndDecimals(assetId) {
    if (!assetId) {
        return { name: "KSM", decimals: 12 };
    }
    for (const [name, info] of Object.entries(assedIdMap)) {
        if (JSON.stringify(info.assetId) === JSON.stringify(assetId)) {
            return { name, decimals: info.decimals };
        }
        if (
            info.assetId?.V5?.assetId?.interior?.X4 &&
            assetId?.interior?.X4 &&
            Array.isArray(info.assetId.V5.assetId.interior.X4) &&
            Array.isArray(assetId.interior.X4)
        ) {
            const x4A = info.assetId.V5.assetId.interior.X4[0];
            const x4B = assetId.interior.X4[0];
            // Allow { GlobalConsensus: 'Polkadot' } to match { GlobalConsensus: { Polkadot: null } }
            if (
                x4A?.GlobalConsensus &&
                x4B?.GlobalConsensus &&
                ((typeof x4A.GlobalConsensus === "object" &&
                    x4A.GlobalConsensus.Polkadot === null &&
                    x4B.GlobalConsensus === "Polkadot") ||
                    (typeof x4B.GlobalConsensus === "object" &&
                        x4B.GlobalConsensus.Polkadot === null &&
                        x4A.GlobalConsensus === "Polkadot"))
            ) {
                // Compare the rest of the array
                const restA = info.assetId.V5.assetId.interior.X4.slice(1);
                const restB = assetId.interior.X4.slice(1);
                if (JSON.stringify(restA) === JSON.stringify(restB)) {
                    return { name, decimals: info.decimals };
                }
            }
        }
    }
}

export function getTreasuryByCid(cid) {
    for (const [address, info] of Object.entries(treasuryMap)) {
        if (info.cid === cid) {
            return { address, ...info };
        }
    }
    return null;
}
