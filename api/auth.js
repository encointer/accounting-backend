import express from "express";
import { generateAccessToken } from "../apiUtil.js";
import { JWT_CONFIG } from "../consts.js";
import db from "../db.js";
const auth = express.Router();
import { expressjwt as jwt } from "express-jwt";

auth.post("/authenticate", async function (req, res, next) {
    try {
        const address = req.body.address;
        const password = req.body.password;
        const user = await db.checkUserCredentials(address, password);
        if (!user) {
            res.sendStatus(403);
            return;
        }

        res.send(
            JSON.stringify({
                token: generateAccessToken(user.address, user.isAdmin),
            })
        );
    } catch (e) {
        next(e);
    }
});

auth.get("/me", jwt(JWT_CONFIG), async function (req, res, next) {
    try {
        res.send(
            JSON.stringify({
                address: req.auth.address,
                isAdmin: req.auth.isAdmin,
            })
        );
    } catch (e) {
        next(e);
    }
});

export default auth;
