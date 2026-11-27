/**
 * 商品上下架守卫（v5.5）
 *
 * 数据源优先级：主站 KV site:products:v1 → 后台 /api/products → 无（放行）。
 * 约定：拿不到数据时一律放行（fail-open），避免存储故障导致全站不可读。
 */

import { remoteItems } from './remote.js';

const KV_KEY = 'site:products:v1';

/** 项目键归一化：b737 / 737 / B737 → 737 */
export function normProductId(raw) {
  const s = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!s) return '';
  const m = s.match(/(b?7[0-9]{2}|c[0-9]{3}|a[0-9]{3}[a-z0-9-]*)/);
  const hit = m ? m[1] : s;
  return hit.replace(/^b(?=[0-9])/, '');
}

async function readProducts(env) {
  let items = null;
  try {
    if (env && env.NEWS_KV) {
      const store = await env.NEWS_KV.get(KV_KEY, { type: 'json' });
      if (store) {
        const arr = Array.isArray(store) ? store : (Array.isArray(store.items) ? store.items : null);
        if (arr && arr.length) items = arr;
      }
    }
  } catch (e) { /* 忽略，走远程 */ }
  if (!items) {
    const remote = await remoteItems(env, 'products');
    if (remote) items = remote;
  }
  return items;
}

/**
 * 判断某项目是否已下架。
 * @returns {Promise<{offline:boolean, known:boolean, product:object|null}>}
 */
export async function productGate(env, projectKey) {
  const id = normProductId(projectKey);
  const items = await readProducts(env);
  if (!items || !items.length) return { offline: false, known: false, product: null };
  const all = items.filter(function (p) { return p && normProductId(p.id) === id; });
  // 清单里根本没有这件商品（未登记/未上架过）→ 视为未知，放行，避免误杀新项目
  if (!all.length) return { offline: false, known: false, product: null };
  // 登记过但全部 enabled=false → 已下架
  const hit = all.filter(function (p) { return p.enabled !== false; })[0] || null;
  return { offline: !hit, known: true, product: hit };
}

export const PRODUCT_OFFLINE_MESSAGE = '目前已下架，无法进行操作';
