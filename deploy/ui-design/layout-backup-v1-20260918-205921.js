(self.webpackChunk_N_E=self.webpackChunk_N_E||[]).push([[177],{1290:()=>{},9186:(e,s,n)=>{Promise.resolve().then(n.t.bind(n,1290,23)),Promise.resolve().then(n.t.bind(n,2619,23))}},e=>{e.O(0,[741,0,441,255,358],()=>e(e.s=9186)),_N_E=e.O()}]);/* ============================================================================
   nav-active.js — 为顶栏导航补上"当前页"标记
   ----------------------------------------------------------------------------
   背景：线上导航的 6 个链接 DOM 完全相同，没有任何 aria-current / .active 标记，
         也没有任何可用于区分当前页的属性。纯 CSS 无法判断"我在哪一页"，
         因此设计稿 §4.1 的选中态（半透明品牌底 + 内描边）在线上无法生效。

   做法：追加到 app/layout-*.js 末尾（该 chunk 在每个页面都会加载），
         按 location.pathname 给对应链接打上 aria-current="page"，
         CSS 侧由 header.sticky nav a[aria-current="page"] 接管样式。

   安全性：整段包在 try/catch 内，任何异常都静默吞掉，绝不影响应用本身。
           同时它只做"加一个属性"，不改变任何 DOM 结构或事件。
   回滚：cp 回 layout chunk 备份即可。
   ==========================================================================*/
(function () {
  try {
    function norm(p) {
      if (!p) return '/';
      p = String(p).split('?')[0].split('#')[0];
      if (p.length > 1 && p.charAt(p.length - 1) === '/') p = p.slice(0, -1);
      return p;
    }

    function mark() {
      var nav = document.querySelector('header nav');
      if (!nav) return;
      var cur = norm(location.pathname);
      var links = nav.querySelectorAll('a[href]');
      for (var i = 0; i < links.length; i++) {
        var href = norm(links[i].getAttribute('href'));
        var hit = href === cur || (href !== '/' && cur.indexOf(href + '/') === 0);
        if (hit) links[i].setAttribute('aria-current', 'page');
        else links[i].removeAttribute('aria-current');
      }
    }

    // 只在路径真的变化时才重算，避免 MutationObserver 高频触发时反复遍历
    var last = null;
    function maybeMark() {
      var cur = norm(location.pathname);
      if (cur === last) return;
      last = cur;
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
