// 图片地址处理：库里可能存着旧的绝对地址（带局域网 IP，换网络就失效），
// 统一在输出时把 "/uploads/..." 之前的主机部分换成当前服务器地址（或 .env 里的 PUBLIC_BASE_URL）。

function baseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/+$/, '');
  return `${req.protocol}://${req.get('host')}`;
}

function fixImage(req, url) {
  if (!url) return '';
  const s = String(url);
  if (s.startsWith('/uploads/')) return baseUrl(req) + s;
  return s.replace(/^https?:\/\/[^/]+(?=\/uploads\/)/, baseUrl(req));
}

function fixImages(req, list) {
  return (Array.isArray(list) ? list : []).map(u => fixImage(req, u));
}

module.exports = { baseUrl, fixImage, fixImages };
