import express from "express";

import accounting from "./accounting.js";
import auth from "./auth.js";


const v1 = express.Router();

v1.use("/accounting", accounting);

v1.use("/auth", auth);

export default v1;
