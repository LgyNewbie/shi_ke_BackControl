# 小程序后端 —— 钱包退款 / 优惠券 / 客户投诉 / 退款审核

这是一套**最小可用**的后端系统，专门用来支撑你在还没申请到个体工商户、暂时无法接入微信支付这段时间需要的运营能力：

- 取消订单后资金退回（先退到"站内钱包"，接入微信支付后可无缝切到真实退款）
- 优惠券对指定用户发放 / 回收
- 客户投诉工单
- 退款申请与审核

技术选型：**Node.js + Express + SQLite**（用的是 Node.js 官方内置的 `node:sqlite` 模块，不是第三方包，所以不需要你额外安装数据库、也不需要装 Python/Visual Studio 之类的编译工具，装好 Node.js 就能跑）。附带一个**管理后台网页**，你在浏览器里操作即可，不需要写代码。

> **Node 版本要求：必须是 Node.js 22.5 及以上**，推荐直接装 **Node 24（当前的 LTS 长期支持版）**。如果版本低于 22.5，内置数据库模块用不了；如果是 22.x（低于24），能用但会在控制台打印一行"experimental"提示，属于正常现象，不影响使用。

---

## 一、目录结构

```
miniprogram-backend/
├── server.js              # 启动入口
├── db/
│   ├── init.js             # 建表逻辑
│   └── data.sqlite         # 数据库文件（首次启动自动生成，注意备份！）
├── middleware/auth.js       # 登录校验
├── routes/                  # 所有接口
│   ├── auth.js              # 登录（小程序端 + 管理后台）
│   ├── wallet.js             # 钱包余额/流水
│   ├── order.js              # 订单创建/支付/取消退款
│   ├── coupon.js             # 优惠券模板/发放/回收/使用
│   ├── complaint.js          # 投诉提交/处理
│   ├── refund.js              # 退款申请/审核
│   └── admin.js               # 管理后台辅助接口（用户列表、统计）
└── admin-panel/              # 管理后台网页（纯静态 html/css/js）
```

---

## 二、本地先跑起来试试（建议先在自己电脑上测试一遍）

