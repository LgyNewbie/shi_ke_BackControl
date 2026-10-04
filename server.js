require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

require('./db/init'); // 确保启动时数据库和表已初始化

const authRoutes = require('./routes/auth');
const walletRoutes = require('./routes/wallet');
const orderRoutes = require('./routes/order');
const couponRoutes = require('./routes/coupon');
const complaintRoutes = require('./routes/complaint');
const refundRoutes = require('./routes/refund');
const adminRoutes = require('./routes/admin');

const app = express();
// =========================
// 图片上传配置
// =========================

const uploadDir = path.join(__dirname, 'uploads');

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },

  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const filename =
      Date.now() +
      '-' +
      Math.random().toString(36).slice(2, 8) +
      ext;

    cb(null, filename);
  }
});

const upload = multer({
  storage,

  limits: {
    fileSize: 10 * 1024 * 1024
  }
});
app.use('/uploads', express.static(uploadDir));

// =========================
// 图片上传接口
// =========================

app.post('/api/upload', upload.single('file'), (req, res) => {

  if (!req.file) {
    return res.status(400).json({
      code: 400,
      message: '请选择要上传的图片'
    });
  }

  const imageUrl =
    `http://192.168.53.145:3000/uploads/${req.file.filename}`;

  res.json({
    code: 0,
    message: '图片上传成功',
    data: {
      url: imageUrl
    }
  });
});



app.use(cors());
app.use(express.json());

// 临时请求日志：查看后端实际收到的请求
app.use((req, res, next) => {
  console.log('========== 后端收到请求 ==========');
  console.log('请求方法：', req.method);
  console.log('请求地址：', req.originalUrl);
  console.log('请求数据：', req.body);
  next();
});

// 健康检查，用来确认服务是否正常运行
app.get('/api/health', (req, res) => res.json({ code: 0, message: 'ok', time: new Date().toISOString() }));

app.use('/api/auth', authRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/coupons', couponRoutes);
app.use('/api/complaints', complaintRoutes);
app.use('/api/refunds', refundRoutes);
app.use('/api/admin', adminRoutes);

// 管理后台网页（纯静态文件，浏览器直接访问 http://你的域名或IP:端口/admin/ 打开）
app.use('/admin', express.static(path.join(__dirname, 'admin-panel')));

// 兜底错误处理
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ code: 500, message: '服务器内部错误', error: err.message });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`服务已启动：http://0.0.0.0:${PORT}`);
  console.log(`局域网访问地址：http://192.168.199.195:${PORT}`);
  console.log(`管理后台地址：http://localhost:${PORT}/admin/`);
});
