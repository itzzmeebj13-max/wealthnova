import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import memberRouter from "./member";
import investmentsRouter from "./investments";
import depositsRouter from "./deposits";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(memberRouter);
router.use(investmentsRouter);
router.use(depositsRouter);

export default router;
