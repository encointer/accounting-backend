import express from "express";
import db from "../db.js";

const indexer2 = express.Router();

indexer2.post("/query", async function (req, res, next) {
    try {
        const collection = req.body.collection;
        const query = req.body.query;
        const options = req.body.options
        const result = await db.indexer.collection(collection).find(query, options).toArray()
        res.send(
            JSON.stringify(result)
        );
    } catch (e) {
        next(e);
    }
});

export default indexer2;