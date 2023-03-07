import * as dotenv from "dotenv";
dotenv.config();

export const ENCOINTER_RPC =
    process.env.ENCOINTER_RPC || "wss://kusama.api.encointer.org";

export const INDEXER_ENDPOINT =
    process.env.INDEXER_ENDPOINT || "http://localhost:3000";