import express from "express";
import db from "../db.js";
const communities = express.Router();

communities.get("/all-communities", async function (req, res, next) {
    try {
        res.send(JSON.stringify(await db.getAllCommunities()));
    } catch (e) {
        next(e);
    }
});

export default communities;
