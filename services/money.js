// 金额工具：数据库统一存「分」（整数），对外接口/后台页面/小程序统一用「元」
//
//   fenToYuan(1234)   -> 12.34   （数字，最多 2 位小数）
//   yuanToFen(12.34)  -> 1234    （整数；非法输入返回 NaN，由调用方决定如何报错）
//
// 约定：后端所有 API 的金额字段，入参、出参都是「元」。
// 只有直接操作数据库时才会看到「分」。

function fenToYuan(fen) {
  const n = Number(fen);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n) / 100;
}

function yuanToFen(yuan) {
  if (yuan === '' || yuan === null || yuan === undefined) return NaN;
  const n = Number(yuan);
  if (!Number.isFinite(n)) return NaN;
  // 先放大再四舍五入，避免 1.005*100 = 100.49999 这类浮点误差
  return Math.round(Number((n * 100).toFixed(4)));
}

// 允许为空（空 = 0）的金额入参
function yuanToFenOrZero(yuan) {
  if (yuan === '' || yuan === null || yuan === undefined) return 0;
  return yuanToFen(yuan);
}

module.exports = { fenToYuan, yuanToFen, yuanToFenOrZero };
