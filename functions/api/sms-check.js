/**
 * POST /api/sms-check
 *
 * 验证码校验接口：校验 phoneNumber + code 是否匹配且未过期（本地 SMS_KV 校验），
 * 校验通过后删除验证码（一次性使用）。
 *
 * Cloudflare Pages 配置：
 *  - KV 绑定：SMS_KV（与 sms-verify.js 共用）
 *  - 可选环境变量：SMS_CODE_TTL(默认300，须与 sms-verify.js 保持一致)、
 *    SMS_CHECK_IP_PER_10MIN(默认30，防爆破限流)
 */
import {
  ok, fail, methodNotAllowed, readJsonBody, getClientIp, toInt, resolveCors, corsPreflight
} from './_lib/http.js';

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') return corsPreflight(request, env);
  if (request.method !== 'POST') return methodNotAllowed(['POST']);

  const cors = resolveCors(request, env);
  if (cors.hasOrigin && !cors.ok) {
    return fail('forbidden_origin', '请求来源不在白名单', 403, cors.headers);
  }

  const kv = env.SMS_KV;
  if (!kv || typeof kv.get !== 'function' || typeof kv.delete !== 'function') {
    return fail('not_configured', '短信服务未配置：缺少 SMS_KV KV 绑定', 503, cors.headers);
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

  // ---- 防爆破限流：同 IP 10 分钟限 30 次 ----
  const now = Math.floor(Date.now() / 1000);
  const ipBucket = Math.floor(now / 600);
  const ip = getClientIp(request);
  const ipKey = 'sms:rl:check:ip:' + ipBucket + ':' + ip;
  const checkLimit = toInt(env.SMS_CHECK_IP_PER_10MIN, 30);

  const ipCnt = toInt(await kv.get(ipKey).catch(function () { return null; }), 0);
  if (ipCnt >= checkLimit) {
    return fail('rate_limited', '校验尝试过于频繁，请稍后再试', 429, cors.headers);
  }
  await kv.put(ipKey, String(ipCnt + 1), { expirationTtl: 600 }).catch(function () {});

  // ---- 读取并校验验证码 ----
  const raw = await kv.get('sms:code:' + phone);
  if (!raw) {
    return fail('not_found', '验证码不存在或已过期，请重新获取', 400, cors.headers);
  }
  let rec = null;
  try { rec = JSON.parse(raw); } catch (e) { rec = null; }
  if (!rec || rec.phone !== phone || rec.code !== code) {
    return fail('bad_request', '验证码不正确', 400, cors.headers);
  }
  const ttl = Math.max(60, toInt(env.SMS_CODE_TTL, 300));
  if (now - toInt(rec.ts, 0) > ttl) {
    await kv.delete('sms:code:' + phone).catch(function () {});
    return fail('not_found', '验证码已过期，请重新获取', 400, cors.headers);
  }

  // ---- 校验通过，一次性删除 ----
  await kv.delete('sms:code:' + phone).catch(function () {});
  return ok({ verified: true, phone: maskPhone(phone) }, cors.headers);
}

function maskPhone(phone) {
  return phone ? phone.slice(0, 3) + '****' + phone.slice(7) : '';
}
