import path from "node:path";
import { verifyDelivery } from "./delivery-lib.mjs";

const root = path.resolve(process.argv[2] ?? process.cwd());
const result = verifyDelivery(root);
console.log(result.summary);
process.exit(result.ok ? 0 : 1);
