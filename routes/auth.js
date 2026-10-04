const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db/init');
const { signUserToken, signAdminToken } = require('../middleware/auth');

const router = express.Router();

// ------- 小程序端登录 -------
// 【重要】这是"开发模式"登录：小程序传一个 devAccount（比如手机号或随便一个字符串），
// 不存在就自动注册一个用户，存在就直接登录。
//
// 等你后面正式上线、拿到微信支付资质、要接入真实微信登录时，
// 把这个接口改成：
//   1. 小程序端调用 wx.login() 拿到 code
//   2. 后端拿 code 去请求微信接口 https://api.weixin.qq.com/sns/jscode2session
//      换取 openid
//   3. 用 openid 去 users 表查/建用户，openid 字段存起来
// 其他逻辑（钱包、优惠券、投诉、退款）完全不用动。
router.post('/wx-login', (req, res) => {
  if (process.env.DEV_LOGIN_ENABLED !== 'true') {
    return res.status(400).json({ code: 400, message: '开发模式登录已关闭，请接入正式微信登录' });
  }
  const { devAccount, nickname } = req.body;
  if (!devAccount) {
    return res.status(400).json({ code: 400, message: '缺少 devAccount（模拟账号标识，比如手机号）' });
  }

  let user = db.prepare('SELECT * FROM users WHERE dev_account = ?').get(devAccount);
  if (!user) {
    const info = db.prepare(
      'INSERT INTO users (dev_account, nickname) VALUES (?, ?)'
    ).run(devAccount, nickname || devAccount);
    db.prepare('INSERT INTO wallets (user_id, balance) VALUES (?, 0)').run(info.lastInsertRowid);
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  }

  const token = signUserToken(user.id);
  res.json({ code: 0, data: { token, userId: user.id, nickname: user.nickname } });
});

// ------- 管理后台登录 -------
router.post('/admin-login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ code: 400, message: '请输入用户名和密码' });
  }
  const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(username);
  if (!admin || !bcrypt.compareSync(password, admin.password_hash)) {
    return res.status(401).json({ code: 401, message: '用户名或密码错误' });
  }
  const token = signAdminToken(admin.id, admin.username);
  res.json({ code: 0, data: { token, username: admin.username } });
});

// 管理员修改密码
router.post('/admin-change-password', (req, res) => {
  const { username, oldPassword, newPassword } = req.body;
  const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(username);
  if (!admin || !bcrypt.compareSync(oldPassword, admin.password_hash)) {
    return res.status(401).json({ code: 401, message: '原密码不正确' });
  }
  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ code: 400, message: '新密码至少6位' });
  }
  const hash = bcrypt.hashSync(newPassword, 10);
  db.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').run(hash, admin.id);
  res.json({ code: 0, message: '密码修改成功' });
});

module.exports = router;
