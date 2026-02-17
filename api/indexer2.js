import express from "express";
import db from "../db.js";

const indexer2 = express.Router();

const ALLOWED_COLLECTIONS = ["blocks", "extrinsics", "events"];

indexer2.post("/query", async function (req, res, next) {
    try {
        const collection = req.body.collection;
        const query = req.body.query;
        const options = req.body.options;

        if (typeof collection !== "string" || !ALLOWED_COLLECTIONS.includes(collection)) {
            res.status(400).send(JSON.stringify({ error: "Invalid collection" }));
            return;
        }

        if (query && typeof query === "object" && JSON.stringify(query).includes("$where")) {
            res.status(400).send(JSON.stringify({ error: "Invalid query operator" }));
            return;
        }

        const sanitizedOptions = options && typeof options === "object"
            ? { projection: options.projection, limit: options.limit, sort: options.sort }
            : {};

        const result = await db.indexer.collection(collection).find(query || {}, sanitizedOptions).toArray();
        res.send(
            JSON.stringify(result)
        );
    } catch (e) {
        next(e);
    }
});

export default indexer2;