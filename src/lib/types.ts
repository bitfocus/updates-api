import type { PrismaClient } from "../prisma/client.js";
import type * as runtime from "@prisma/client/runtime/client";

export type PrismaTransaction = Omit<PrismaClient, runtime.ITXClientDenyList>;
