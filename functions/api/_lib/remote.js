/**
 * 主站 → 后台数据同源回退（v5.5）
 *
 * 背景：主站与后台分属两个 Pages 项目，NEWS_KV 绑定可能不是同一个命名空间。
 * 若主站本地 KV 无数据，则服务端回退读取后台同名公开接口，保证「后台改一条，
 * 主站立即生效」不依赖 KV 是否同库。
 *
 * 约定：
 *   - 仅读取公开 GET（只含 enabled 条目），不做任何写操作；
 *   - 超时 1800ms，失败静默降级为 builtin，不阻断首屏；
 *   - 结果统一 Cache-Control: no-store 由调用方保证。
 */

const DEFAULT_ORIGIN = 'https://henry126923-admincenter.pages.dev';
const ALLOWED = ['banners', 'ads', 'notices', 'products'];

function originOf(env) {
  const raw = env && env.SITE_REMOTE_ORIGIN ? String(env.SITE_REMOTE_ORIGIN) : '';
  const o = raw || DEFAULT_ORIGIN;
  return /^https:\/\/[a-z0-9.-]+$/i.test(o) ? o : DEFAULT_ORIGIN;
}

/**
 * 拉取后台同源数据。
 * @returns {Promise<Array|null>} 成功返回 items 数组，失败返回 null
 */
export async function remoteItems(env, kind) {
  if (!ALLOWED.includes(kind)) return null;
  const url = originOf(env) + '/api/' + kind;
  try {
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), 1800) : null;
    const resp = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json', 'X-GC-Remote': '1' },
      signal: ctl ? ctl.signal : undefined,
      cf: { cacheTtl: 0, cacheEverything: false }
    });
    if (timer) clearTimeout(timer);
    if (!resp || !resp.ok) return null;
    const data = await resp.json();
    const items = data && Array.isArray(data.items) ? data.items : null;
    return items && items.length ? items : null;
  } catch (e) {
    return null;
  }
}

export const REMOTE_ORIGIN_DEFAULT = DEFAULT_ORIGIN;
