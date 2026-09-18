// 样式文件类型声明
// 让 TypeScript 认识 side-effect 引入的 CSS（tsc 独立检查时需要，
// Next.js 自身构建流程也会生成 next-env.d.ts，两者互补）。

declare module "*.css";
declare module "*.scss";
declare module "*.sass";
declare module "*.less";
