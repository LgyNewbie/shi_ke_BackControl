/* =====================================================================
 * 后台公共脚本：登录、侧边栏布局、请求封装、弹窗(确认/表单/详情)、提示、分页、格式化
 *
 * 每个页面的写法（见 foods.html / orders.html 等）：
 *
 *   Admin.init({ key: 'orders', title: '订单管理' }, async (main) => {
 *     main.innerHTML = '...';          // 往主内容区里渲染
 *     const data = await Admin.api('/api/admin/orders', { query: { page: 1 } });
 *   });
 *
 * 金额约定：接口里的金额全部是「元」（数字），页面直接显示 Admin.yuan(x) 即可，不要再 /100 或 *100。
 * ===================================================================== */
(function () {
  const TOKEN_KEY = 'admin_token';
  const NAME_KEY = 'admin_username';

  // ------------------------------------------------------------------
  // 菜单（只在这里维护一份，所有页面共用）
  // ------------------------------------------------------------------
  const NAV = [
    { group: '概览', items: [{ key: 'dashboard', href: 'index.html', icon: '📊', text: '数据统计' }] },
    {
      group: '商品', items: [
        { key: 'foods', href: 'foods.html', icon: '🍜', text: '菜品管理' },
        { key: 'categories', href: 'categories.html', icon: '📂', text: '分类管理' }
      ]
    },
    {
      group: '交易', items: [
        { key: 'orders', href: 'orders.html', icon: '📦', text: '订单管理' },
        { key: 'refunds', href: 'refunds.html', icon: '💸', text: '退款审核' },
        { key: 'complaints', href: 'complaints.html', icon: '🛎️', text: '投诉管理' },
        { key: 'wallet', href: 'wallet.html', icon: '💰', text: '钱包管理' }
      ]
    },
    {
      group: '用户与互动', items: [
        { key: 'users', href: 'users.html', icon: '👥', text: '用户管理' },
        { key: 'messages', href: 'messages.html', icon: '💬', text: '留言管理' },
        { key: 'reviews', href: 'reviews.html', icon: '⭐', text: '评论管理' },
        { key: 'polls', href: 'polls.html', icon: '🗳️', text: '投票管理' },
        { key: 'notices', href: 'notices.html', icon: '📢', text: '公告管理' }
      ]
    },
    {
      group: '运营', items: [
        { key: 'coupons', href: 'coupons.html', icon: '🎫', text: '优惠券管理' },
        { key: 'delivery', href: 'delivery.html', icon: '🚚', text: '配送地址/区域' }
      ]
    },
    {
      group: '系统', items: [
        { key: 'logs', href: 'logs.html', icon: '📝', text: '操作日志' },
        { key: 'settings', href: 'settings.html', icon: '⚙️', text: '系统设置' }
      ]
    }
  ];

  // ------------------------------------------------------------------
  // 小工具
  // ------------------------------------------------------------------
  const esc = (s) => String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const yuan = (n) => '¥' + (Number(n) || 0).toFixed(2);
  const num = (n) => (Number(n) || 0).toLocaleString('zh-CN');
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  function getToken() { return localStorage.getItem(TOKEN_KEY); }
  function getUsername() { return localStorage.getItem(NAME_KEY); }

  // ------------------------------------------------------------------
  // 提示 toast
  // ------------------------------------------------------------------
  function toast(message, type) {
    let box = $('#toast-box');
    if (!box) {
      box = document.createElement('div');
      box.id = 'toast-box';
      document.body.appendChild(box);
    }
    const el = document.createElement('div');
    el.className = 'toast ' + (type || 'info');
    el.textContent = message;
    box.appendChild(el);
    setTimeout(() => { el.classList.add('hide'); setTimeout(() => el.remove(), 300); }, type === 'error' ? 4200 : 2200);
  }

  // ------------------------------------------------------------------
  // 弹窗
  // ------------------------------------------------------------------
  // modal({ title, body(HTML 字符串或 DOM), width, buttons:[{text, type, onClick, keepOpen}], onClose })
  // 返回 { el, close, body }
  function modal(opts) {
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    const box = document.createElement('div');
    box.className = 'modal-box';
    if (opts.width) box.style.width = opts.width + 'px';
    box.innerHTML = `
      <div class="modal-head"><h3>${esc(opts.title || '')}</h3><button class="modal-x" aria-label="关闭">×</button></div>
      <div class="modal-body"></div>
      <div class="modal-foot"></div>`;
    const body = $('.modal-body', box);
    if (typeof opts.body === 'string') body.innerHTML = opts.body;
    else if (opts.body) body.appendChild(opts.body);

    const foot = $('.modal-foot', box);
    const buttons = opts.buttons || [];
    if (!buttons.length) foot.style.display = 'none';

    let closed = false;
    function close(result) {
      if (closed) return;
      closed = true;
      mask.classList.add('leaving');
      document.removeEventListener('keydown', onKey);
      setTimeout(() => mask.remove(), 160);
      if (opts.onClose) opts.onClose(result);
    }
    const api = { el: box, body, close };

    buttons.forEach((b) => {
      const btn = document.createElement('button');
      btn.className = 'btn ' + (b.type || 'default');
      btn.textContent = b.text;
      btn.addEventListener('click', async () => {
        if (b.onClick) {
          btn.disabled = true;
          try {
            const r = await b.onClick(api);
            if (r === false) { btn.disabled = false; return; }
          } catch (e) { btn.disabled = false; return; }
          btn.disabled = false;
        }
        if (!b.keepOpen) close(b.value);
      });
      foot.appendChild(btn);
    });

    function onKey(e) { if (e.key === 'Escape' && opts.closeOnEsc !== false) close(); }
    document.addEventListener('keydown', onKey);
    $('.modal-x', box).addEventListener('click', () => close());
    mask.addEventListener('mousedown', (e) => { if (e.target === mask && opts.closeOnMask !== false) close(); });
    mask.appendChild(box);
    document.body.appendChild(mask);
    const first = $('input:not([type=hidden]),textarea,select', box);
    if (first && opts.autofocus !== false) setTimeout(() => first.focus(), 30);
    return api;
  }

  // 确认弹窗：返回 Promise<boolean>
  // confirmBox({ title, message, danger: true, okText, cancelText })
  function confirmBox(opts) {
    if (typeof opts === 'string') opts = { message: opts };
    return new Promise((resolve) => {
      let answer = false;
      modal({
        title: opts.title || '请确认',
        width: 420,
        body: `<div class="confirm-msg ${opts.danger ? 'danger' : ''}">${opts.html ? opts.message : esc(opts.message)}</div>`,
        buttons: [
          { text: opts.cancelText || '取消', type: 'ghost' },
          { text: opts.okText || '确定', type: opts.danger ? 'danger' : 'primary', onClick: () => { answer = true; } }
        ],
        onClose: () => resolve(answer)
      });
    });
  }

  // 表单弹窗：返回 Promise<对象|null>
  // formBox({ title, fields:[{name,label,type:'text|number|textarea|select|checkbox|password|datetime-local',
  //                           value, placeholder, required, options:[{value,text}], hint, step, min, max, rows}],
  //           okText, width, validate(values)->错误文案|undefined, danger })
  function formBox(opts) {
    return new Promise((resolve) => {
      const form = document.createElement('form');
      form.className = 'form-grid';
      form.innerHTML = opts.fields.map((f) => {
        const id = 'f_' + f.name;
        const req = f.required ? '<i class="req">*</i>' : '';
        let input = '';
        const val = f.value === undefined || f.value === null ? '' : f.value;
        if (f.type === 'textarea') {
          input = `<textarea id="${id}" name="${f.name}" rows="${f.rows || 3}" placeholder="${esc(f.placeholder || '')}" ${f.maxlength ? `maxlength="${f.maxlength}"` : ''}>${esc(val)}</textarea>`;
        } else if (f.type === 'select') {
          input = `<select id="${id}" name="${f.name}">${(f.options || []).map((o) =>
            `<option value="${esc(o.value)}" ${String(o.value) === String(val) ? 'selected' : ''}>${esc(o.text)}</option>`).join('')}</select>`;
        } else if (f.type === 'checkbox') {
          input = `<label class="check"><input type="checkbox" id="${id}" name="${f.name}" ${val ? 'checked' : ''}> ${esc(f.checkText || '')}</label>`;
        } else {
          input = `<input id="${id}" name="${f.name}" type="${f.type || 'text'}" value="${esc(val)}" placeholder="${esc(f.placeholder || '')}"
            ${f.step ? `step="${f.step}"` : ''} ${f.min !== undefined ? `min="${f.min}"` : ''} ${f.max !== undefined ? `max="${f.max}"` : ''}
            ${f.maxlength ? `maxlength="${f.maxlength}"` : ''} autocomplete="off">`;
        }
        return `<div class="form-row ${f.full ? 'full' : ''}"><label for="${id}">${esc(f.label)}${req}</label>${input}${f.hint ? `<div class="hint">${esc(f.hint)}</div>` : ''}</div>`;
      }).join('');
      const errBox = document.createElement('div');
      errBox.className = 'form-error';

      const wrap = document.createElement('div');
      wrap.appendChild(form);
      wrap.appendChild(errBox);

      let result = null;
      const collect = () => {
        const values = {};
        opts.fields.forEach((f) => {
          const el = form.elements[f.name];
          if (!el) return;
          if (f.type === 'checkbox') values[f.name] = el.checked;
          else values[f.name] = typeof el.value === 'string' ? el.value.trim() : el.value;
        });
        return values;
      };
      const m = modal({
        title: opts.title,
        width: opts.width || 520,
        body: wrap,
        buttons: [
          { text: '取消', type: 'ghost' },
          {
            text: opts.okText || '保存', type: opts.danger ? 'danger' : 'primary', keepOpen: true,
            onClick: async (api) => {
              const values = collect();
              for (const f of opts.fields) {
                if (f.required && f.type !== 'checkbox' && (values[f.name] === '' || values[f.name] === undefined)) {
                  errBox.textContent = `请填写「${f.label}」`;
                  return false;
                }
              }
              if (opts.validate) {
                const msg = opts.validate(values);
                if (msg) { errBox.textContent = msg; return false; }
              }
              errBox.textContent = '';
              if (opts.submit) {
                // submit 抛错时留在弹窗里，让用户改了再试
                try { await opts.submit(values); } catch (e) { errBox.textContent = e.message || '操作失败'; return false; }
              }
              result = values;
              api.close();
            }
          }
        ],
        onClose: () => resolve(result)
      });
      form.addEventListener('submit', (e) => { e.preventDefault(); $('.btn.primary,.btn.danger', m.el.querySelector('.modal-foot')).click(); });
    });
  }

  // ------------------------------------------------------------------
  // 请求封装
  //   api('/api/admin/orders', { query:{page:1}, method:'POST', body:{...}, raw:true, silent:true })
  //   默认返回 json.data；raw:true 返回整个 json（带 total/page 等）；出错自动 toast 并抛异常（silent:true 不 toast）
  // ------------------------------------------------------------------
  async function api(path, options) {
    options = options || {};
    let url = path;
    if (options.query) {
      const qs = Object.entries(options.query)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
      if (qs) url += (url.includes('?') ? '&' : '?') + qs;
    }
    let res;
    try {
      res = await fetch(url, {
        method: options.method || 'GET',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (getToken() || '') },
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined
      });
    } catch (e) {
      if (!options.silent) toast('网络请求失败，请检查服务是否启动', 'error');
      throw new Error('网络请求失败');
    }
    let json = {};
    try { json = await res.json(); } catch (e) { json = { code: res.status, message: '服务器返回格式错误' }; }
    if (res.status === 401) {
      localStorage.removeItem(TOKEN_KEY);
      showLogin('登录已过期，请重新登录');
      throw new Error(json.message || '未登录');
    }
    if (json.code !== 0) {
      if (!options.silent) toast(json.message || '请求失败', 'error');
      const err = new Error(json.message || '请求失败');
      err.data = json.data;
      throw err;
    }
    return options.raw ? json : json.data;
  }

  // 便捷：POST/PUT/DELETE 并提示成功文案
  async function act(path, method, body, successText) {
    const json = await api(path, { method, body, raw: true });
    toast(successText || json.message || '操作成功', 'success');
    return json.data;
  }

  // ------------------------------------------------------------------
  // 登录 / 布局
  // ------------------------------------------------------------------
  function showLogin(msg) {
    document.body.classList.remove('with-layout');
    const root = $('#app');
    root.innerHTML = `
      <div class="login-wrap">
        <form class="login-card" id="loginForm">
          <div class="login-logo">🍜</div>
          <h2>运营后台</h2>
          <p class="login-sub">请使用管理员账号登录</p>
          <input id="loginUsername" placeholder="用户名" autocomplete="username" value="${esc(getUsername() || 'admin')}">
          <input id="loginPassword" placeholder="密码" type="password" autocomplete="current-password">
          <button class="btn primary block" type="submit">登录</button>
          <p class="login-msg" id="loginMsg">${esc(msg || '')}</p>
        </form>
      </div>`;
    $('#loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const username = $('#loginUsername').value.trim();
      const password = $('#loginPassword').value;
      const msgEl = $('#loginMsg');
      msgEl.textContent = '';
      try {
        const res = await fetch('/api/auth/admin-login', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password })
        });
        const json = await res.json();
        if (json.code !== 0) { msgEl.textContent = json.message || '登录失败'; return; }
        localStorage.setItem(TOKEN_KEY, json.data.token);
        localStorage.setItem(NAME_KEY, json.data.username);
        location.reload();
      } catch (err) {
        msgEl.textContent = '登录请求失败，请检查网络或服务是否启动';
      }
    });
    setTimeout(() => $('#loginPassword') && $('#loginPassword').focus(), 30);
  }

  function buildLayout(key, title) {
    document.body.classList.add('with-layout');
    const nav = NAV.map((g) => `
      <div class="nav-group">
        <div class="nav-title">${g.group}</div>
        ${g.items.map((i) => `<a class="nav-item ${i.key === key ? 'active' : ''}" href="${i.href}"><span class="nav-ic">${i.icon}</span>${i.text}<span class="nav-badge" data-badge="${i.key}"></span></a>`).join('')}
      </div>`).join('');
    $('#app').innerHTML = `
      <header class="topbar">
        <button class="menu-btn" id="menuBtn" aria-label="菜单">☰</button>
        <div class="brand">🍜 <span>食客共创 · 运营后台</span></div>
        <div class="top-right">
          <span class="who">👤 ${esc(getUsername() || '')}</span>
          <button class="btn ghost sm" id="pwdBtn">修改密码</button>
          <button class="btn ghost sm" id="logoutBtn">退出登录</button>
        </div>
      </header>
      <aside class="sidebar" id="sidebar">${nav}</aside>
      <div class="sidebar-mask" id="sidebarMask"></div>
      <main class="main">
        <div class="page-head"><h2>${esc(title || '')}</h2><div class="page-actions" id="pageActions"></div></div>
        <div id="pageBody"></div>
      </main>`;
    $('#logoutBtn').addEventListener('click', async () => {
      if (await confirmBox({ title: '退出登录', message: '确定要退出后台吗？' })) logout();
    });
    $('#pwdBtn').addEventListener('click', changePassword);
    const toggle = (open) => { $('#sidebar').classList.toggle('open', open); $('#sidebarMask').classList.toggle('open', open); };
    $('#menuBtn').addEventListener('click', () => toggle(!$('#sidebar').classList.contains('open')));
    $('#sidebarMask').addEventListener('click', () => toggle(false));
    loadBadges();
  }

  // 侧边栏角标：待接单订单、待审核退款、待处理投诉
  async function loadBadges() {
    try {
      const s = await api('/api/admin/stats', { silent: true });
      const set = (k, n) => { const el = $(`[data-badge="${k}"]`); if (el) { el.textContent = n > 0 ? n : ''; el.style.display = n > 0 ? '' : 'none'; } };
      set('orders', s.todo.wait_accept);
      set('refunds', s.todo.pending_refunds);
      set('complaints', s.todo.pending_complaints);
    } catch (e) { /* 角标失败不影响页面 */ }
  }

  async function changePassword() {
    await formBox({
      title: '修改登录密码',
      width: 420,
      fields: [
        { name: 'oldPassword', label: '原密码', type: 'password', required: true, full: true },
        { name: 'newPassword', label: '新密码', type: 'password', required: true, full: true, hint: '至少 6 位' },
        { name: 'again', label: '确认新密码', type: 'password', required: true, full: true }
      ],
      validate: (v) => (v.newPassword.length < 6 ? '新密码至少 6 位' : v.newPassword !== v.again ? '两次输入的新密码不一致' : ''),
      submit: async (v) => { await act('/api/auth/admin-change-password', 'POST', { oldPassword: v.oldPassword, newPassword: v.newPassword }, '密码已修改'); }
    });
  }

  function logout() {
    localStorage.removeItem(TOKEN_KEY);
    location.reload();
  }

  // ------------------------------------------------------------------
  // 页面初始化
  // ------------------------------------------------------------------
  // Admin.init({ key, title }, async (body, ctx) => {...})   ctx.setActions(html) 往右上角放按钮
  function init(opts, loadFn) {
    if (!getToken()) { showLogin(); return; }
    buildLayout(opts.key, opts.title);
    const body = $('#pageBody');
    const ctx = {
      actions: $('#pageActions'),
      setActions(html) { this.actions.innerHTML = html; return this.actions; },
      refreshBadges: loadBadges
    };
    Promise.resolve(loadFn(body, ctx)).catch((e) => {
      console.error(e);
      body.insertAdjacentHTML('afterbegin', `<div class="empty-state">页面加载失败：${esc(e.message || e)}</div>`);
    });
  }

  // ------------------------------------------------------------------
  // 分页：renderPager(container, { page, pageSize, total }, (page)=>{})
  // ------------------------------------------------------------------
  function renderPager(container, state, onChange) {
    const pages = Math.max(1, Math.ceil(state.total / state.pageSize));
    if (state.total === 0) { container.innerHTML = ''; return; }
    const cur = state.page;
    const nums = [];
    const push = (n) => { if (!nums.includes(n) && n >= 1 && n <= pages) nums.push(n); };
    push(1); push(2);
    for (let i = cur - 2; i <= cur + 2; i++) push(i);
    push(pages - 1); push(pages);
    nums.sort((a, b) => a - b);
    let html = `<span class="pager-info">共 ${num(state.total)} 条 · 第 ${cur}/${pages} 页</span>`;
    html += `<button class="pg" data-p="${cur - 1}" ${cur <= 1 ? 'disabled' : ''}>上一页</button>`;
    let last = 0;
    nums.forEach((n) => {
      if (n - last > 1) html += '<span class="pg-dots">…</span>';
      html += `<button class="pg ${n === cur ? 'active' : ''}" data-p="${n}">${n}</button>`;
      last = n;
    });
    html += `<button class="pg" data-p="${cur + 1}" ${cur >= pages ? 'disabled' : ''}>下一页</button>`;
    container.className = 'pager';
    container.innerHTML = html;
    $$('.pg', container).forEach((b) => b.addEventListener('click', () => {
      const p = Number(b.dataset.p);
      if (p >= 1 && p <= pages && p !== cur) onChange(p);
    }));
  }

  // 状态徽标：badge('已支付', 'green')
  function badge(text, color) { return `<span class="badge ${color || 'gray'}">${esc(text)}</span>`; }

  // 防抖
  function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms || 300); }; }

  // 图片上传：选文件 → 上传 → 返回 { url, path }（库里存 path）
  async function uploadImage(file) {
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch('/api/upload', { method: 'POST', headers: { Authorization: 'Bearer ' + getToken() }, body: fd });
    const json = await res.json();
    if (json.code !== 0) { toast(json.message || '上传失败', 'error'); throw new Error(json.message); }
    return json.data;
  }

  // 订单状态 → 徽标颜色
  const ORDER_COLORS = {
    pending: 'orange', paid: 'blue', accepted: 'blue', cooking: 'purple', delivery: 'purple',
    ready: 'purple', completed: 'green', cancelled: 'gray', refunded: 'red'
  };

  window.Admin = {
    init, api, act, toast, modal, confirmBox, formBox, renderPager, badge, debounce, uploadImage,
    esc, yuan, num, $, $$, logout, ORDER_COLORS, getUsername
  };
})();
