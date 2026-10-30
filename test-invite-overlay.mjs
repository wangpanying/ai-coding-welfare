import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { applyOverlay, extractCodes, syncInviteKeys, preparePrivateConfig } from './apply-invite-overlay.mjs';

const fixture = () => ({
  meta: { repoUrl: 'https://github.com/upstream/repo', pagesUrl: 'https://upstream.github.io/repo/' },
  sites: [
    { id: 'a', signupUrl: 'https://a.test/register?aff=SHARED', inviteCode: 'SHARED',
      credits: { signup: 10, invite: 20, dailyCheckin: 5 },
      highlights: ['邀请码 SHARED；https://a.test/register?aff=SHARED'],
      mirrors: [{ signupUrl: 'https://mirror.test/register?aff=SHARED' }] },
    { id: 'b', signupUrl: 'https://b.test/sign-up?ref=SHARED', credits: { invite: 10 } },
    { id: 'matrix', signupUrl: 'https://m.test/login?redirect=%2Fapp%2Fgrowth%3FinviteCode%3DMATRIX%26tab%3D1' },
    { id: 'raw', signupUrl: 'https://r.test/list/#/register?i=HASH&lang=zh' },
    { id: 'mirasim', signupUrl: 'https://s.test/r/REFERRAL' },
  ],
});
const locales = () => ({ 'en.json': { locale: 'en', sites: {
  a: { summary: 'A', registration: 'Enter SHARED; https://a.test/register?aff=SHARED', notes: 'Other policy' },
  b: { summary: 'B', registration: 'Use the invitation link.', notes: 'Other policy' },
} } });

test('相同的上游码按站点独立覆盖，主链接、备用链接、手填字段和译文一致', () => {
  const original = fixture();
  const result = applyOverlay(original, locales(), { a: 'MINE_A', b: 'MINE_B' });
  assert.equal(result.data.sites[0].signupUrl, 'https://a.test/register?aff=MINE_A');
  assert.equal(result.data.sites[0].inviteCode, 'MINE_A');
  assert.equal(result.data.sites[0].mirrors[0].signupUrl, 'https://mirror.test/register?aff=MINE_A');
  assert.equal(result.data.sites[1].signupUrl, 'https://b.test/sign-up?ref=MINE_B');
  assert.match(result.locales['en.json'].sites.a.registration, /Enter MINE_A/);
  assert.doesNotMatch(JSON.stringify(result), /SHARED/);
  assert.match(original.sites[0].signupUrl, /SHARED/);
});

test('空串、null、缺少配置和上游新增站点均不继承上游邀请码', () => {
  for (const config of [{ a: '' }, { a: null }, {}]) {
    const { data, locales: translated } = applyOverlay(fixture(), locales(), config);
    assert.equal(data.sites[0].signupUrl, 'https://a.test/register');
    assert.equal(data.sites[0].inviteCode, '');
    assert.equal(data.sites[0].credits.invite, null);
    assert.equal(data.sites[0].credits.signup, 10);
    assert.equal(data.sites[0].credits.dailyCheckin, 5);
    assert.equal(data.sites[1].signupUrl, 'https://b.test/sign-up');
    assert.match(translated['en.json'].sites.a.registration, /^No referral code/);
    assert.doesNotMatch(JSON.stringify({ data, translated }), /SHARED|MATRIX|HASH|REFERRAL/);
  }
});

test('支持 Matrix 编码 redirect、hash 注册路由和路径式邀请链接', () => {
  const { data } = applyOverlay(fixture(), {}, { matrix: 'MY_MATRIX', raw: 'MY_HASH', mirasim: 'MY_PATH' });
  const redirect = new URL(data.sites[2].signupUrl).searchParams.get('redirect');
  assert.equal(redirect, '/app/growth?inviteCode=MY_MATRIX&tab=1');
  assert.equal(data.sites[3].signupUrl, 'https://r.test/list/#/register?i=MY_HASH&lang=zh');
  assert.equal(data.sites[4].signupUrl, 'https://s.test/r/MY_PATH');
});

test('空邀请码删除邀请参数/路径，保留普通查询参数和注册入口', () => {
  const { data } = applyOverlay(fixture(), {}, {});
  assert.equal(new URL(data.sites[2].signupUrl).searchParams.get('redirect'), '/app/growth?tab=1');
  assert.equal(data.sites[3].signupUrl, 'https://r.test/list/#/register?lang=zh');
  assert.equal(data.sites[4].signupUrl, 'https://s.test/');
});

test('extract 保留所有站点，能读嵌套和路径中的码', () => {
  assert.deepEqual(extractCodes(fixture()), { a: 'SHARED', b: 'SHARED', matrix: 'MATRIX', raw: 'HASH', mirasim: 'REFERRAL' });
  assert.deepEqual(extractCodes({ sites: [{ id: 'empty', signupUrl: 'https://e.test/' }] }), { empty: '' });
});

