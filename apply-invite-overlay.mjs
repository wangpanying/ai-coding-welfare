#!/usr/bin/env node
/** Fork 专用：读取独立配置，覆盖上游邀请码。未配置的站点清空邀请信息。 */
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const INVITE_KEYS = new Set(['aff', 'ref', 'inviteCode', 'invite_code', 'referralCode', 'i']);
const LINK_PATTERN = /https?:\/\/[^\s"'<>`，。；）\])]+/g;
const PATH_PATTERN = /\/(?:r|invite|ref)\/([^/]+)(?=\/|$)/;
const NOTICES = {
  'zh-CN': '本页尚未配置该站邀请码，注册链接不含邀请信息，邀请奖励不计入额度合计；下方邀请条件仅供参考。',
  en: 'No referral code is configured here. Registration links contain no referral code and referral bonuses are excluded from totals; referral conditions below are for reference.',
  hi: 'यहाँ रेफ़रल कोड नहीं भरा गया है। पंजीकरण लिंक में रेफ़रल कोड नहीं है और रेफ़रल बोनस कुल में शामिल नहीं है; नीचे की रेफ़रल शर्तें केवल जानकारी के लिए हैं।',
  'pt-BR': 'Nenhum código de indicação foi configurado aqui. Os links de cadastro não contêm indicação e os bônus de indicação não entram no total; as condições abaixo são apenas informativas.',
  ja: 'このページには招待コードが設定されていません。登録リンクに招待情報は含まれず、招待特典は合計に含めません。以下の招待条件は参考情報です。',
  de: 'Hier ist kein Einladungscode hinterlegt. Registrierungslinks enthalten keinen Code und Einladungsboni zählen nicht zur Summe; die folgenden Einladungsbedingungen dienen nur zur Information.',
};

/** 同时处理普通查询参数、Matrix 的编码 redirect、RawChat 的 hash 路由、Mirasim /r/ 路径。 */
function rewriteUrl(text, code, found = new Set(), depth = 0) {
  if (depth > 4) return text;
  let url;
  try { url = new URL(text, 'https://overlay.invalid'); } catch { return text; }
  let changed = false;
  for (const key of new Set(url.searchParams.keys())) {
    const values = url.searchParams.getAll(key);
    if (INVITE_KEYS.has(key)) {
      values.filter(Boolean).forEach((value) => found.add(value));
      if (code !== undefined) {
        if (code) url.searchParams.set(key, code);
        else url.searchParams.delete(key);
        changed = true;
      }
    } else {
      const next = values.map((value) => /^(?:https?:\/\/|\/)/.test(value)
        ? rewriteUrl(value, code, found, depth + 1) : value);
      if (next.some((value, i) => value !== values[i])) {
        url.searchParams.delete(key);
        next.forEach((value) => url.searchParams.append(key, value));
        changed = true;
      }
    }
  }
  const referralPath = url.pathname.match(PATH_PATTERN);
  if (referralPath) {
    found.add(decodeURIComponent(referralPath[1]));
    if (code !== undefined) {
      url.pathname = url.pathname.replace(PATH_PATTERN, (match) => code
        ? match.slice(0, match.length - referralPath[1].length) + encodeURIComponent(code) : '') || '/';
      changed = true;
    }
  }
  if (url.hash.startsWith('#/')) {
    const hash = rewriteUrl(url.hash.slice(1), code, found, depth + 1);
    if (hash !== url.hash.slice(1)) { url.hash = hash; changed = true; }
  }
  if (!changed) return text;
  return /^https?:\/\//.test(text) ? url.href : `${url.pathname}${url.search}${url.hash}`;
}

function siteCodes(site) {
  const found = new Set();
  for (const link of [site.signupUrl, ...(site.mirrors ?? []).map((m) => m.signupUrl)]) {
    if (link) rewriteUrl(link, undefined, found);
  }
  if (site.inviteCode) found.add(site.inviteCode);
  return found;
}

export function extractCodes(data) {
  return Object.fromEntries(data.sites.map((site) => [site.id, [...siteCodes(site)][0] ?? '']));
}

/** 新站点只补空码；已有配置（包括空串、null 和暂被上游移除的站点）原样保留。 */
export function syncInviteKeys(config, sites) {
  const invites = config?.invites ?? config;
  if (!invites || Array.isArray(invites) || typeof invites !== 'object') throw new Error('邀请码配置必须是 JSON 对象');
  const added = Object.fromEntries(sites
    .filter((site) => !Object.hasOwn(invites, site.id))
    .map((site) => [site.id, '']));
  const completed = { ...invites, ...added };
  return config.invites != null ? { ...config, invites: completed } : completed;
}

/** 公开模板只补空键，真实邀请码仅在内存中与模板合并。 */
export function preparePrivateConfig(template, privateJson, sites) {
  const completed = syncInviteKeys(template, sites);
  const invites = completed.invites ?? completed;
  const emptyInvites = Object.fromEntries(Object.keys(invites).map((id) => [id, '']));
  const publicConfig = completed.invites != null ? { ...completed, invites: emptyInvites } : emptyInvites;
  let privateConfig = {};
  if (privateJson?.trim()) {
    try { privateConfig = JSON.parse(privateJson); } catch {
      // JSON.parse 的原始错误可能包含配置片段，不写入 Actions 日志。
      throw new Error('INVITE_CODES_JSON 不是有效的 JSON，请检查仓库 Secret。');
    }
    if (!privateConfig || Array.isArray(privateConfig) || typeof privateConfig !== 'object') {
      throw new Error('INVITE_CODES_JSON 必须是 JSON 对象。');
    }
  }
  const privateInvites = privateConfig.invites ?? privateConfig;
  if (!privateInvites || Array.isArray(privateInvites) || typeof privateInvites !== 'object') {
    throw new Error('INVITE_CODES_JSON 中的 invites 必须是 JSON 对象。');
  }
  return {
    publicConfig,
    config: {
      repository: privateConfig.repository ?? completed.repository,
      invites: { ...emptyInvites, ...privateInvites },
    },
  };
}

function mapStrings(value, transform) {
  if (typeof value === 'string') return transform(value);
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, transform));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapStrings(item, transform)]));
  }
  return value;
}

