import { CIDS } from "./consts.js";

export function validateAccountToken(account, cid, req) {
    return CIDS[cid].accounts[account].token === req.headers?.["access-token"];
}

export function validateAdminToken(req) {
    return process.env.ACCESS_TOKEN_ADMIN === req.headers?.["access-token"];
}

export function validateAccountOrAdminToken(account, cid, req) {
    return validateAccountToken(account, cid, req) || validateAdminToken(req);
}
