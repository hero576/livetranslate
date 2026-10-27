import mysql from "mysql2/promise";
import crypto from "node:crypto";

/* ------------------------------------------------------------------ *
 * MySQL（MariaDB 兼容）存储层
 * 通过环境变量注入连接信息；建表幂等。
 * ------------------------------------------------------------------ */

const pool = mysql.createPool({
  host: process.env.DB_HOST || "127.0.0.1",
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "livetranslate",
  waitForConnections: true,
  connectionLimit: 10,
  charset: "utf8mb4",
  timezone: "Z",
});

const uid = () => crypto.randomBytes(8).toString("hex");
const now = () => Date.now();

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id VARCHAR(16) PRIMARY KEY,
      username VARCHAR(64) NOT NULL UNIQUE,
      pass_hash VARCHAR(128) NOT NULL,
      salt VARCHAR(32) NOT NULL,
      role VARCHAR(16) NOT NULL DEFAULT 'user',
      status VARCHAR(16) NOT NULL DEFAULT 'pending',
      created_at BIGINT NOT NULL,
      last_login_at BIGINT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS conversations (
      id VARCHAR(16) PRIMARY KEY,
      user_id VARCHAR(16) NOT NULL,
      title VARCHAR(120) NOT NULL,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      INDEX idx_conv_user (user_id, updated_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id VARCHAR(16) PRIMARY KEY,
      conv_id VARCHAR(16) NOT NULL,
      user_id VARCHAR(16) NOT NULL,
      src TEXT NOT NULL,
      tgt TEXT NOT NULL,
      from_lang VARCHAR(32) NULL,
      to_lang VARCHAR(32) NULL,
      engine VARCHAR(32) NULL,
      created_at BIGINT NOT NULL,
      INDEX idx_msg_conv (conv_id, created_at),
      INDEX idx_msg_user (user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}

/* ---------------------------- 用户 ---------------------------- */
function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString("hex");
}

async function getUserByUsername(username) {
  const [rows] = await pool.query("SELECT * FROM users WHERE username = ?", [String(username).trim()]);
  return rows[0] ? rowToUser(rows[0]) : null;
}

async function getUserById(id) {
  const [rows] = await pool.query("SELECT * FROM users WHERE id = ?", [id]);
  return rows[0] ? rowToUser(rows[0]) : null;
}

function rowToUser(r) {
  return {
    id: r.id,
    username: r.username,
    passHash: r.pass_hash,
    salt: r.salt,
    role: r.role,
    status: r.status,
    createdAt: Number(r.created_at),
    lastLoginAt: r.last_login_at == null ? null : Number(r.last_login_at),
  };
}

function verifyPassword(user, password) {
  const h = hashPassword(password, user.salt);
  return crypto.timingSafeEqual(Buffer.from(h, "hex"), Buffer.from(user.passHash, "hex"));
}

async function createUser(username, password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const user = {
    id: uid(),
    username: String(username).trim(),
    passHash: hashPassword(password, salt),
    salt,
    role: "user",
    status: "pending",
    createdAt: now(),
  };
  await pool.query(
    "INSERT INTO users (id, username, pass_hash, salt, role, status, created_at) VALUES (?,?,?,?,?,?,?)",
    [user.id, user.username, user.passHash, user.salt, user.role, user.status, user.createdAt]
  );
  return user;
}

async function listUsers() {
  const [rows] = await pool.query(
    "SELECT id, username, role, status, created_at, last_login_at FROM users ORDER BY created_at DESC"
  );
  return rows.map((r) => ({
    id: r.id,
    username: r.username,
    role: r.role,
    status: r.status,
    createdAt: Number(r.created_at),
    lastLoginAt: r.last_login_at == null ? null : Number(r.last_login_at),
  }));
}

async function setUserStatus(id, status) {
  await pool.query("UPDATE users SET status = ? WHERE id = ?", [status, id]);
  return getUserById(id);
}

async function touchLogin(id) {
  await pool.query("UPDATE users SET last_login_at = ? WHERE id = ?", [now(), id]);
}

async function updatePassword(id, newPassword) {
  const salt = crypto.randomBytes(16).toString("hex");
  const passHash = hashPassword(newPassword, salt);
  await pool.query("UPDATE users SET pass_hash = ?, salt = ? WHERE id = ?", [passHash, salt, id]);
  return true;
}

/* ---------------------------- 会话 ---------------------------- */
async function listConversations(userId) {
  const [rows] = await pool.query(
    `SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.conv_id = c.id) AS msg_count
     FROM conversations c WHERE c.user_id = ? ORDER BY c.updated_at DESC`,
    [userId]
  );
  return rows.map((r) => ({
    id: r.id,
    userId: r.user_id,
    title: r.title,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    msgCount: Number(r.msg_count),
  }));
}

async function getConversation(id) {
  const [rows] = await pool.query("SELECT * FROM conversations WHERE id = ?", [id]);
  if (!rows[0]) return null;
  return {
    id: rows[0].id,
    userId: rows[0].user_id,
    title: rows[0].title,
    createdAt: Number(rows[0].created_at),
    updatedAt: Number(rows[0].updated_at),
  };
}

async function createConversation(userId, title) {
  const [r] = await pool.query("SELECT COUNT(*) AS c FROM conversations WHERE user_id = ?", [userId]);
  const conv = {
    id: uid(),
    userId,
    title: title || `对话${Number(r[0].c) + 1}`,
    createdAt: now(),
    updatedAt: now(),
  };
  await pool.query(
    "INSERT INTO conversations (id, user_id, title, created_at, updated_at) VALUES (?,?,?,?,?)",
    [conv.id, conv.userId, conv.title, conv.createdAt, conv.updatedAt]
  );
  return conv;
}

async function renameConversation(id, userId, title) {
  const t = String(title).trim().slice(0, 120);
  const [r] = await pool.query(
    "UPDATE conversations SET title = ?, updated_at = ? WHERE id = ? AND user_id = ?",
    [t, now(), id, userId]
  );
  return r.affectedRows ? getConversation(id) : null;
}

async function deleteConversation(id, userId) {
  const [r] = await pool.query("DELETE FROM conversations WHERE id = ? AND user_id = ?", [id, userId]);
  if (!r.affectedRows) return false;
  await pool.query("DELETE FROM messages WHERE conv_id = ?", [id]);
  return true;
}

async function listMessages(convId, userId) {
  const c = await getConversation(convId);
  if (!c || c.userId !== userId) return null;
  const [rows] = await pool.query(
    "SELECT * FROM messages WHERE conv_id = ? ORDER BY created_at ASC",
    [convId]
  );
  return rows.map((r) => ({
    id: r.id,
    convId: r.conv_id,
    userId: r.user_id,
    src: r.src,
    tgt: r.tgt,
    fromLang: r.from_lang,
    toLang: r.to_lang,
    engine: r.engine,
    createdAt: Number(r.created_at),
  }));
}

async function addMessage({ convId, userId, src, tgt, fromLang, toLang, engine }) {
  const msg = {
    id: uid(),
    convId,
    userId,
    src,
    tgt,
    fromLang: fromLang || null,
    toLang: toLang || null,
    engine: engine || null,
    createdAt: now(),
  };
  await pool.query(
    "INSERT INTO messages (id, conv_id, user_id, src, tgt, from_lang, to_lang, engine, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
    [msg.id, msg.convId, msg.userId, msg.src, msg.tgt, msg.fromLang, msg.toLang, msg.engine, msg.createdAt]
  );
  await pool.query("UPDATE conversations SET updated_at = ? WHERE id = ?", [msg.createdAt, convId]);
  return msg;
}

async function updateMessage(id, userId, { src, tgt, fromLang, toLang, engine }) {
  const [r] = await pool.query(
    "UPDATE messages SET src=?, tgt=?, from_lang=?, to_lang=?, engine=? WHERE id=? AND user_id=?",
    [src, tgt, fromLang || null, toLang || null, engine || null, id, userId]
  );
  return r.affectedRows > 0;
}

/* ---------------------------- 统计（管理员） ---------------------------- */
async function stats() {
  const [[u]] = await pool.query("SELECT COUNT(*) AS c FROM users");
  const [[a]] = await pool.query("SELECT COUNT(*) AS c FROM users WHERE status='active'");
  const [[p]] = await pool.query("SELECT COUNT(*) AS c FROM users WHERE status='pending'");
  const [[c]] = await pool.query("SELECT COUNT(*) AS c FROM conversations");
  const [[m]] = await pool.query("SELECT COUNT(*) AS c FROM messages");
  const [byUser] = await pool.query("SELECT user_id, COUNT(*) AS c FROM messages GROUP BY user_id");
  const messagesByUser = {};
  byUser.forEach((r) => (messagesByUser[r.user_id] = Number(r.c)));
  return {
    totalUsers: Number(u.c),
    activeUsers: Number(a.c),
    pendingUsers: Number(p.c),
    totalConversations: Number(c.c),
    totalMessages: Number(m.c),
    messagesByUser,
  };
}

async function usage(userId) {
  const [[c]] = await pool.query("SELECT COUNT(*) AS c FROM conversations WHERE user_id = ?", [userId]);
  const [[m]] = await pool.query("SELECT COUNT(*) AS c FROM messages WHERE user_id = ?", [userId]);
  return { userId, conversations: Number(c.c), messages: Number(m.c) };
}

async function getMessagesByConv(convId) {
  const [rows] = await pool.query(
    "SELECT * FROM messages WHERE conv_id = ? ORDER BY created_at ASC",
    [convId]
  );
  return rows.map((r) => ({
    id: r.id,
    convId: r.conv_id,
    userId: r.user_id,
    src: r.src,
    tgt: r.tgt,
    fromLang: r.from_lang,
    toLang: r.to_lang,
    engine: r.engine,
    createdAt: Number(r.created_at),
  }));
}

export {
  pool,
  init,
  uid,
  now,
  hashPassword,
  getUserByUsername,
  getUserById,
  verifyPassword,
  createUser,
  listUsers,
  setUserStatus,
  touchLogin,
  updatePassword,
  listConversations,
  getConversation,
  createConversation,
  renameConversation,
  deleteConversation,
  listMessages,
  addMessage,
  updateMessage,
  stats,
  usage,
  getMessagesByConv,
};