function replaceSiteText(value, originals, code) {
  // 按站点替换且一次完成，避免不同站共用旧码、或新码恰好等于另一个旧码时串改。
  const escaped = [...originals].filter(Boolean).sort((a, b) => b.length - a.length)
    .map((old) => old.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const tokens = escaped.length ? new RegExp(`(?<![\\p{L}\\p{N}_-])(?:${escaped.join('|')})(?![\\p{L}\\p{N}_-])`, 'gu') : null;
  return mapStrings(value, (text) => {
    // 先替换普通说明文字，再重写完整 URL；避免新码再次被当作旧码替换。
    const chunks = text.split(new RegExp(`(${LINK_PATTERN.source})`, 'g'));
    return chunks.map((chunk, i) => i % 2
      ? rewriteUrl(chunk, code)
      : tokens ? chunk.replace(tokens, () => code) : chunk).join('');
  });
}

export function applyOverlay(input, inputLocales, config) {
  const invites = config.invites ?? config; // 保留旧版 extract 输出的扁平 JSON 用法。
  if (!invites || Array.isArray(invites) || typeof invites !== 'object') throw new Error('邀请码配置必须是 JSON 对象');
  for (const [id, code] of Object.entries(invites)) {
    if (code != null && typeof code !== 'string') throw new Error(`${id} 的邀请码必须是字符串或 null`);
  }
  const data = structuredClone(input);
  const locales = structuredClone(inputLocales);
  const siteIds = new Set(data.sites.map((site) => site.id));
  const unknown = Object.keys(invites).filter((id) => !siteIds.has(id));
  if (unknown.length) console.warn(`配置保留了上游暂未收录的站点：${unknown.join('、')}`);

  data.sites = data.sites.map((site) => {
    const code = (Object.hasOwn(invites, site.id) ? invites[site.id] ?? '' : '').trim();
    const originals = siteCodes(site);
    const next = replaceSiteText(site, originals, code);
    if (Object.hasOwn(site, 'inviteCode')) next.inviteCode = code;
    if (!code) {
      const notice = NOTICES['zh-CN'];
      if (next.credits) {
        next.credits.invite = null;
        next.credits.note ||= '未配置邀请码';
      }
      next.highlights = [notice, ...(next.highlights ?? []).filter((text) => text !== notice)];
    }
    for (const catalog of Object.values(locales)) {
      if (!catalog.sites?.[site.id]) continue;
      catalog.sites[site.id] = replaceSiteText(catalog.sites[site.id], originals, code);
      if (!code) {
        const notice = NOTICES[catalog.locale] ?? NOTICES.en;
        const item = catalog.sites[site.id];
        if (!item.registration.startsWith(notice)) item.registration = `${notice} ${item.registration}`;
      }
    }
    return next;
  });

  const repository = process.env.GITHUB_REPOSITORY || config.repository;
  if (repository) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('repository 必须为 owner/repo');
    const [owner, name] = repository.split('/');
    data.meta.repoUrl = `https://github.com/${repository}`;
    data.meta.pagesUrl = `https://${owner}.github.io/${name.toLowerCase() === `${owner.toLowerCase()}.github.io` ? '' : `${name}/`}`;
  }
  return { data, locales };
}

async function main() {
  const [mode, target, configFile] = process.argv.slice(2);
  if (mode === 'extract') {
    console.log(JSON.stringify(extractCodes(JSON.parse(await readFile(target ?? 'data/sites.json', 'utf8'))), null, 2));
    return;
  }
  if (!['apply', 'apply-private'].includes(mode) || !target || !configFile) {
    throw new Error('用法：node apply-invite-overlay.mjs extract [sites.json] | apply <仓库目录> <私有配置JSON> | apply-private <仓库目录> <公开模板JSON>');
  }
  const sitesPath = resolve(target, 'data/sites.json');
  const localeDir = resolve(target, 'data/locales');
  const config = JSON.parse(await readFile(configFile, 'utf8'));
  const data = JSON.parse(await readFile(sitesPath, 'utf8'));
  let files;
  try { files = await readdir(localeDir); } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    files = [];
  }
  const locales = {};
  for (const file of files.filter((file) => file.endsWith('.json'))) {
    locales[file] = JSON.parse(await readFile(resolve(localeDir, file), 'utf8'));
  }
  const prepared = mode === 'apply-private'
    ? preparePrivateConfig(config, process.env.INVITE_CODES_JSON, data.sites) : null;
  const completedConfig = prepared?.publicConfig ?? syncInviteKeys(config, data.sites);
  const result = applyOverlay(data, locales, prepared?.config ?? completedConfig);
  await writeFile(sitesPath, JSON.stringify(result.data, null, 2) + '\n');
  for (const [file, catalog] of Object.entries(result.locales)) {
    await writeFile(resolve(localeDir, file), JSON.stringify(catalog, null, 2) + '\n');
  }
  if (JSON.stringify(completedConfig) !== JSON.stringify(config)) {
    await writeFile(configFile, JSON.stringify(completedConfig, null, 2) + '\n');
    console.log('已将上游新增站点的 ID 补入邀请码配置，初始值为空。');
  }
  console.log(`已覆盖 ${result.data.sites.length} 个站点；未配置的邀请码已清空。`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error(err.message); process.exitCode = 1; });
}
