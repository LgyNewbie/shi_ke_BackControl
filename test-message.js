const db = require('./db/init');


// =========================
// 1. 创建测试用户
// =========================

let user = db.prepare(`
  SELECT id
  FROM users
  WHERE dev_account = ?
`).get('test_message_user');


if (!user) {

  const result = db.prepare(`
    INSERT INTO users (
      dev_account,
      nickname
    )
    VALUES (?, ?)
  `).run(
    'test_message_user',
    '测试食客'
  );

  user = {
    id: Number(result.lastInsertRowid)
  };

  console.log('已创建测试用户，ID：', user.id);

} else {

  console.log('测试用户已存在，ID：', user.id);

}


// =========================
// 2. 创建测试留言
// =========================

const result = db.prepare(`
  INSERT INTO messages (
    user_id,
    content,
    images,
    status
  )
  VALUES (?, ?, ?, ?)
`).run(
  user.id,
  '这是一条测试留言，建议餐厅可以增加一些新品菜品，希望以后能看到更多好吃的！',
  JSON.stringify([]),
  'normal'
);


const messageId =
  Number(result.lastInsertRowid);


console.log('测试留言创建成功！');
console.log('留言 ID：', messageId);


// =========================
// 3. 创建测试点赞
// =========================

db.prepare(`
  INSERT INTO message_likes (
    message_id,
    user_id
  )
  VALUES (?, ?)
`).run(
  messageId,
  user.id
);


// =========================
// 4. 创建测试评论
// =========================

db.prepare(`
  INSERT INTO message_comments (
    message_id,
    user_id,
    content,
    parent_id,
    is_admin
  )
  VALUES (?, ?, ?, ?, ?)
`).run(
  messageId,
  user.id,
  '支持这个建议！',
  null,
  0
);


console.log('测试点赞和评论创建成功！');
console.log('');
console.log('现在可以启动后端并进入留言管理页面测试。');