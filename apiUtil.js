import { CIDS } from "./consts.js";

export function validateAccountToken(account, cid, req) {
    return (
        CIDS[cid].accounts[account].token ===
        req.headers?.authorization?.split("Basic ")?.[1]
    );
}

export function validateAdminToken(req) {
    return (
        process.env.ACCESS_TOKEN_ADMIN ===
        req.headers?.authorization?.split("Basic ")?.[1]
    );
}

export function validateAccountOrAdminToken(account, cid, req) {
    return validateAccountToken(account, cid, req) || validateAdminToken(req);
}
