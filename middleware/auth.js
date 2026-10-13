const jwt = require('jsonwebtoken');
const db = require('../db/init');

const JWT_SECRET = process.env.JWT_SECRET;

function readToken(req) {
  return (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
}

// 校验小程序端用户登录态，通过后 req.userId 里有用户id
function requireUser(req, res, next) {
  const token = readToken(req);
  if (!token) return res.status(401).json({ code: 401, message: '未登录' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.type !== 'user') throw new Error('token类型不对');
    const user = db.prepare('SELECT id, status FROM users WHERE id = ?').get(payload.userId);
    if (!user) return res.status(401).json({ code: 401, message: '账号不存在，请重新登录' });
    if (user.status !== 'normal') return res.status(403).json({ code: 403, message: '账号已被禁用' });
    req.userId = user.id;
    next();
  } catch (e) {
    return res.status(401).json({ code: 401, message: '登录已过期，请重新登录' });
  }
}

// 登录可选：有有效 token 就设置 req.userId，没有也放行（用于"未登录也能看，登录后多一些信息"的接口）
function optionalUser(req, res, next) {
  const token = readToken(req);
  if (token) {
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      if (payload.type === 'user') req.userId = payload.userId;
    } catch (e) { /* 忽略 */ }
  }
  next();
}

// 校验管理后台登录态，通过后 req.adminId / req.adminUsername 里有管理员信息
function requireAdmin(req, res, next) {
  const token = readToken(req);
  if (!token) return res.status(401).json({ code: 401, message: '请先登录管理后台' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.type !== 'admin') throw new Error('token类型不对');
    req.adminId = payload.adminId;
    req.adminUsername = payload.username;
    next();
  } catch (e) {
    return res.status(401).json({ code: 401, message: '登录已过期，请重新登录管理后台' });
  }
}

function signUserToken(userId) {
  return jwt.sign({ type: 'user', userId }, JWT_SECRET, { expiresIn: '30d' });
}

function signAdminToken(adminId, username) {
  return jwt.sign({ type: 'admin', adminId, username }, JWT_SECRET, { expiresIn: '7d' });
}

module.exports = { requireUser, optionalUser, requireAdmin, signUserToken, signAdminToken };
