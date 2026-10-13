// 小程序端订单接口。所有金额：入参/出参都是「元」。
//
//   POST /api/orders/preview      结算页算价（不创建订单）
//   POST /api/orders              创建订单（金额由服务端按菜品价格重新计算）
//   GET  /api/orders              我的订单列表
//   GET  /api/orders/:id          订单详情
//   POST /api/orders/:id/pay      支付（目前是模拟支付/钱包支付）
//   POST /api/orders/:id/cancel   取消订单（未支付直接取消；已支付且商家未接单则自动退款到钱包）
//   POST /api/orders/:id/refund   申请退款（商家已接单之后走这里，需商家审核）
//   POST /api/orders/:id/delete   删除订单（仅对用户隐藏）

const express = require('express');
const { requireUser } = require('../middleware/auth');
const { fenToYuan } = require('../services/money');
const svc = require('../services/orders');

const router = express.Router();
const { wrap, BizError } = svc;

router.post('/preview', requireUser, wrap((req, res) => {
  const p = svc.priceOrder(req.userId, req.body);
  const settings = svc.getSettings();
  res.json({
    code: 0,
    data: {
      items: p.lines.map(l => ({
        food_id: l.food_id, name: l.name, image: l.image, count: l.count,
        price: fenToYuan(l.unit_price), discount_price: fenToYuan(l.discount_price),
        packing_fee: fenToYuan(l.packing_fee), delivery_fee: fenToYuan(l.delivery_fee)
      })),
      goods_amount: fenToYuan(p.goods),
      product_discount: fenToYuan(p.productDiscount),
      coupon_discount: fenToYuan(p.couponDiscount),
      packing_fee: fenToYuan(p.packing),
      delivery_fee: fenToYuan(p.delivery),
      amount: fenToYuan(p.total),
      free_delivery: p.freeDelivery,
      min_order_amount: settings.min_order_amount,
      free_delivery_threshold: settings.free_delivery_threshold
    }
  });
}));

router.post('/', requireUser, wrap((req, res) => {
  const order = svc.createOrder(req.userId, req.body || {});
  res.json({ code: 0, message: '订单已创建', data: { orderId: order.id, order } });
}));

router.get('/', requireUser, wrap((req, res) => {
  res.json({ code: 0, data: svc.listUserOrders(req.userId) });
}));

router.get('/:id', requireUser, wrap((req, res) => {
  svc.cancelExpiredOrders();
  const row = svc.getOwnedOrder(req.userId, req.params.id);
  res.json({ code: 0, data: svc.orderView(row) });
}));

router.post('/:id/pay', requireUser, wrap((req, res) => {
  const order = svc.payOrder(req.userId, req.params.id, (req.body || {}).payment_method);
  res.json({ code: 0, message: '支付成功', data: order });
}));

router.post('/:id/cancel', requireUser, wrap((req, res) => {
  const before = svc.getOwnedOrder(req.userId, req.params.id);
  const wasPaid = before.status === 'paid';
  const order = svc.userCancel(req.userId, req.params.id);
  res.json({
    code: 0,
    message: wasPaid ? '订单已取消，金额已退回钱包' : '订单已取消',
    data: { refunded: wasPaid, order }
  });
}));

router.post('/:id/refund', requireUser, wrap((req, res) => {
  const { reason, amount } = req.body || {};
  const r = svc.applyRefund(req.userId, req.params.id, { reason, amount });
  res.json({ code: 0, message: '退款申请已提交，等待商家审核', data: r });
}));

router.post('/:id/delete', requireUser, wrap((req, res) => {
  svc.userDeleteOrder(req.userId, req.params.id);
  res.json({ code: 0, message: '订单已删除' });
}));

module.exports = router;
