import { ApiPromise, WsProvider } from "@polkadot/api";
const encointer_rpc_endpoint = "wss://kusama.api.encointer.org";
import typesBundle from "./typesBundle.js";
import express from "express";
import { addMiddlewaresAndRoutes } from "./app.js";

async function main() {
    const wsProvider = new WsProvider(encointer_rpc_endpoint);
    // Create our API with a default connection to the local node
    const api = await ApiPromise.create({
        provider: wsProvider,
        signedExtensions: typesBundle.signedExtensions,
        types: typesBundle.types[0].types,
    });

    const app = express();
    addMiddlewaresAndRoutes(app, api);
    app.listen(8081);
    console.log("App started!");
}

main().catch(console.error);
