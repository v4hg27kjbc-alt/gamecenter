/**
 * POST /api/temp-account
 *
 * 临时账户创建接口（维护期迁移引导）：
 *  1) 复用 sms-check 同款真实验证码校验：读取 SMS_KV `sms:code:<phone>`
 *     （sms-verify.js 写入），比对 code 且未过期，通过后一次性删除；
 *  2) 在 NEWS_KV `admin:temp-accounts:v1` 中登记临时账户 { phone, status:'pending', createdAt, verifiedAt }；
 *  3) 重复手机号（任意状态）返回 409 已有账户，不重复创建。
 *
 * Cloudflare Pages 配置：
 *  - KV 绑定：SMS_KV（验证码校验，与 sms-verify/sms-check 共用）、NEWS_KV（账户存储）
 *  - 可选环境变量：SMS_CODE_TTL(默认300，须与 sms-verify.js 一致)
 */
import {
  ok, fail, methodNotAllowed, readJsonBody, getClientIp, toInt, resolveCors, corsPreflight
} from './_lib/http.js';

const TEMP_KEY = 'admin:temp-accounts:v1';
const TEMP_CODE_TTL = 300;

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') return corsPreflight(request, env);
  if (request.method !== 'POST') return methodNotAllowed(['POST']);

  const cors = resolveCors(request, env);
  if (cors.hasOrigin && !cors.ok) {
    return fail('forbidden_origin', '请求来源不在白名单', 403, cors.headers);
  }

  const smsKv = env && env.SMS_KV;
  const newsKv = env && env.NEWS_KV;
  if (!smsKv || typeof smsKv.get !== 'function' || typeof smsKv.delete !== 'function') {
    return fail('not_configured', '短信服务未配置：缺少 SMS_KV KV 绑定', 503, cors.headers);
  }
  if (!newsKv || typeof newsKv.get !== 'function' || typeof newsKv.put !== 'function') {
    return fail('not_configured', '服务端未绑定 NEWS_KV，临时账户不可用', 503, cors.headers);
  }

  const parsed = await readJsonBody(request, 16 * 1024);
  if (!parsed.ok) return fail(parsed.error, parsed.message, parsed.status, cors.headers);
  const phone = String(parsed.data.phoneNumber || '').trim();
  const code = String(parsed.data.code || '').trim();
  if (!/^1[3-9]\d{9}$/.test(phone)) {
    return fail('bad_request', '手机号格式不正确', 400, cors.headers);
  }
  if (!/^\d{4,8}$/.test(code)) {
    return fail('bad_request', '验证码格式不正确', 400, cors.headers);
  }

  // ---- 防爆破限流：同 IP 10 分钟限 30 次（与 sms-check 一致） ----
  const now = Math.floor(Date.now() / 1000);
  const ipBucket = Math.floor(now / 600);
  const ip = getClientIp(request);
  const ipKey = 'sms:rl:temp:ip:' + ipBucket + ':' + ip;
  const checkLimit = 30;
  const ipCnt = toInt(await smsKv.get(ipKey).catch(function () { return null; }), 0);
  if (ipCnt >= checkLimit) {
    return fail('rate_limited', '尝试过于频繁，请稍后再试', 429, cors.headers);
  }
  await smsKv.put(ipKey, String(ipCnt + 1), { expirationTtl: 600 }).catch(function () {});

  // ---- 真实验证码校验（复用 sms-check 逻辑：同 key、同 TTL、一次性删除） ----
  const raw = await smsKv.get('sms:code:' + phone);
  if (!raw) {
    return fail('not_found', '验证码不存在或已过期，请重新获取', 400, cors.headers);
  }
  let rec = null;
  try { rec = JSON.parse(raw); } catch (e) { rec = null; }
  if (!rec || rec.phone !== phone || rec.code !== code) {
    return fail('bad_request', '验证码不正确', 400, cors.headers);
  }
  const ttl = Math.max(60, toInt(env.SMS_CODE_TTL, TEMP_CODE_TTL));
  if (now - toInt(rec.ts, 0) > ttl) {
    await smsKv.delete('sms:code:' + phone).catch(function () {});
    return fail('not_found', '验证码已过期，请重新获取', 400, cors.headers);
  }
  await smsKv.delete('sms:code:' + phone).catch(function () {});

  // ---- 读取临时账户表并查重 ----
  let accounts = [];
  try {
    const rawList = await newsKv.get(TEMP_KEY, 'json');
    accounts = Array.isArray(rawList) ? rawList : (rawList && Array.isArray(rawList.accounts) ? rawList.accounts : []);
  } catch (e) {
    accounts = [];
  }
  const exists = accounts.some(function (a) { return a && a.phone === phone; });
  if (exists) {
    return fail('already_exists', '该手机号已有临时账户，请勿重复创建', 409, cors.headers);
  }

  // ---- 创建临时账户（不落明文密码） ----
  const createdAt = new Date().toISOString();
  const item = {
    phone: phone,
    status: 'pending',
    createdAt: createdAt,
    verifiedAt: createdAt
  };
  accounts.push(item);
  try {
    await newsKv.put(TEMP_KEY, JSON.stringify({ accounts: accounts }));
  } catch (e) {
    return fail('kv_unavailable', '临时账户保存失败，请稍后重试', 503, cors.headers);
  }

  return ok({
    ok: true,
    tempAccount: {
      phoneMasked: maskPhone(phone),
      status: 'pending',
      createdAt: createdAt
    }
  }, cors.headers);
}

function maskPhone(phone) {
  return phone ? phone.slice(0, 3) + '****' + phone.slice(7) : '';
}
