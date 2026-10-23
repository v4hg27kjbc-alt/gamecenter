/**
 * POST /api/sms-verify
 *
 * 手机号验证码发送接口：
 *  1) 校验手机号（中国大陆 11 位）；
 *  2) 限流防刷：同手机号 60 秒限 1 条、同 IP 10 分钟限 5 条（计数存 SMS_KV，被拒请求不记账）；
 *  3) 本地生成 6 位数字验证码，写入 SMS_KV（key: sms:code:<phone>，默认 expirationTtl=300）；
 *  4) 直调阿里云 Dypnsapi（号码认证服务）SendSmsVerifyCode HTTP API 下发短信（RPC V1 HMAC-SHA1 签名）；
 *  5) AK/SK 仅从环境变量读取，严禁硬编码。
 *
 * Cloudflare Pages 配置：
 *  - KV 绑定：SMS_KV（发送验证码、限流计数共用）
 *  - 环境变量：ALIBABA_CLOUD_ACCESS_KEY_ID、ALIBABA_CLOUD_ACCESS_KEY_SECRET（必填）
 *  - 可选环境变量：SMS_PHONE_PER_MIN(默认1)、SMS_IP_PER_10MIN(默认5)、SMS_CODE_TTL(默认300)、
 *    SMS_SCHEME_NAME(默认"默认方案")、SMS_SIGN_NAME(默认"速通互联验证码")、SMS_TEMPLATE_CODE(默认"100001")
 */
import {
  ok, fail, methodNotAllowed, readJsonBody, getClientIp, toInt, resolveCors, corsPreflight
} from './_lib/http.js';

const SMS_ENDPOINT = 'https://dypnsapi.aliyuncs.com/';
const SMS_VERSION = '2017-05-25';
const SMS_ACTION = 'SendSmsVerifyCode';

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') return corsPreflight(request, env);
  if (request.method !== 'POST') return methodNotAllowed(['POST']);

  const cors = resolveCors(request, env);
  if (cors.hasOrigin && !cors.ok) {
    return fail('forbidden_origin', '请求来源不在白名单', 403, cors.headers);
  }

  const kv = env.SMS_KV;
  if (!kv || typeof kv.get !== 'function' || typeof kv.put !== 'function') {
    return fail('not_configured', '短信服务未配置：缺少 SMS_KV KV 绑定', 503, cors.headers);
  }
  const ak = String(env.ALIBABA_CLOUD_ACCESS_KEY_ID || '').trim();
  const sk = String(env.ALIBABA_CLOUD_ACCESS_KEY_SECRET || '').trim();
  if (!ak || !sk) {
    return fail('not_configured', '短信服务未配置：缺少阿里云 AK/SK 环境变量', 503, cors.headers);
  }

  const parsed = await readJsonBody(request, 16 * 1024);
  if (!parsed.ok) return fail(parsed.error, parsed.message, parsed.status, cors.headers);
  const phone = String(parsed.data.phoneNumber || '').trim();
  if (!/^1[3-9]\d{9}$/.test(phone)) {
    return fail('bad_request', '手机号格式不正确', 400, cors.headers);
  }

  // ---- 限流防刷（手机号 60s / IP 10min），先全查、全通过才记账 ----
  const now = Math.floor(Date.now() / 1000);
  const phoneBucket = Math.floor(now / 60);
  const ipBucket = Math.floor(now / 600);
  const ip = getClientIp(request);
  const phoneKey = 'sms:rl:phone:' + phoneBucket + ':' + phone;
  const ipKey = 'sms:rl:ip:' + ipBucket + ':' + ip;
  const phoneLimit = toInt(env.SMS_PHONE_PER_MIN, 1);
  const ipLimit = toInt(env.SMS_IP_PER_10MIN, 5);

  const [phoneCnt, ipCnt] = await Promise.all([
    kv.get(phoneKey).catch(function () { return null; }),
    kv.get(ipKey).catch(function () { return null; })
  ]);
  if (toInt(phoneCnt, 0) >= phoneLimit) {
    return fail('rate_limited', '该手机号发送过于频繁，请 60 秒后再试', 429, cors.headers);
  }
  if (toInt(ipCnt, 0) >= ipLimit) {
    return fail('rate_limited', '发送过于频繁，请稍后再试', 429, cors.headers);
  }

  // ---- 生成 6 位验证码并写入 KV（默认 300s 过期） ----
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const ttl = Math.max(60, toInt(env.SMS_CODE_TTL, 300));
  await kv.put('sms:code:' + phone, JSON.stringify({ code: code, phone: phone, ts: now }), { expirationTtl: ttl });

  // ---- 通过限流后记账 ----
  await Promise.all([
    kv.put(phoneKey, String(toInt(phoneCnt, 0) + 1), { expirationTtl: 120 }),
    kv.put(ipKey, String(toInt(ipCnt, 0) + 1), { expirationTtl: 600 })
  ]);

  // ---- 直调阿里云 Dypnsapi HTTP API ----
  const upstream = await sendSmsVerifyCode(ak, sk, phone, code, env);
  if (!upstream.ok) {
    return fail('upstream_error', '短信发送失败：' + upstream.message, 502, cors.headers);
  }

  return ok({ sent: true, phone: maskPhone(phone), expireIn: ttl, bizId: upstream.bizId || '' }, cors.headers);
}

