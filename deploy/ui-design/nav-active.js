/* ============================================================================
   nav-active.js v2 — 顶栏导航"当前页"标记 + 入口链接适配
   ----------------------------------------------------------------------------
   背景 1：线上导航 6 个链接 DOM 完全相同，没有 aria-current / .active 标记，
           纯 CSS 无法判断"我在哪一页"。按 location.pathname 给对应链接打
           aria-current="page"，由 theme-override.css 的选中态接管样式。

   背景 2：应用只能通过工作台 /app 入口公网访问（8080 被安全组挡住）。
           顶栏里 href="/" 的链接（logo、行情中心）在 /app 环境下会跳出应用
           落到工作台首页——因为工作台自己占用了 /，无法转发。
           因此：凡是"非 8080 直连"（即经过工作台代理）的访问，
           把文档里 href 恰好为 "/" 的 <a> 改写成 "/app"。
           其余链接（/stocks 等）由工作台新加的路由兜底转发，无需改写。

   判定：location.port === "8080" → 直连后端，什么都不改；
         其余（空端口/80/443）→ 代理环境，改写 "/" 链接。

   安全性：整段包在 try/catch 内，任何异常都静默吞掉，绝不影响应用本身。
   回滚：用 layout-backup-*.js 覆盖回 chunk 即可（见 apply-ui-patch.sh）。
   ==========================================================================*/
(function () {
  try {
    function norm(p) {
      if (!p) return '/';
      p = String(p).split('?')[0].split('#')[0];
      if (p.length > 1 && p.charAt(p.length - 1) === '/') p = p.slice(0, -1);
      return p;
    }

    /* 逻辑路径：/app 前缀只是代理入口的产物，比较时一律剥掉 */
    function ctxPath(p) {
      p = norm(p);
      if (p === '/app') return '/';
      if (p.indexOf('/app/') === 0) return p.slice(4);
      return p;
    }

    function behindProxy() {
      return location.port !== '8080';
    }

    /* 把 href 恰好为 "/"（或 "/?..."）的链接改写到 /app，避免跳出应用 */
    function fixHomeLinks() {
      if (!behindProxy()) return;
      var anchors = document.querySelectorAll('a[href]');
      for (var i = 0; i < anchors.length; i++) {
        var h = anchors[i].getAttribute('href') || '';
        if (h === '/' || h.charAt(0) === '/?' || h.indexOf('/#') === 0) {
          anchors[i].setAttribute('href', '/app' + h.slice(1));
        }
      }
    }

    function mark() {
      var nav = document.querySelector('header nav');
      if (!nav) return;
      var cur = ctxPath(location.pathname);
      var links = nav.querySelectorAll('a[href]');
      for (var i = 0; i < links.length; i++) {
        var href = ctxPath(links[i].getAttribute('href'));
        var hit = href === cur || (href !== '/' && cur.indexOf(href + '/') === 0);
        if (hit) links[i].setAttribute('aria-current', 'page');
        else links[i].removeAttribute('aria-current');
      }
    }

    // 只在路径真的变化时才重算，避免 MutationObserver 高频触发时反复遍历
    var last = null;
    function maybeMark() {
      fixHomeLinks();
      var key = norm(location.pathname);
      if (key === last) return;
      last = key;
      mark();
    }

    // 客户端路由切换：包裹 pushState / replaceState（尽力而为，可能晚于框架捕获）
    ['pushState', 'replaceState'].forEach(function (m) {
      var orig = history[m];
      if (typeof orig !== 'function') return;
      history[m] = function () {
        var r = orig.apply(this, arguments);
        setTimeout(maybeMark, 0);
        return r;
      };
    });
    window.addEventListener('popstate', function () { setTimeout(maybeMark, 0); });

    // 兜底：内容区被替换时也能重新判定（Next 客户端导航不会重建根布局的导航）
    if (window.MutationObserver) {
      var scheduled = false;
      new MutationObserver(function () {
        if (scheduled) return;
        scheduled = true;
        setTimeout(function () { scheduled = false; maybeMark(); }, 60);
      }).observe(document.documentElement, { childList: true, subtree: true });
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', maybeMark);
    } else {
      maybeMark();
    }
  } catch (e) { /* 静默失败，不影响应用 */ }
})();
