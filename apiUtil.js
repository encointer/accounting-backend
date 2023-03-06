import { CIDS } from "./consts.js";
import jwt from "jsonwebtoken";

export function validateAccountToken(account, cid, req) {
    return (
        CIDS[cid]?.accounts[account]?.token === req.headers?.["access-token"]
    );
}

export function validateAdminToken(req) {
    return process.env.ACCESS_TOKEN_ADMIN === req.headers?.["access-token"];
}

export function validateAccountOrAdminToken(account, cid, req) {
    return validateAccountToken(account, cid, req) || validateAdminToken(req);
}

export function generateAccessToken(address, isAdmin=false) {
    return jwt.sign({ address, isAdmin }, process.env.SECRET_KEY, { expiresIn: "1800s" });
}
