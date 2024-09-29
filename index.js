import { ApiPromise, WsProvider } from "@polkadot/api";
import typesBundle from "./typesBundle.js";
import express from "express";
import { ENCOINTER_RPC } from "./consts.js";
import v1 from "./api/v1.js";
import cors from "cors";
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
    const wsProvider = new WsProvider(ENCOINTER_RPC);
    // Create our API with a default connection to the local node
    const api = await ApiPromise.create({
        provider: wsProvider,
        signedExtensions: typesBundle.signedExtensions,
        types: typesBundle.types[0].types,
    });

    const app = express();
    app.set("api", api);
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

    var whitelist = [
        "http://localhost:3000",
        "https://accounting.encointer.org",
    ];
    var corsOptions = {};

    var corsOptions = {
        credentials: true,
        origin: function (origin, callback) {
            callback(null, true);
            // if (whitelist.indexOf(origin) !== -1) {
            //     callback(null, true);
            // } else {
            //     callback(new Error("Not allowed by CORS"));
            // }
        },
        optionsSuccessStatus: 200, // some legacy browsers (IE11, various SmartTVs) choke on 204
    };
    app.use(cors(corsOptions));

    app.use(express.json());
    app.use(express.urlencoded());

    app.use(
        cookieSession({
            name: "session",
            keys: [process.env.SECRET_KEY],

            // Cookie Options
            maxAge: 24 * 60 * 60 * 1000, // 24 hours
        })
    );

    app.use("/v1", v1);

    app.listen(8081);
    console.log("App started!");
}

main().catch(console.error);
