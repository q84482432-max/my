"use client";

import { create } from "zustand";
import type { AccountInfo, PositionInfo, OrderInfo, TradeInfo } from "@/types";

interface AccountState {
  accountId: string | null;
  summary: AccountInfo | null;
  positions: PositionInfo[];
  orders: OrderInfo[];
  trades: TradeInfo[];
  loading: boolean;
  error: string | null;

  setAccountId: (id: string | null) => void;
  setSummary: (s: AccountInfo | null) => void;
  setPositions: (p: PositionInfo[]) => void;
  setOrders: (o: OrderInfo[]) => void;
  setTrades: (t: TradeInfo[]) => void;
  setLoading: (v: boolean) => void;
  setError: (e: string | null) => void;

  /** 从服务端拉取全部账户数据 */
  refresh: () => Promise<void>;
  reset: () => void;
}

/**
 * 账户状态管理。
 *
 * 边界说明：store 只负责**缓存与同步**服务端数据，
 * 不包含任何交易计算逻辑（费用、成交、T+1 等一律在
 * services/tradingEngine.ts 中实现，通过 API 调用）。
 */
export const useAccountStore = create<AccountState>((set, get) => ({
  accountId: null,
  summary: null,
  positions: [],
  orders: [],
  trades: [],
  loading: false,
  error: null,

  setAccountId: (accountId) => set({ accountId }),
  setSummary: (summary) => set({ summary }),
  setPositions: (positions) => set({ positions }),
  setOrders: (orders) => set({ orders }),
  setTrades: (trades) => set({ trades }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),

  refresh: async () => {
    set({ loading: true, error: null });
    try {
      const res = await fetch("/api/account", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as {
        accountId: string;
        summary: AccountInfo | null;
        positions: PositionInfo[];
        orders: OrderInfo[];
        trades: TradeInfo[];
      };
      set({
        accountId: data.accountId,
        summary: data.summary,
        positions: data.positions ?? [],
        orders: data.orders ?? [],
        trades: data.trades ?? [],
        loading: false,
      });
    } catch (err) {
      set({ loading: false, error: (err as Error).message });
    }
  },

  reset: () =>
    set({
      summary: null,
      positions: [],
      orders: [],
      trades: [],
      error: null,
    }),
}));
