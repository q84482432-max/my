/**
 * 浏览器验证脚本（agent-browser 封装）
 *
 * 为什么要有这个脚本：
 *   踩过的坑不是 agent-browser 本身，而是**调用方式**——
 *   在 Git Bash 里用 `time` / Windows `timeout.exe` / `| tail` 包 agent-browser，
 *   管道会挂死（命令几分钟不返回，进程其实早已退出）。
 *
 * 本脚本用 Node 的 child_process 直接调 CLI，天然规避上述问题，
 * 并统一注入两件必须的环境配置：
 *   ① 代理绕过（本机常年开代理，不设会劫持 127.0.0.1）
 *   ② CLI 的绝对路径（受管 Node 24.14.0 全局）
 *
 * 用法：
 *   tsx scripts/browserVerify.ts shot                # 回测页整页截图
 *   tsx scripts/browserVerify.ts shot 600000         # 先选中标的再截图
 *   tsx scripts/browserVerify.ts <任意 agent-browser 子命令...>
 *   tsx scripts/browserVerify.ts raw open http://127.0.0.1:3111/backtest
 *
 * 注：agent-browser 的 screenshot **不认自定义路径**，一律落到
 *     ~/.agent-browser/tmp/screenshots/。本脚本会读取实际落盘路径并复制到
 *     项目内 .workbuddy/screenshots/。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const NODE_DIR = 'C:/Users/Administrator.USER-20260201WA/.workbuddy/binaries/node/versions/24.14.0';
const AB_HOME = join(homedir(), '.agent-browser');
const SHOT_DIR = join(AB_HOME, 'tmp', 'screenshots');
const OUT_DIR = join(process.cwd(), '.workbuddy', 'screenshots');
const BASE_URL = process.env.APP_BASE_URL || 'http://127.0.0.1:3111';

/** 统一环境：剥离代理干扰 + CLI 绝对路径 */
function env(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${NODE_DIR};${process.env.PATH || ''}`,
    NO_PROXY: 'localhost,127.0.0.1',
    no_proxy: 'localhost,127.0.0.1',
    HTTP_PROXY: '',
    HTTPS_PROXY: '',
    http_proxy: '',
    https_proxy: '',
  };
}

function run(args: string[]): string {
  // 直接调 CLI 的 JS 入口（package.json bin = ./bin/agent-browser.js）。
  // 不用 .cmd 包装器：Windows 上 execFileSync spawn .cmd 会 EINVAL，
  // 经 cmd.exe /c 转发又要处理路径空格转义，最稳的就是 node <js>。
  const js = join(NODE_DIR, 'node_modules', 'agent-browser', 'bin', 'agent-browser.js');
  if (!existsSync(js)) {
    console.error(`[browserVerify] 找不到 agent-browser 入口: ${js}`);
    console.error('  安装命令: npm i -g agent-browser');
    process.exit(1);
  }

  process.stderr.write(`[browserVerify] agent-browser ${args.join(' ')}\n`);

  return execFileSync(process.execPath, [js, ...args], {
    env: env(),
    encoding: 'utf8',
    timeout: 60_000, // 60s 上限：CLI 各命令实际都在秒级，超时说明真的异常
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** 截图并归档（agent-browser 落盘路径不受控，需读目录找最新文件） */
function screenshot(outName: string): void {
  const before = new Set(safeListShots());
  run(['screenshot', '--full']);
  const after = safeListShots().filter((f) => !before.has(f));

  if (after.length === 0) {
    console.error('[browserVerify] 未发现新截图，截图可能失败');
    process.exit(1);
  }
  const newest = after
    .map((f) => join(SHOT_DIR, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  const dest = join(OUT_DIR, outName);
  copyFileSync(newest, dest);
  console.log(`截图已归档 -> ${dest}\n(源文件: ${newest})`);
}

function safeListShots(): string[] {
  try {
    return readdirSync(SHOT_DIR).filter((f) => f.endsWith('.png'));
  } catch {
    return [];
  }
}

/** 打开回测页（可选先选中标的） */
function openBacktest(code?: string): void {
  run(['open', `${BASE_URL}/backtest`]);
  if (!code) return;

  // 等历史列表/搜索框就绪
  sleep(1500);

  // 官方推荐的语义化查找（无需先 snapshot 拿 @eN ref）
  // 参考: agent-browser skills get core --full → "find role/text/label"
  // 注意 placeholder 按完整值匹配，故用 find first + CSS 兜底
  run(['find', 'first', 'input[placeholder*="搜索"]', 'fill', code]);
  run(['find', 'role', 'button', 'click', '--name', '搜索']);
  sleep(1200);

  // 点下拉第一行确认标的（只填 input 不点会沿用旧标的——踩过）
  const rows = run(['snapshot', '-i']);
  const re = new RegExp(`row "[^"]*${code}[^"]*"[^\\]]*\\[ref=(e\\d+)\\]`);
  const m = rows.match(re);
  if (m) {
    run(['click', m[1]]);
    sleep(800);
  } else {
    console.warn(`[browserVerify] 未找到代码 ${code} 的下拉项，标的可能未切换`);
  }
}

function sleep(ms: number): void {
  // 同步等待：本脚本定位为一次性 CLI 任务，不需要异步
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function main(): void {
  const [cmd, ...rest] = process.argv.slice(2);

  if (!cmd) {
    console.log('用法: tsx scripts/browserVerify.ts <shot|open|raw|snapshot|text|eval|close> [...]');
    process.exit(0);
  }

  switch (cmd) {
    case 'shot': {
      openBacktest(rest[0]);
      sleep(2500); // 等 ECharts 渲染
      screenshot(rest[1] || `browser-${Date.now()}.png`);
      break;
    }
    case 'open':
      openBacktest(rest[0]);
      break;
    case 'raw':
      console.log(run(rest));
      break;
    default:
      // 透传任意子命令，例如: text / snapshot / eval / click ...
      console.log(run([cmd, ...rest]));
      break;
  }
}

main();
