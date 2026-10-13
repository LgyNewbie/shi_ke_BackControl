# 接口文档（后端 ↔ 小程序 / 后台页面）

通用约定
- 所有接口返回 `{ code: 0, message?, data? }`；失败时 `code` 非 0，HTTP 状态码同为 4xx/5xx，`message` 是可直接展示给用户的中文。
- **金额**：入参、出参一律是「元」（数字，可带 2 位小数）。数据库里存的是分，只有后端内部看得到。页面不要再 `/100` 或 `*100`。
- 小程序请求头：`Authorization: Bearer <token>`（`/api/auth/wx-login` 获取）；后台页面用 `/api/auth/admin-login` 的 token。
- 分页接口返回 `{ code:0, data:[...], total, page, pageSize }`。
- 图片：库里存相对路径 `/uploads/xxx.jpg`，接口输出时已补全成完整地址（跟随当前服务器地址），小程序可直接用于 `<image src>`。

## 一、小程序端

### 登录 `/api/auth`
| 方法 路径 | 说明 |
|---|---|
| POST `/wx-login` `{code?, devAccount?, nickname?, avatar?}` | 正式：传 `wx.login()` 的 `code`（需服务器 .env 配 `WX_APPID/WX_SECRET`）；开发：传 `devAccount`（任意字符串）。返回 `{id,userId,nickname,avatar,phone,dev_account,token}` |
| GET `/me` | 当前用户 |
| POST `/profile` `{nickname?,avatar?,phone?}` | 修改资料 |

### 菜单 `/api/foods`（无需登录；带 token 时详情会返回 `is_favorite`）
- GET `/` 在售菜品：`{id,category_id,category_name,name,description,image,price,discount_enabled,discount,discount_price,packing_fee,delivery_fee,ingredients,taste,weight,allergen,notice,sales,is_hot,status,review_count,rating_avg}`
- GET `/categories` → `{categories:[{id,name,sort_order,food_count}], has_hot}`，点餐页标签 = 「全部」+（`has_hot` 时「热销」）+ categories
- GET `/:id` 详情（同上字段 + `is_favorite`）
- GET `/:id/reviews?page&pageSize` 评价：`{id,rating,content,images,reply,created_at,nickname,avatar}`

### 订单 `/api/orders`（需登录）
下单体：`{ items:[{food_id,count}], delivery_type:'delivery'|'pickup', address_id?, user_coupon_id?, payment_method:'wechat'|'wallet', remark? }`
- POST `/preview` 同下单体（`address_id` 可省略）→ `{items,goods_amount,product_discount,coupon_discount,packing_fee,delivery_fee,amount,free_delivery,min_order_amount,free_delivery_threshold}`。**结算页显示的金额一律来自这里**。
- POST `/` 创建订单（服务端重新计价）→ `{orderId, order}`
- GET `/` 我的订单（数组，已排除用户删除的）
- GET `/:id` 订单详情
- POST `/:id/pay` `{payment_method?}` 支付 → 返回最新订单
- POST `/:id/cancel` 取消：未支付直接取消；已支付且商家未接单 → 自动退款到钱包。→ `{refunded, order}`
- POST `/:id/refund` `{reason?, amount?}` 申请退款（商家接单后；amount 不传 = 全额）
- POST `/:id/delete` 用户删除订单（仅 cancelled/completed/refunded）

订单对象 `order`：
```
id, order_no, title, status, status_text, payment_status(unpaid|paid|refunded), payment_status_text,
payment_method(wechat|wallet), payment_method_text, delivery_type(delivery|pickup), delivery_type_text, remark,
address:{name,phone,area_name,detail,full}|null,
items:[{id,food_id,name,image,description,price,discount_price,count,packing_fee,delivery_fee,subtotal}], item_count,
goods_amount, product_discount, coupon_discount, packing_fee, delivery_fee, amount(实付), refunded_amount,
coupon:{id,name,discount}|null,
created_at, paid_at, accepted_at, cooking_at, delivery_at, ready_at, completed_at, cancelled_at, refunded_at, expire_at, cancel_reason,
refund_status(none|pending|partial|refunded|rejected), refund_status_text,
refund:{id,status(pending_review|completed|rejected),amount,reason,review_remark,created_at,completed_at}|null,
can_pay, can_cancel, can_apply_refund, can_delete, can_review
```
`status`：`pending 待付款 → paid 待接单 → accepted 已接单 → cooking 制作中 → delivery 配送中(配送单)/ready 待取餐(自取单) → completed 已完成`；另有 `cancelled 已取消`、`refunded 已退款`。**开始制作由商家在后台点按钮，小程序没有此按钮**。

