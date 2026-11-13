// GET /api/projects 项目清单（供券码关联选择 / 前台展示）
import { PROJECTS } from './_lib/data/projects.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Visitor-Id'
};

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, CORS)
  });
}

export function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export function onRequestGet() {
  return json({
    ok: true,
    total: PROJECTS.length,
    projects: PROJECTS.map(function (p) {
      return { key: p.key, title: p.title, short: p.short, file: p.file, builtin: !!p.builtin };
    })
  });
}
