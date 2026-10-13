require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');

const db = require('./db/init'); // 确保启动时数据库和表已初始化/升级
const { adminLogger } = require('./services/logger');
const { baseUrl } = require('./services/url');
const orderSvc = require('./services/orders');

const app = express();
app.set('trust proxy', true); // 放在 Nginx 后面时，能拿到真实的 https 协议和 IP

// =========================
// 图片上传
// =========================
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const ALLOWED_EXT = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, Date.now() + '-' + Math.random().toString(36).slice(2, 8) + ext);
    }
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(ALLOWED_EXT.includes(ext) ? null : new Error('只支持 jpg/png/gif/webp 图片'), ALLOWED_EXT.includes(ext));
  }
});

app.use(cors());
app.use('/uploads', express.static(uploadDir));

// 上传必须登录（小程序用户或后台管理员都可以），避免被陌生人刷满磁盘
function requireAnyLogin(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  try {
    const p = jwt.verify(token, process.env.JWT_SECRET);
    if (p.type === 'user' || p.type === 'admin') return next();
  } catch (e) { /* 走下面的 401 */ }
  return res.status(401).json({ code: 401, message: '请先登录' });
}

app.post('/api/upload', requireAnyLogin, (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ code: 400, message: err.message || '上传失败' });
    if (!req.file) return res.status(400).json({ code: 400, message: '请选择要上传的图片' });
    const rel = `/uploads/${req.file.filename}`;
    // url：完整地址（小程序直接用）；path：相对路径（库里建议存这个，换域名/IP 也不会失效）
    res.json({ code: 0, message: '图片上传成功', data: { url: baseUrl(req) + rel, path: rel } });
  });
});

app.use(express.json({ limit: '1mb' }));
app.use(adminLogger); // 后台写操作自动记日志

// 健康检查
app.get('/api/health', (req, res) => res.json({ code: 0, message: 'ok', time: new Date().toISOString() }));

app.use('/api/auth', require('./routes/auth'));
app.use('/api/wallet', require('./routes/wallet'));
app.use('/api/orders', require('./routes/order'));
app.use('/api/coupons', require('./routes/coupon'));
app.use('/api/complaints', require('./routes/complaint'));
app.use('/api/refunds', require('./routes/refund'));
app.use('/api/messages', require('./routes/message'));
app.use('/api/foods', require('./routes/food'));
app.use('/api/favorites', require('./routes/favorite'));
app.use('/api/delivery', require('./routes/delivery'));
app.use('/api/polls', require('./routes/poll'));
app.use('/api/notices', require('./routes/notice'));
app.use('/api/reviews', require('./routes/review'));
app.use('/api/settings', require('./routes/settings'));

// 后台接口（都在 /api/admin 下，requireAdmin 保护）
app.use('/api/admin', require('./routes/admin'));
app.use('/api/admin', require('./routes/admin-shop'));
app.use('/api/admin', require('./routes/admin-orders'));
app.use('/api/admin', require('./routes/delivery').admin);
app.use('/api/admin', require('./routes/poll').admin);
app.use('/api/admin', require('./routes/notice').admin);
app.use('/api/admin', require('./routes/review').admin);
app.use('/api/admin', require('./routes/settings').admin);

// 管理后台网页（浏览器访问 http://域名或IP:端口/admin/）
app.use('/admin', express.static(path.join(__dirname, 'admin-panel')));

app.use('/api', (req, res) => res.status(404).json({ code: 404, message: '接口不存在：' + req.method + ' ' + req.path }));

// 兜底错误处理
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ code: err.status || 500, message: err.status === 400 ? '请求格式不正确' : '服务器内部错误' });
});

// 每分钟检查一次：待付款超时的订单自动取消，并把占用的优惠券还给用户
setInterval(() => {
  try {
    const n = orderSvc.cancelExpiredOrders();
    if (n) console.log(`[定时任务] 已自动取消 ${n} 个超时未支付订单`);
  } catch (e) {
    console.error('[定时任务] 超时取消失败', e.message);
  }
}, 60 * 1000).unref();

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`服务已启动：http://0.0.0.0:${PORT}`);
    console.log(`管理后台地址：http://localhost:${PORT}/admin/`);
  });
}

module.exports = app;