### 退款 `/api/refunds`
- GET `/mine` 我的退款记录（`amount` 为元）；POST `/` `{orderId,amount?,reason?}`（同 `/orders/:id/refund`）

### 钱包 `/api/wallet`
- GET `/balance` → `{balance}`；GET `/transactions` → `[{type,type_text,amount,balance_after,order_id,remark,created_at}]`

### 优惠券 `/api/coupons`
- GET `/mine` 我的券：`{id,template_id,name,type(fixed|discount),value,min_amount,description,status(unused|locked|used|revoked|expired),status_text,issued_at,expire_at,used_at,used_order_id,revoke_reason}`；折扣券 `value` 是几折（8.5）
- GET `/claimable` 领券中心：模板字段 + `claimed`
- POST `/claim/:templateId` 领取
- GET `/available?amount=<商品优惠后金额>` 结算页可用券：我的券字段 + `usable, discount, reason`（已按可用/抵扣额排序）

### 收藏 `/api/favorites`（需登录，按用户保存在服务端）
- GET `/` 菜品列表（同 `/api/foods` 字段）；GET `/ids`；POST `/:foodId/toggle` → `{is_favorite}`；DELETE `/:foodId`

### 配送区域 / 收货地址 `/api/delivery`
**用户只能选择商家预设的区域**，再补充联系人、手机号、门牌号。
- GET `/areas`（无需登录）→ `[{id,name,address,description}]`
- GET `/addresses` → `[{id,area_id,area_name,area_address,area_enabled,name,phone,detail,full,is_default}]`
- POST `/addresses` `{area_id,name,phone,detail?,is_default?}`；PUT `/addresses/:id`；DELETE `/addresses/:id`；POST `/addresses/:id/default`

### 投票 `/api/polls`
- GET `/`（带 token 返回 `my_choice`）；GET `/mine/list`；GET `/:id`；POST `/:id/vote` `{option_id}`
- 投票对象：`{id,title,description,status(active|ended|accepted|rejected),status_text,start_time,end_time,total_votes,my_choice,has_voted,options:[{id,name,description,votes,percent,is_winner}]}`

### 公告 `/api/notices`：GET `/`、GET `/:id` → `{id,title,content,type,pinned,author,created_at}`

### 评价 `/api/reviews`
- POST `/` `{order_id,food_id,rating(1-5),content?,images?[]}`（仅已完成订单，每商品一次）；GET `/mine`；GET `/order/:orderId` → 已评价的 food_id 数组

### 留言 `/api/messages`（原有，已改为以 token 为准识别用户）、投诉 `/api/complaints`（POST `/`、GET `/mine`）

### 设置 `/api/settings/public`
`{store_name,store_open,open_time,close_time,contact_phone,store_address,min_order_amount,free_delivery_threshold,order_timeout_minutes,wallet_pay_enabled}`

### 上传 `POST /api/upload`（multipart，字段 `file`，需登录）→ `{url(完整地址), path(相对路径，建议入库)}`

## 二、后台（`/api/admin/...`，均需管理员 token；所有写操作自动记入操作日志）

### 统计 / 日志 / 设置
- GET `/stats` → `{today:{orders,revenue},week,month,total,users:{total,today_new},todo:{wait_accept,cooking,delivering,pending_refunds,pending_complaints},wallet_total,status_distribution:[{status,text,count}],daily:[{day,orders,revenue,new_users}],top_foods:[{name,sales,revenue}]}`
- GET `/logs?module&admin&keyword&result&from&to&page&pageSize` → `data:[{id,admin_username,module,action,method,path,target,detail,result,ip,created_at}]` + `modules[]`、`admins[]`；POST `/logs/clear` `{days>=7}`
- GET `/settings`、PUT `/settings`（字段见 settings.js；`store_open/wallet_pay_enabled/enforce_business_hours` 为 0/1）；GET `/me`

### 订单
- GET `/orders?status&keyword&refund(1|pending)&delivery_type&from&to&page&pageSize` → 订单对象（含 `user:{id,nickname,dev_account,phone}`）+ `counts:{all,pending,paid,...,refund_pending}`
- GET `/orders/:id/detail` → `{order, complaints, wallet}`
- POST `/orders/:id/accept | cooking | ready | delivery | complete`（商家流转；自取单用 ready，配送单用 delivery；有待审核退款时不能流转）
- POST `/orders/:id/cancel` `{reason}`（已付款自动退款到钱包）；DELETE `/orders/:id`（仅未支付已取消）

