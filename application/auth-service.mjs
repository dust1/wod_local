import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const USERNAME_PATTERN = /^[\p{L}\p{N}_-]{3,24}$/u;

export function validateCredentials(username, password) {
  const normalized = String(username ?? "").trim();
  if (!USERNAME_PATTERN.test(normalized)) throw new Error("用户名须为 3–24 位文字、数字、下划线或连字符");
  if (String(password ?? "").length < 8 || String(password).length > 72) throw new Error("密码须为 8–72 位");
  return { username: normalized, password: String(password) };
}

export function hashPassword(password, salt = randomBytes(16).toString("hex")) {
  return { salt, hash: scryptSync(password, salt, 64).toString("hex") };
}

export function verifyPassword(password, salt, expectedHex) {
  const actual = scryptSync(password, salt, 64);
  const expected = Buffer.from(expectedHex, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function newSession() {
  return { id: randomBytes(32).toString("hex"), expiresAt: new Date(Date.now() + 7 * 864e5).toISOString() };
}

export function validateHeroInput(input) {
  const name = String(input.name ?? "").trim();
  if (name.length < 2 || name.length > 24) throw new Error("角色名称须为 2–24 个字符");
  if (!["male", "female"].includes(input.gender)) throw new Error("请选择角色性别");
  if (!input.raceId || !input.professionId) throw new Error("请选择种族和初始职业");
  return { name, gender: input.gender, raceId: String(input.raceId), professionId: String(input.professionId) };
}
