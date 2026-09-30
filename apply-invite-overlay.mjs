#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

const CODE_URL_PATTERN = /[?&](?:aff|ref|inviteCode)=([^&"'\s]+)/;

function extractCodes(data) {
  const codes = {};
  for (const site of data.sites) {
    const urls = [site.signupUrl, ...(site.mirrors ?? []).map((m) => m.signupUrl)].filter(Boolean);
    for (const url of urls) {
      const match = url.match(CODE_URL_PATTERN);
      if (match?.[1]) {
        codes[site.id] = match[1];
        break;
      }
    }
    if (!codes[site.id] && site.inviteCode) {
      codes[site.id] = site.inviteCode;
    }
  }
  return codes;
}

const mode = process.argv[2];

if (mode === "extract") {
  const sitesPath = process.argv[3] ?? "data/sites.json";
  const data = JSON.parse(await readFile(sitesPath, "utf8"));
  const codes = extractCodes(data);
  console.log(JSON.stringify(codes, null, 2));
} else if (mode === "apply") {
  const targetRepo = process.argv[3];
  const codesPath = process.argv[4];
  if (!targetRepo || !codesPath) {
    console.error("用法: node apply-invite-overlay.mjs apply <仓库目录> <邀请码JSON文件>");
    process.exit(1);
  }

  const userCodes = JSON.parse(await readFile(codesPath, "utf8"));
  const sitesPath = resolve(targetRepo, "data/sites.json");
  const rawContent = await readFile(sitesPath, "utf8");
  const data = JSON.parse(rawContent);
  const siteIds = new Set(data.sites.map((s) => s.id));
  const unknown = Object.keys(userCodes).filter((id) => !siteIds.has(id));
  if (unknown.length) {
    console.warn(`跳过上游已移除的站点: ${unknown.join(", ")}`);
  }

  // Collect all old→new replacements by scanning the raw string for known URL patterns
  const allReplacements = new Map();
  for (const site of data.sites) {
    const userCode = userCodes[site.id];
    if (!userCode) continue;

    // Find all codes in this site's data via URL pattern
    const foundCodes = new Set();
    const scan = (value) => {
      if (typeof value === "string") {
        // Find all URL parameter matches
        const regex = /[?&](?:aff|ref|inviteCode)=([^&"'\s,，。;；)）\]]+)/g;
        let m;
        while ((m = regex.exec(value)) !== null) {
          if (m[1] !== userCode) foundCodes.add(m[1]);
        }
        // Also check standalone inviteCode field
      } else if (Array.isArray(value)) {
        value.forEach(scan);
      } else if (value && typeof value === "object") {
        for (const val of Object.values(value)) scan(val);
      }
    };
    scan(site);

    if (site.inviteCode && site.inviteCode !== userCode) {
      foundCodes.add(site.inviteCode);
    }

    for (const oldCode of foundCodes) {
      allReplacements.set(oldCode, userCode);
    }
  }

  if (allReplacements.size === 0) {
    console.log("没有需要替换的邀请码");
    process.exit(0);
  }

  // Global string replacement on raw content (catches everything)
  let newContent = rawContent;
  for (const [oldCode, newCode] of allReplacements) {
    newContent = newContent.split(oldCode).join(newCode);
  }
  await writeFile(sitesPath, newContent, "utf8");

  // Replace in locale files
  const localeDir = resolve(targetRepo, "data/locales");
  const localeFiles = await readdir(localeDir)
    .then((names) => names.filter((n) => n.endsWith(".json")))
    .catch(() => []);

  let changedFiles = 1;
  for (const localeFile of localeFiles) {
    const abs = resolve(targetRepo, "data/locales", localeFile);
    let content = await readFile(abs, "utf8");
    let changed = false;
    for (const [oldCode, newCode] of allReplacements) {
      if (content.includes(oldCode)) {
        content = content.split(oldCode).join(newCode);
        changed = true;
      }
    }
    if (changed) {
      await writeFile(abs, content, "utf8");
      changedFiles++;
    }
  }

  console.log(`已替换 ${allReplacements.size} 个邀请码，处理 ${changedFiles} 个文件`);
} else {
  console.error("用法: node apply-invite-overlay.mjs extract|apply ...");
  process.exit(1);
}
