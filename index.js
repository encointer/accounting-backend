import { ApiPromise, WsProvider } from "@polkadot/api";
import typesBundle from "./typesBundle.js";
import express from "express";
import { ENCOINTER_RPC } from "./consts.js";
import v1 from "./api/v1.js";
import cors from "cors";

async function main() {
    const wsProvider = new WsProvider(ENCOINTER_RPC);
    // Create our API with a default connection to the local node
    const api = await ApiPromise.create({
        provider: wsProvider,
        signedExtensions: typesBundle.signedExtensions,
        types: typesBundle.types[0].types,
    });

    const app = express();
    app.set("api", api);

    app.use(cors());

    app.use(function (req, res, next) {
        console.log("Received new request:", req.url);
        var send = res.send;
        res.send = function (body) {
            console.log(
                `Sending response for: ${req.url} with status ${this.statusCode}`
            );
            send.call(this, body);
        };
        next();
    });

    app.use("/v1", v1);

    app.listen(8081);
    console.log("App started!");
}

main().catch(console.error);
