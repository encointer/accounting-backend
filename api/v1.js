import express from "express";

import accounting from "./accounting.js";
import auth from "./auth.js";
import { expressjwt as jwt } from "express-jwt";
import { JWT_CONFIG } from "../consts.js";

const v1 = express.Router();

v1.use(
    "/accounting",
    jwt(JWT_CONFIG).unless({
        path: ["/v1/accounting/transaction-log"],
    }),
    accounting
);

v1.use("/auth", auth);

export default v1;