test('新码等于另一个旧码时不发生连锁替换', () => {
  const data = fixture();
  data.sites[0].highlights.push('https://a.test/register?ref=OTHER，邀请码 OTHER');
  const result = applyOverlay(data, {}, { a: 'OTHER' });
  assert.match(result.data.sites[0].highlights[0], /邀请码 OTHER/);
  assert.match(result.data.sites[0].highlights[1], /ref=OTHER/);
});

test('连续运行幂等，上游后来改码仍使用我的独立配置', () => {
  const config = { a: 'MINE', b: '' };
  const first = applyOverlay(fixture(), locales(), config);
  assert.deepEqual(applyOverlay(first.data, first.locales, config), first);
  const updated = fixture();
  updated.sites[0].signupUrl = 'https://new.test/register?aff=NEW_UPSTREAM';
  updated.sites[0].inviteCode = 'NEW_UPSTREAM';
  const next = applyOverlay(updated, {}, config);
  assert.equal(next.data.sites[0].signupUrl, 'https://new.test/register?aff=MINE');
  assert.equal(config.a, 'MINE');
});

test('从配置设置本仓库地址，非法码类型在写文件前失败', () => {
  const result = applyOverlay(fixture(), {}, { repository: 'wangpanying/ai-coding-welfare', invites: {} });
  const repository = process.env.GITHUB_REPOSITORY || 'wangpanying/ai-coding-welfare';
  assert.equal(result.data.meta.repoUrl, `https://github.com/${repository}`);
  assert.ok(result.data.meta.pagesUrl.includes('.github.io/'));
  assert.throws(() => applyOverlay(fixture(), {}, { a: 123 }), /字符串/);
});

test('新增站点自动补空键，已有个人码、空串、null、已移除站点和元数据保持不变', () => {
  const config = { repository: 'owner/repo', invites: { a: 'MINE', b: '', raw: null, removed: 'KEEP' } };
  const completed = syncInviteKeys(config, fixture().sites);
  assert.deepEqual(completed, { repository: 'owner/repo', invites: {
    a: 'MINE', b: '', raw: null, removed: 'KEEP', matrix: '', mirasim: '',
  } });
  assert.deepEqual(config.invites, { a: 'MINE', b: '', raw: null, removed: 'KEEP' });
  assert.deepEqual(syncInviteKeys(completed, fixture().sites), completed);
});

test('兼容扁平邀请码配置，新增键不会提取上游邀请码', () => {
  assert.deepEqual(syncInviteKeys({ a: 'MINE' }, fixture().sites), {
    a: 'MINE', b: '', matrix: '', raw: '', mirasim: '',
  });
  assert.throws(() => syncInviteKeys({ invites: [] }, fixture().sites), /JSON 对象/);
});

test('CLI 写入产物并保存新增的空键，重复运行不改写已完整的配置文件', async () => {
  const root = await mkdtemp(join(tmpdir(), 'invite-overlay-'));
  await mkdir(join(root, 'data', 'locales'), { recursive: true });
  await writeFile(join(root, 'data', 'sites.json'), JSON.stringify(fixture()));
  await writeFile(join(root, 'data', 'locales', 'en.json'), JSON.stringify(locales()['en.json']));
  const configPath = join(root, 'invite-codes.json');
  const config = JSON.stringify({ repository: 'owner/repo', invites: { a: 'MY_CLI', b: '' } });
  await writeFile(configPath, config);
  execFileSync(process.execPath, [fileURLToPath(new URL('./apply-invite-overlay.mjs', import.meta.url)), 'apply', root, configPath]);
  const result = JSON.parse(await readFile(join(root, 'data', 'sites.json'), 'utf8'));
  assert.equal(result.sites[0].inviteCode, 'MY_CLI');
  assert.equal(result.sites[1].signupUrl, 'https://b.test/sign-up');
  assert.match(await readFile(join(root, 'data', 'locales', 'en.json'), 'utf8'), /MY_CLI/);
  const completedText = await readFile(configPath, 'utf8');
  assert.deepEqual(JSON.parse(completedText), { repository: 'owner/repo', invites: {
    a: 'MY_CLI', b: '', matrix: '', raw: '', mirasim: '',
  } });
  // 在已完整配置中使用不同缩进，确认无新增站点时连格式也不重写。
  const formatted = JSON.stringify(JSON.parse(completedText), null, 4) + '\n';
  await writeFile(configPath, formatted);
  execFileSync(process.execPath, [fileURLToPath(new URL('./apply-invite-overlay.mjs', import.meta.url)), 'apply', root, configPath]);
  assert.equal(await readFile(configPath, 'utf8'), formatted);
});

