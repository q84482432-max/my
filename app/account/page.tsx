import AccountClient from "@/components/AccountClient";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "模拟账户 · A股模拟交易",
};

/**
 * 模拟账户页（服务端组件外壳）
 *
 * 数据获取全部走 /api/account*（客户端 store 刷新），
 * 页面本身不直接访问数据库，也不含交易逻辑。
 */
export default function AccountPage() {
  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-6">
      <div className="mb-5">
        <h1 className="text-2xl font-semibold tracking-tight">模拟账户</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          基于真实历史行情的模拟交易。交易规则：T+1、佣金万三（最低 5 元，双向）、印花税千一（仅卖出）、过户费万 0.1（双向）。
        </p>
      </div>
      <AccountClient />
    </div>
  );
}
