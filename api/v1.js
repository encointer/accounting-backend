import express from "express";

import accounting from "./accounting.js";

const v1 = express.Router();


v1.use("/accounting", accounting);

export default v1;
