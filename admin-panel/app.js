// 所有页面共用的登录状态管理 + 请求封装
// 说明：这里为了简单，用 localStorage 存管理员 token，
// 这是管理后台自己用的，跟小程序端的用户体系完全分开，不影响小程序合规性。

function getToken() { return localStorage.getItem('admin_token'); }
function getUsername() { return localStorage.getItem('admin_username'); }

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + (getToken() || ''),
      ...(options.headers || {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const json = await res.json();
  if (res.status === 401) {
    localStorage.removeItem('admin_token');
    showLogin();
    throw new Error(json.message || '未登录');
  }
  if (json.code !== 0) {
    alert(json.message || '请求失败');
    throw new Error(json.message);
  }
  return json.data;
}

async function doLogin() {
  const username = document.getElementById('loginUsername').value.trim();
  const password = document.getElementById('loginPassword').value;
  const msgEl = document.getElementById('loginMsg');
  try {
    const res = await fetch('/api/auth/admin-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const json = await res.json();
    if (json.code !== 0) {
      msgEl.textContent = json.message;
      return;
    }
    localStorage.setItem('admin_token', json.data.token);
    localStorage.setItem('admin_username', json.data.username);
    location.reload();
  } catch (e) {
    msgEl.textContent = '登录请求失败，请检查网络或服务是否启动';
  }
}

function logout() {
  localStorage.removeItem('admin_token');
  location.reload();
}

function showLogin() {
  document.getElementById('loginBox').style.display = 'block';
  document.getElementById('mainBox').style.display = 'none';
}

function showMain() {
  document.getElementById('loginBox').style.display = 'none';
  document.getElementById('mainBox').style.display = 'block';
  const who = document.getElementById('whoami');
  if (who) who.textContent = '当前账号：' + getUsername();
}

// 每个页面在最后调用 initPage(pageLoadFn)，pageLoadFn 是登录成功后要执行的加载函数
function initPage(pageLoadFn) {
  if (!getToken()) {
    showLogin();
    return;
  }
  showMain();
  if (pageLoadFn) pageLoadFn();
}

function fenToYuan(fen) {
  return (Number(fen || 0) / 100).toFixed(2);
}

function badge(status) {
  return `<span class="badge ${status}">${status}</span>`;
}
