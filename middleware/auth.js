const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;

// 校验小程序端用户登录态，通过后 req.userId 里有用户id
function requireUser(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ code: 401, message: '未登录' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.type !== 'user') throw new Error('token类型不对');
    req.userId = payload.userId;
    next();
  } catch (e) {
    return res.status(401).json({ code: 401, message: '登录已过期，请重新登录' });
  }
}

// 校验管理后台登录态，通过后 req.adminId / req.adminUsername 里有管理员信息
function requireAdmin(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
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

module.exports = { requireUser, requireAdmin, signUserToken, signAdminToken };
