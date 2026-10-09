import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import memberRouter from "./member";
import investmentsRouter from "./investments";
import depositsRouter from "./deposits";
import withdrawalsRouter from "./withdrawals";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(memberRouter);
router.use(investmentsRouter);
router.use(depositsRouter);
router.use(withdrawalsRouter);

export default router;
