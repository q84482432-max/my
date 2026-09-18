import * as React from "react";
import { cn } from "@/lib/utils";

/* ============================================================================
   Table · 组件规范依据 DESIGN.md §4.4 / §5.4 / §8.1
   ----------------------------------------------------------------------------
   关键改动：表头加底色（--surface-subtle）。原实现表头只有
   text-muted-foreground 而无底色，"表头"与"表体"在视觉上无法区分 ——
   这是"整片纯白"的第二处根因。补上底色后，5558 行长列表才有扫描锚点。

   两条硬约束：
   1. 单元格一律 nowrap，宽表横向滚动而非折行（数字列给足宽度，永不截断）
   2. 任何断点都不把表格改为卡片堆叠 —— 行情数据的可比性依赖列对齐，
      堆叠会破坏"同一字段纵向对比"这一核心用法
   ==========================================================================*/

const Table = React.forwardRef<
  HTMLTableElement,
  React.HTMLAttributes<HTMLTableElement>
>(({ className, ...props }, ref) => (
  <div className="relative w-full overflow-auto">
    <table
      ref={ref}
      className={cn("w-full caption-bottom text-body", className)}
      {...props}
    />
  </div>
));
Table.displayName = "Table";

const TableHeader = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <thead ref={ref} className={cn("[&_tr]:border-b", className)} {...props} />
));
TableHeader.displayName = "TableHeader";

const TableBody = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <tbody
    ref={ref}
    className={cn("[&_tr:last-child]:border-0", className)}
    {...props}
  />
));
TableBody.displayName = "TableBody";

const TableRow = React.forwardRef<
  HTMLTableRowElement,
  React.HTMLAttributes<HTMLTableRowElement>
>(({ className, ...props }, ref) => (
  <tr
    ref={ref}
    className={cn(
      /* 行分隔线用更浅的冷灰 #EEF2F8，降低长列表的网格噪点；
         行悬停用 #F6F9FD 而非 --accent(#EEF3FF) —— 后者过重，
         长列表快速滚动时会"闪"。 */
      "border-b border-[#eef2f8] transition-colors hover:bg-[#f6f9fd] data-[state=selected]:bg-muted",
      className,
    )}
    {...props}
  />
));
TableRow.displayName = "TableRow";

const TableHead = React.forwardRef<
  HTMLTableCellElement,
  React.ThHTMLAttributes<HTMLTableCellElement>
>(({ className, ...props }, ref) => (
  <th
    ref={ref}
    className={cn(
      "h-9 whitespace-nowrap bg-muted px-3 text-left align-middle text-label font-semibold text-t3",
      className,
    )}
    {...props}
  />
));
TableHead.displayName = "TableHead";

const TableCell = React.forwardRef<
  HTMLTableCellElement,
  React.TdHTMLAttributes<HTMLTableCellElement>
>(({ className, ...props }, ref) => (
  <td
    ref={ref}
    className={cn("whitespace-nowrap px-3 py-2.5 align-middle", className)}
    {...props}
  />
));
TableCell.displayName = "TableCell";

const TableCaption = React.forwardRef<
  HTMLTableCaptionElement,
  React.HTMLAttributes<HTMLTableCaptionElement>
>(({ className, ...props }, ref) => (
  <caption
    ref={ref}
    className={cn("mt-4 text-body text-muted-foreground", className)}
    {...props}
  />
));
TableCaption.displayName = "TableCaption";

export {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
};