function maskPhone(phone) {
  return phone ? phone.slice(0, 3) + '****' + phone.slice(7) : '';
}

/** 阿里云 RPC 签名要求的 URL 编码（RFC3986 风格） */
function percentEncode(s) {
  return encodeURIComponent(s)
    .replace(/\+/g, '%20')
    .replace(/\*/g, '%2A')
    .replace(/%7E/g, '~');
}

function buildCanonicalQuery(params) {
  return Object.keys(params)
    .sort()
    .map(function (k) { return percentEncode(k) + '=' + percentEncode(String(params[k])); })
    .join('&');
}

async function sendSmsVerifyCode(ak, sk, phone, code, env) {
  const schemeName = (env && env.SMS_SCHEME_NAME) || '默认方案';
  const signName = (env && env.SMS_SIGN_NAME) || '速通互联验证码';
  const templateCode = (env && env.SMS_TEMPLATE_CODE) || '100001';
  // 本地生成验证码作为模板变量渲染；min 字段与已跑通基线保持一致
  const templateParam = JSON.stringify({ code: code, min: '5' });

  const params = {
    AccessKeyId: ak,
    Action: SMS_ACTION,
    Format: 'JSON',
    PhoneNumber: phone,
    SchemeName: schemeName,
    SignatureMethod: 'HMAC-SHA1',
    SignatureNonce: String(Date.now()) + '-' + Math.random().toString(36).slice(2, 10),
    SignatureVersion: '1.0',
    SignName: signName,
    TemplateCode: templateCode,
    TemplateParam: templateParam,
    Timestamp: new Date().toISOString(),
    Version: SMS_VERSION
  };

  const canonical = buildCanonicalQuery(params);
  const stringToSign = 'GET&' + percentEncode('/') + '&' + percentEncode(canonical);
  const signature = await signHmacSha1(sk + '&', stringToSign);
  const url = SMS_ENDPOINT + '?' + canonical + '&Signature=' + percentEncode(signature);

  try {
    const controller = new AbortController();
    const timer = setTimeout(function () { controller.abort(); }, 10000);
    const res = await fetch(url, { method: 'GET', signal: controller.signal });
    clearTimeout(timer);
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch (e) { data = null; }
    if (res.ok && data && data.code === 'OK') {
      const bizId = data.model && data.model.bizId ? data.model.bizId : '';
      return { ok: true, bizId: bizId };
    }
    const msg = (data && (data.message || data.Message)) || text.slice(0, 120) || ('HTTP ' + res.status);
    return { ok: false, message: msg };
  } catch (err) {
    const aborted = err && (err.name === 'AbortError' || /abort/i.test(String(err.message || '')));
    return { ok: false, message: aborted ? '阿里云短信服务请求超时' : ((err && err.message) || '阿里云短信服务请求失败') };
  }
}

async function signHmacSha1(secret, message) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  const bytes = new Uint8Array(sig);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
