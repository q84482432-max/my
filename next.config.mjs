/**
 * Next.js 配置
 *
 * 说明：本机装的是 TypeScript 7.x，而 Next.js 15.5 在加载 `next.config.ts`
 * 时会调用 TS 5.x 的内部 API（ts.sys.fileExists），在 TS 7 下会抛
 * "Cannot read properties of undefined (reading 'fileExists')" 导致启动失败。
 * 因此配置改用 .mjs，绕开 TS 转译路径；类型检查仍由 tsc 独立完成。
 *
 * @type {import('next').NextConfig}
 */
const nextConfig = {
  reactStrictMode: true,
  // dev 模式下允许本机两种写法访问（Next 16 默认拦跨源 dev 资源：
  // 用 127.0.0.1 打开 localhost 起的 dev server 时，/_next/hmr 与客户端 chunk 会被拒，
  // 表现为「只有 SSR 空态、永不 hydrate」，看着像功能坏了。加白名单消除该坑。）
  allowedDevOrigins: ["localhost", "127.0.0.1"],
  // 生产部署使用 standalone 产物：本地构建好后整包上传，服务器只跑 runtime，
  // 避免在 2G 内存的小机器上执行 next build（极易 OOM）。
  output: "standalone",
  experimental: {
    // 文件上传/请求体上限（导入历史数据时可能用到）
    serverActions: {
      bodySizeLimit: "4mb",
    },
  },
  // Prisma 需要在服务端执行，避免被打包进 client bundle
  serverExternalPackages: ["@prisma/client", "prisma"],
};

export default nextConfig;
