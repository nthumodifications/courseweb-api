import * as path from "path";
import type { PrismaConfig } from "prisma";

export default {
  earlyAccess: true,
  schema: path.join("src", "prisma", "schema.prisma"),
} satisfies PrismaConfig;
