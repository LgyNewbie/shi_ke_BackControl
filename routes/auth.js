const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db/init');
const { requireUser, requireAdmin, signUserToken, signAdminToken } = require('../middleware/auth');
const { wrap, BizError, ensureWallet } = require('../services/orders');

const router = express.Router();

function userPayload(user, withToken = true) {
  const out = {
    id: user.id,
    userId: user.id,
    dev_account: user.dev_account || '',
    nickname: user.nickname || '',
    avatar: user.avatar || '',
    phone: user.phone || ''
  };
  if (withToken) out.token = signUserToken(user.id);
  return out;
}

function findOrCreateUser({ openid, devAccount, nickname, avatar }) {
  let user = openid
    ? db.prepare('SELECT * FROM users WHERE openid = ?').get(openid)
    : db.prepare('SELECT * FROM users WHERE dev_account = ?').get(devAccount);
  if (!user) {
    const info = openid
      ? db.prepare('INSERT INTO users (openid, nickname, avatar) VALUES (?, ?, ?)').run(openid, nickname || '食客', avatar || '')
      : db.prepare('INSERT INTO users (dev_account, nickname, avatar) VALUES (?, ?, ?)').run(devAccount, nickname || devAccount, avatar || '');
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  }
  ensureWallet(user.id);
  if (user.status !== 'normal') throw new BizError('该账号已被禁用', 403);
  db.prepare("UPDATE users SET last_login_at = datetime('now','localtime') WHERE id = ?").run(user.id);
  return user;
}

// 向微信换取 openid（需要在 .env 配置 WX_APPID / WX_SECRET）
async function code2Session(code) {
  const url = `https://api.weixin.qq.com/sns/jscode2session?appid=${encodeURIComponent(process.env.WX_APPID)}` +
    `&secret=${encodeURIComponent(process.env.WX_SECRET)}&js_code=${encodeURIComponent(code)}&grant_type=authorization_code`;
  const r = await fetch(url);
  const j = await r.json();
  if (!j.openid) throw new BizError(`微信登录失败：${j.errmsg || '未知错误'}`, 401);
  return j.openid;
}

// ------- 小程序端登录 -------
// 正式环境：小程序 wx.login() 拿到 code，POST { code }，后端向微信换 openid，按 openid 建/查用户。
//           （.env 里配置 WX_APPID、WX_SECRET，并把 DEV_LOGIN_ENABLED 改成 false）
// 开发环境：没有配置微信密钥时，POST { devAccount, nickname } 用任意字符串模拟账号。
router.post('/wx-login', wrap(async (req, res) => {
  const { code, devAccount, nickname, avatar } = req.body || {};
  const wxReady = !!(process.env.WX_APPID && process.env.WX_SECRET);

  let user;
  if (wxReady && code) {
    const openid = await code2Session(code);
    user = findOrCreateUser({ openid, nickname, avatar });
  } else if (process.env.DEV_LOGIN_ENABLED === 'true') {
    if (!devAccount) throw new BizError('缺少 devAccount（开发模式下的模拟账号标识）');
    user = findOrCreateUser({ devAccount: String(devAccount).slice(0, 64), nickname, avatar });
  } else {
    throw new BizError('微信登录未配置：请在服务器 .env 中设置 WX_APPID 和 WX_SECRET', 400);
  }
  res.json({ code: 0, data: userPayload(user) });
}));

router.get('/me', requireUser, wrap((req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  res.json({ code: 0, data: userPayload(user, false) });
}));

router.post('/profile', requireUser, wrap((req, res) => {
  const { nickname, avatar, phone } = req.body || {};
  if (phone && !/^1\d{10}$/.test(String(phone))) throw new BizError('手机号格式不正确');
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  db.prepare('UPDATE users SET nickname = ?, avatar = ?, phone = ? WHERE id = ?').run(
    nickname ? String(nickname).slice(0, 30) : user.nickname,
    avatar !== undefined ? String(avatar) : user.avatar,
    phone !== undefined ? String(phone) : user.phone,
    req.userId
  );
  const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  res.json({ code: 0, message: '已保存', data: userPayload(fresh, false) });
}));

// ------- 管理后台登录 -------
router.post('/admin-login', wrap((req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) throw new BizError('请输入用户名和密码');
  const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(username);
  if (!admin || !bcrypt.compareSync(password, admin.password_hash)) {
    throw new BizError('用户名或密码错误', 401);
  }
  const token = signAdminToken(admin.id, admin.username);
  db.prepare(
    `INSERT INTO admin_logs (admin_id, admin_username, module, action, method, path, detail, ip)
     VALUES (?, ?, '账号', '登录后台', 'POST', '/api/auth/admin-login', '', ?)`
  ).run(admin.id, admin.username, req.ip || '');
  res.json({ code: 0, data: { token, username: admin.username, role: admin.role } });
}));

// 管理员修改自己的密码（必须已登录）
router.post('/admin-change-password', requireAdmin, wrap((req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  const admin = db.prepare('SELECT * FROM admins WHERE id = ?').get(req.adminId);
  if (!admin || !bcrypt.compareSync(String(oldPassword || ''), admin.password_hash)) {
    throw new BizError('原密码不正确', 400);
  }
  if (!newPassword || String(newPassword).length < 6) throw new BizError('新密码至少6位');
  db.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(String(newPassword), 10), admin.id);
  res.json({ code: 0, message: '密码修改成功' });
}));

module.exports = router;
