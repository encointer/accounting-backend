import { ApiPromise, WsProvider } from "@polkadot/api";
import typesBundle from "./typesBundle.js";
import express from "express";
import { ENCOINTER_RPC } from "./consts.js";
import v1 from "./api/v1.js";
import swaggerJSDoc from "swagger-jsdoc";
import swaggerUi from "swagger-ui-express";
import cookieSession from "cookie-session";
const swaggerDefinition = {
    openapi: "3.0.0",
    info: {
        title: "Encointer API",
        version: "1.0.0",
    },
};

const options = {
    swaggerDefinition,
    // Paths to files containing OpenAPI definitions
    apis: ["./index.js", "./api/*.js"],
    requestInterceptor: function (request) {
        request.headers.Origin = `http://localhost:3000`;
        return request;
    },
};

const swaggerSpec = swaggerJSDoc(options);

/**
 * @swagger
 * components:
 *  securitySchemes:
 *    cookieAuth:
 *      type: apiKey
 *      in: cookie
 *      name: session
 *
 * security:
 *  - cookieAuth: []
 */

async function main() {
    console.log(`[boot] connecting to Encointer RPC: ${ENCOINTER_RPC}`);
    const wsProvider = new WsProvider(ENCOINTER_RPC);
    // Create our API with a default connection to the local node
    const api = await ApiPromise.create({
        provider: wsProvider,
        signedExtensions: typesBundle.signedExtensions,
        types: typesBundle.types[0].types,
    });
    console.log("[boot] Encointer API ready");

    const KAH_RPC = "wss://kusama-asset-hub-rpc.polkadot.io";
    console.log(`[boot] connecting to KAH RPC: ${KAH_RPC}`);
    const assetHubProvider = new WsProvider(KAH_RPC);
    const assetHubApi = await ApiPromise.create({ provider: assetHubProvider });
    console.log("[boot] KAH API ready");

    const app = express();
    app.set("api", api);
    app.set("assetHubApi", assetHubApi);
    app.use(function (req, res, next) {
        console.log("Received new request:", req.url, "from:", req.headers.origin);
        var send = res.send;
        res.send = function (body) {
            console.log(
                `Sending response for: ${req.url} with status ${this.statusCode}`
            );
            send.call(this, body);
        };
        next();
    });

    app.use("/docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));

    // Two-tier CORS:
    //   * Trusted origins (the official dapp + accounting frontend + local dev)
    //     get full credentials support — required for session-cookie auth on
    //     admin routes.
    //   * Any other origin (IPFS gateways, self-hosted kubo on localhost,
    //     custom domains, ...) gets anonymous read-only access via `*`.
    //     The browser refuses to send credentials when Allow-Origin is `*` and
    //     Allow-Credentials is absent, so session-protected endpoints remain
    //     inaccessible from untrusted origins regardless of the wildcard.
    var trustedOrigins = [
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "https://accounting.encointer.org",
        "https://dapp.encointer.org",
    ];
    app.use(function (req, res, next) {
        var origin = req.headers.origin;
        if (origin && trustedOrigins.indexOf(origin) !== -1) {
            res.setHeader("Access-Control-Allow-Origin", origin);
            res.setHeader("Access-Control-Allow-Credentials", "true");
            res.setHeader("Vary", "Origin");
        } else {
            res.setHeader("Access-Control-Allow-Origin", "*");
        }
        res.setHeader(
            "Access-Control-Allow-Methods",
            "GET,POST,OPTIONS,DELETE,PUT,PATCH",
        );
        res.setHeader(
            "Access-Control-Allow-Headers",
            req.headers["access-control-request-headers"] ||
                "Content-Type,Authorization",
        );
        if (req.method === "OPTIONS") return res.sendStatus(200);
        next();
    });

    app.use(express.json());
    app.use(express.urlencoded());

    app.use(
        cookieSession({
            name: "session",
            keys: [process.env.SECRET_KEY || (() => { throw new Error("SECRET_KEY env var must be set"); })()],

            // Cookie Options
            maxAge: 24 * 60 * 60 * 1000, // 24 hours
        })
    );

    app.use("/v1", v1);

    const port = Number(process.env.PORT) || 8081;
    const server = app.listen(port, () => {
        const addr = server.address();
        const boundPort = typeof addr === "object" && addr ? addr.port : port;
        console.log(`App started! Listening on http://127.0.0.1:${boundPort}`);
    });
    server.on("error", (err) => {
        console.error(`Failed to bind on port ${port}:`, err.message);
    });
}

main().catch(console.error);