test('私有模式只在内存中合并邀请码，公开模板中的所有值始终为空', () => {
  const template = { repository: 'owner/repo', invites: { a: 'ACCIDENTAL_PUBLIC_CODE', removed: 'OLD' } };
  const secret = JSON.stringify({ repository: 'owner/repo', invites: { a: 'PRIVATE_A', b: 'PRIVATE_B', raw: null } });
  const prepared = preparePrivateConfig(template, secret, fixture().sites);
  assert.equal(prepared.config.invites.a, 'PRIVATE_A');
  assert.equal(prepared.config.invites.b, 'PRIVATE_B');
  assert.equal(prepared.config.invites.raw, null);
  assert.ok(Object.values(prepared.publicConfig.invites).every((value) => value === ''));
  assert.ok(Object.hasOwn(prepared.publicConfig.invites, 'matrix'));
  assert.ok(Object.hasOwn(prepared.publicConfig.invites, 'removed'));
  assert.doesNotMatch(JSON.stringify(prepared.publicConfig), /PRIVATE_A|PRIVATE_B|ACCIDENTAL_PUBLIC_CODE|OLD/);
  assert.equal(template.invites.a, 'ACCIDENTAL_PUBLIC_CODE');
});

test('Secret 未设置或为空时全按空码处理，不回退公开模板或上游邀请码', () => {
  for (const secret of [undefined, '', '  ']) {
    const prepared = preparePrivateConfig({ invites: { a: 'DO_NOT_USE' } }, secret, fixture().sites);
    const result = applyOverlay(fixture(), {}, prepared.config);
    assert.ok(Object.values(extractCodes(result.data)).every((code) => code === ''));
    assert.deepEqual(preparePrivateConfig(prepared.publicConfig, secret, fixture().sites), prepared);
  }
});

test('Secret 支持扁平 JSON，只替换已填写站点', () => {
  const prepared = preparePrivateConfig({ invites: {} }, '{"a":"PRIVATE_A"}', fixture().sites);
  const result = applyOverlay(fixture(), {}, prepared.config);
  assert.equal(result.data.sites[0].inviteCode, 'PRIVATE_A');
  assert.equal(extractCodes(result.data).b, '');
});

test('Secret 格式错误的提示不包含配置片段', () => {
  assert.throws(() => preparePrivateConfig({ invites: {} }, '{"PRIVATE_MARKER":"SECRET_FRAGMENT"', fixture().sites), (error) => {
    assert.match(error.message, /不是有效的 JSON/);
    assert.doesNotMatch(error.message, /PRIVATE_MARKER|SECRET_FRAGMENT/);
    return true;
  });
  for (const raw of ['null', '[]', '"SECRET_FRAGMENT"', '{"invites":[]}']) {
    assert.throws(() => preparePrivateConfig({ invites: {} }, raw, fixture().sites), /JSON 对象/);
  }
});

test('CLI 私有模式保存空值模板和公开产物，不生成个人配置文件或输出真实码', async () => {
  const root = await mkdtemp(join(tmpdir(), 'invite-private-'));
  await mkdir(join(root, 'data'), { recursive: true });
  await writeFile(join(root, 'data', 'sites.json'), JSON.stringify(fixture()));
  const templatePath = join(root, 'invite-codes.example.json');
  await writeFile(templatePath, JSON.stringify({ repository: 'owner/repo', invites: { a: '' } }));
  const output = execFileSync(process.execPath, [fileURLToPath(new URL('./apply-invite-overlay.mjs', import.meta.url)),
    'apply-private', root, templatePath], {
    encoding: 'utf8', env: { ...process.env, INVITE_CODES_JSON: '{"invites":{"a":"PRIVATE_CLI"}}' },
  });
  assert.doesNotMatch(output, /PRIVATE_CLI/);
  const result = JSON.parse(await readFile(join(root, 'data', 'sites.json'), 'utf8'));
  assert.equal(result.sites[0].inviteCode, 'PRIVATE_CLI');
  const saved = JSON.parse(await readFile(templatePath, 'utf8'));
  assert.deepEqual(saved.invites, { a: '', b: '', matrix: '', raw: '', mirasim: '' });
  await assert.rejects(readFile(join(root, 'invite-codes.json')), { code: 'ENOENT' });
});

test('CLI 遇到非法 Secret 时不改写模板或站点文件，错误日志不泄漏内容', async () => {
  const root = await mkdtemp(join(tmpdir(), 'invite-invalid-'));
  await mkdir(join(root, 'data'), { recursive: true });
  const sitesPath = join(root, 'data', 'sites.json');
  const templatePath = join(root, 'invite-codes.example.json');
  const sites = JSON.stringify(fixture());
  const template = '{"invites":{}}';
  await writeFile(sitesPath, sites);
  await writeFile(templatePath, template);
  assert.throws(() => execFileSync(process.execPath, [fileURLToPath(new URL('./apply-invite-overlay.mjs', import.meta.url)),
    'apply-private', root, templatePath], {
    stdio: 'pipe', env: { ...process.env, INVITE_CODES_JSON: '{"SECRET_FRAGMENT"' },
  }), (error) => {
    assert.doesNotMatch(String(error.stderr), /SECRET_FRAGMENT/);
    assert.match(String(error.stderr), /不是有效的 JSON/);
    return true;
  });
  assert.equal(await readFile(sitesPath, 'utf8'), sites);
  assert.equal(await readFile(templatePath, 'utf8'), template);
});
