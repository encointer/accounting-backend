import { ApiPromise, WsProvider } from "@polkadot/api";
import typesBundle from "./typesBundle.js";
import { ENCOINTER_RPC } from "./consts.js";
import db from "./db.js";

async function main() {
    const wsProvider = new WsProvider(ENCOINTER_RPC);
    // Create our API with a default connection to the local node
    const api = await ApiPromise.create({
        provider: wsProvider,
        signedExtensions: typesBundle.signedExtensions,
        types: typesBundle.types[0].types,
    });

    let burnEvents = await db.events
        .find({ section: "encointerBalances", method: "Burned" })
        .toArray();

    let swapEvents = await db.events
        .find({ section: "encointerTreasuries", method: "SpentAsset" })
        .toArray();
    

    let foreignAssetsTransferredEvents = await db.indexerAssetHub
        .collection("events")
        .find({ section: "foreignAssets", method: "Transferred" })
        .toArray();
    
    console.dir(burnEvents, { depth: null });
    console.dir(swapEvents, { depth: null });
    console.dir(foreignAssetsTransferredEvents, { depth: null });

}

main().catch(console.error);
