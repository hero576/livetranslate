/* ------------------------------------------------------------------ *
 * 管理员初始化 CLI（一次性）
 *
 *   node server/create-admin.js <username> <password>
 *     创建管理员；若用户已存在则幂等地提权为 admin/active（不重置密码）
 *
 *   node server/create-admin.js --must-change <username>
 *     强制指定用户下次登录修改密码（用于迁移旧默认账号等）
 *
 * 密码也可通过环境变量 ADMIN_PASSWORD 提供，避免进入 shell 历史：
 *   ADMIN_PASSWORD='xxx' node server/create-admin.js <username>
 * ------------------------------------------------------------------ */
import * as store from "./store.js";

const args = process.argv.slice(2);

function usage() {
  console.log("用法:");
  console.log("  node server/create-admin.js <username> <password>   创建/提权管理员");
  console.log("  node server/create-admin.js --must-change <username> 强制用户下次登录改密");
  process.exit(1);
}

async function main() {
  if (args[0] === "--must-change") {
    const username = args[1];
    if (!username) usage();
    await store.init();
    const u = await store.getUserByUsername(username);
    if (!u) {
      console.error(`用户 ${username} 不存在`);
      process.exit(1);
    }
    await store.flagMustChangePassword(u.id);
    console.log(`已标记 ${username}：下次登录需修改密码`);
    process.exit(0);
  }

  const username = (args[0] || "").trim();
  const password = args[1] || process.env.ADMIN_PASSWORD || "";
  if (!username) usage();
  if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(username)) {
    console.error("用户名需 3-32 位字母/数字/_./-");
    process.exit(1);
  }
  if (String(password).length < 8) {
    console.error("密码至少 8 位（通过第二个参数或环境变量 ADMIN_PASSWORD 提供）");
    process.exit(1);
  }

  await store.init();
  const existing = await store.getUserByUsername(username);
  if (existing) {
    await store.pool.query("UPDATE users SET role='admin', status='active' WHERE id=?", [existing.id]);
    console.log(`用户 ${username} 已存在，已提权为管理员（密码未变更）`);
  } else {
    await store.createUser(username, password, { role: "admin", status: "active", mustChangePwd: true });
    console.log(`已创建管理员 ${username}（首次登录需修改密码）`);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