### 菜品 / 分类
- GET `/foods?keyword&category_id(或none)&status(on_sale|off_sale)&hot=1&discount=1&sort(default|sales|price|new)&order(asc|desc)&page&pageSize` → `data`（菜品，金额为元）+ `total,page,pageSize` + `summary:{total,on_sale,off_sale,total_sales}`
- GET `/foods/ranking?range(today|7|30|all)&limit` → `[{rank,food_id,name,image,category_name,status,sales,revenue,order_count}]`
- GET `/foods/:id` → `{food, stats:{total_sales,revenue,order_count,sales_30d,review_count,rating_avg,favorite_count}, trend:[{day,qty}](14天), reviews}`
- POST `/foods`、PUT `/foods/:id` `{name,price,category_id,image,description,ingredients,taste,weight,allergen,notice,packing_fee,delivery_fee,discount_enabled,discount(折，10=不打折),is_hot,sort_order}`（金额单位元，可带小数）
- POST `/foods/:id/toggle` 上下架；POST `/foods/:id/hot` 热销标签；DELETE `/foods/:id`；POST `/foods/batch` `{ids,action:on_sale|off_sale|delete}`
- GET/POST `/categories`、PUT/DELETE `/categories/:id`、POST `/categories/:id/toggle`（data 含 `food_count`）

### 用户
- GET `/users?keyword&status(normal|blocked)&page&pageSize`；GET `/users/:id/detail`；POST `/users/:id/status` `{status}`

### 留言 / 评论 / 投票 / 公告 / 配送区域
- 留言：GET `/messages?keyword&status`、GET `/messages/:id/detail`、POST `/messages/:id/status` `{status:normal|hidden}`、POST `/messages/:id/comments` `{content}`（商家回复）、DELETE `/messages/:id`、DELETE `/messages/comments/:commentId`
- 评价：GET `/reviews?keyword&status&rating&food_id&unreplied=1&page`、POST `/reviews/:id/status`（隐藏/恢复）、POST `/reviews/:id/reply` `{reply}`、DELETE `/reviews/:id`
- 投票：GET `/polls?status&keyword`、GET `/polls/:id`（含 `voters`）、POST `/polls` `{title,description,end_time,options:[{name,description}],source_message_id?}`、PUT `/polls/:id`、POST `/polls/:id/status` `{status}`、DELETE `/polls/:id`
- 公告：GET `/notices`、POST `/notices` `{title,content,type,pinned}`、PUT `/notices/:id`、POST `/notices/:id/status`（上线/下线）、POST `/notices/:id/pin`、DELETE `/notices/:id`
- 配送区域：GET `/areas`（含 `address_count`）、POST `/areas` `{name,address,description,sort_order}`、PUT `/areas/:id`、POST `/areas/:id/toggle`、DELETE `/areas/:id`

### 优惠券 `/api/coupons/admin/...`
- GET `/templates` → `{id,name,type,value,min_amount,valid_days,remark,enabled,claimable,total_count,issued_count,remaining,used_count,holding_count,start_time,end_time,description}`
- POST `/templates`、PUT `/templates/:id` `{name,type(fixed|discount),value,min_amount,valid_days,remark,claimable,total_count,start_time,end_time}`；DELETE `/templates/:id`；POST `/templates/:id/toggle` `{enabled:0|1}`
- GET `/templates/:id/records`；GET `/user/:userId`；POST `/issue` `{templateId,userIds[]}`；POST `/issue-all` `{templateId}`；POST `/:userCouponId/revoke` `{reason}`

### 退款 / 投诉 / 钱包
- GET `/api/refunds/admin/list?status&keyword&page&pageSize`；POST `/api/refunds/admin/create` `{userId,orderId?,complaintId?,amount,reason}`；POST `/api/refunds/admin/:id/review` `{action:approve|reject,review_remark}`（通过后订单自动变「已退款」）
- GET `/api/complaints/admin/list?status&keyword&page&pageSize`（含 `order_no,order_amount,refundable`）；POST `/api/complaints/admin/:id/handle` `{status:processing|resolved|rejected,handle_remark,refund_id?}`；DELETE `/api/complaints/admin/:id`
- GET `/api/wallet/admin/overview?keyword&page&pageSize`（`total_balance`）；GET `/api/wallet/admin/user/:userId`；POST `/api/wallet/admin/manual-adjust` `{userId,amount(元,可负),remark}`