1. 安装 [Node.js](https://nodejs.org/)（选 LTS 长期支持版，一路下一步即可）
2. 打开命令行，进入项目目录：
   ```bash
   cd miniprogram-backend
   npm install
   cp .env.example .env
   ```
3. 启动服务：
   ```bash
   npm start
   ```
4. 看到 `服务已启动：http://localhost:3000` 说明成功了
5. 打开浏览器访问 `http://localhost:3000/admin/`，用 `.env` 里配置的账号密码登录（默认 `admin / admin123456`，**首次登录后记得改密码**）

---

## 三、部署到你自己的云服务器（正式上线用）

假设你已经买了一台云服务器（阿里云/腾讯云都行，2核2G以上、Linux系统即可）。

1. **装 Node.js（一定要 22.5 以上，推荐装 24）**：登录服务器，执行（以 Ubuntu/Debian 为例，具体命令看你服务器系统）：
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
   sudo apt-get install -y nodejs
   node -v   # 确认输出的版本号 >= 22.5，最好是 24.x
   ```
2. **上传代码**：把整个 `miniprogram-backend` 文件夹上传到服务器（用宝塔面板的文件管理、或者 `scp` 命令、或者 FTP 工具都可以，选你最熟悉的方式）
3. **安装依赖 + 配置**：
   ```bash
   cd miniprogram-backend
   npm install
   cp .env.example .env
   # 用 vi .env 或宝塔的文件编辑器打开 .env，把 JWT_SECRET 改成一长串你自己随便打的字符，
   # 把 ADMIN_INIT_PASSWORD 改成你自己的管理员密码
   ```
4. **用 pm2 让服务常驻后台运行**（防止你关掉命令行窗口服务就停了）：
   ```bash
   sudo npm install -g pm2
   pm2 start server.js --name miniprogram-backend
   pm2 save
   pm2 startup    # 按提示执行它给你的那条命令，设置成开机自启
   ```
5. **配置 Nginx 反向代理 + HTTPS 证书**（微信小程序要求接口域名必须是 HTTPS，且是正规证书，不能用 IP 或自签证书）：
   - 你需要先有一个已备案的域名（国内服务器必须备案）
   - 用宝塔面板或手动配置 Nginx，把域名反向代理到 `http://127.0.0.1:3000`
   - 申请 SSL 证书（宝塔/阿里云/腾讯云都有免费证书可以一键申请）
   - 如果这一步你不熟悉，建议直接用宝塔面板，它有图形化的"反向代理"和"SSL"功能，比纯命令行简单很多
6. **在微信公众平台配置服务器域名**：
   - 登录 [微信公众平台](https://mp.weixin.qq.com) → 你的小程序 → 开发 → 开发设置 → 服务器域名
   - 把你的域名（比如 `https://api.你的域名.com`）填入 "request合法域名"
   - 这一步必须做，否则小程序上线后请求会被微信直接拦截

---

## 四、小程序端怎么调用（原生小程序 wx.request 示例）

建议在小程序里建一个 `utils/api.js` 统一封装请求：

```javascript
// utils/api.js
const BASE_URL = 'https://api.你的域名.com'; // 本地测试时可以用 http://localhost:3000（真机调试要开"不校验合法域名"）

function request(url, method = 'GET', data = {}) {
  return new Promise((resolve, reject) => {
    wx.request({
      url: BASE_URL + url,
      method,
      data,
      header: {
        'Authorization': 'Bearer ' + (wx.getStorageSync('token') || '')
      },
      success(res) {
        if (res.data.code === 0) resolve(res.data.data);
        else reject(res.data);
      },
      fail: reject
    });
  });
}

module.exports = { request };
```

登录（开发阶段用模拟登录，先把整体流程跑通）：

```javascript
const { request } = require('../../utils/api.js');

// 开发阶段：用手机号或任意字符串模拟登录
request('/api/auth/wx-login', 'POST', { devAccount: '13800000000', nickname: '测试用户' })
  .then(data => {
    wx.setStorageSync('token', data.token);
    wx.setStorageSync('userId', data.userId);
  });
```

取消订单（自动退款到钱包）：

```javascript
request(`/api/orders/${orderId}/cancel`, 'POST').then(res => {
  wx.showToast({ title: res.refunded ? '已退款到钱包' : '订单已取消' });
});
```

提交投诉：

```javascript
request('/api/complaints', 'POST', {
  orderId: 123,
  type: '商品问题',
  content: '收到的商品有破损',
  images: [] // 图片先上传到你自己的图床/云存储，拿到URL后传数组进来
}).then(() => wx.showToast({ title: '提交成功' }));
```

查询优惠券：

```javascript
request('/api/coupons/mine', 'GET').then(coupons => {
  this.setData({ coupons });
});
```

---

## 五、以后接入微信支付时，需要改哪里？

不需要重构，只改三处：

1. **登录**：`routes/auth.js` 的 `/wx-login` 接口，把"模拟登录"换成真正调用微信 `wx.login()` + 后端 `code2Session` 换取 openid 的逻辑，并把 `.env` 里 `DEV_LOGIN_ENABLED` 改成 `false`。
2. **支付**：`routes/order.js` 的 `/pay` 接口，换成发起微信支付统一下单 + 接收微信支付回调（回调里把订单状态改成 `paid`，跟现在的逻辑一样）。
3. **退款**：`routes/order.js` 的 `/cancel` 和 `routes/refund.js` 的审核通过分支，在"退回钱包"这行代码前，加一步调用微信支付的"退款"API，把钱原路退回用户的微信支付账户。站内钱包可以保留，用作人工补偿/活动奖励的通道。

其他所有接口（优惠券、投诉）完全不用动。

---

## 六、以后数据量大了，想换 MySQL 怎么办？

SQLite 单文件在几万到几十万条数据量级完全够用，不用太早焦虑。真到需要换的时候：
把 `db/init.js` 里的 SQL 建表语句挪到 MySQL 里执行，然后把 `node:sqlite` 换成 `mysql2` 客户端，各路由里的 `db.prepare(...).get()/.all()/.run()` 语法基本都能找到对应的写法。业务逻辑（钱包怎么算、优惠券状态怎么流转）完全不需要重新设计。

---

## 七、务必注意的几点

1. **备份 `db/data.sqlite` 文件**：这是你全部业务数据（用户、钱包、优惠券、投诉、退款），建议写个定时任务每天复制一份到别的地方。
2. **管理员密码**：首次登录后台后立刻改密码（`admin-panel` 登录后可以调用 `/api/auth/admin-change-password` 接口改，暂时没做界面，需要的话告诉我再加）。
3. **不要把 `.env` 文件传到公开的代码仓库**（比如 GitHub 公开仓库），里面有密钥信息。
4. 这套系统里的"钱包余额"只是**站内记账**，不是真实货币账户，法律上属于预付卡/储值性质，正式大规模运营前建议再咨询一下是否需要额外的合规手续（不同地区规定不同）。
