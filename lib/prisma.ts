import { PrismaClient } from "@prisma/client";

/**
 * Prisma 单例。
 * Next.js dev 模式热重载会反复实例化模块，挂到 globalThis 上避免连接数爆炸。
 */
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

export default prisma;
