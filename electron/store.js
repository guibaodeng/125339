'use strict';
/**
 * 本地持久化：token 缓存、记住的账号密码、状态文件
 *
 * 都用 safeStorage 加密（系统有钥匙环时）。没有可用钥匙环时退化成明文，
 * 日志里会明确标出来。
 */

const { app, safeStorage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { userDataDir, REMEMBER } = require('./config');

/** 登录成功后的 token 缓存（localStorage 之外再存一份，便于启动时快速判断） */
const SESSION_FILE = () => path.join(userDataDir, 'session.json');
/** 记住的账号密码 */
const CRED_FILE = () => path.join(userDataDir, 'credentials.json');

function saveCachedToken(token) {
  if (!token) return;
  try {
    const enc = safeStorage.isEncryptionAvailable();
    const payload = enc
      ? { enc: true, data: safeStorage.encryptString(token).toString('base64') }
      : { enc: false, token };
    fs.writeFileSync(SESSION_FILE(), JSON.stringify(payload), { mode: 0o600 });
    console.log('[token] 已缓存', enc ? '(safeStorage 加密)' : '(明文，系统无可用密钥环)');
  } catch (e) {
    console.log('[token] 缓存失败:', e.message);
  }
}

function readCachedToken() {
  try {
    const raw = JSON.parse(fs.readFileSync(SESSION_FILE(), 'utf8'));
    return raw.enc ? safeStorage.decryptString(Buffer.from(raw.data, 'base64')) : raw.token;
  } catch {
    return null;
  }
}

function dropCachedToken() {
  try { fs.unlinkSync(SESSION_FILE()); } catch { /* 本来就没有 */ }
}

function saveCredential(mobile, password) {
  if (!REMEMBER || !mobile || !password) return;
  try {
    const enc = safeStorage.isEncryptionAvailable();
    const payload = enc
      ? { enc: true, data: safeStorage.encryptString(JSON.stringify({ mobile, password })).toString('base64') }
      : { enc: false, mobile, password };
    fs.writeFileSync(CRED_FILE(), JSON.stringify(payload), { mode: 0o600 });
    console.log('[cred] 已记住账号',
      mobile.replace(/(\d{3})\d{4}(\d{4})/, '$1****$2'),
      enc ? '(safeStorage 加密)' : '(明文，系统无可用密钥环)');
  } catch (e) {
    console.log('[cred] 保存失败:', e.message);
  }
}

function readCredential() {
  try {
    const raw = JSON.parse(fs.readFileSync(CRED_FILE(), 'utf8'));
    if (raw.enc) return JSON.parse(safeStorage.decryptString(Buffer.from(raw.data, 'base64')));
    return { mobile: raw.mobile, password: raw.password };
  } catch {
    return null;
  }
}

function dropCredential() {
  try { fs.unlinkSync(CRED_FILE()); } catch { /* 本来就没有 */ }
}

/** 简单的键值状态文件（目前只用来记少量启动信息） */
function saveState(patch) {
  try {
    const file = path.join(app.getPath('userData'), 'state.json');
    let old = {};
    try { old = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* 首次运行 */ }
    fs.writeFileSync(file, JSON.stringify({ ...old, ...patch }));
  } catch { /* 写不了就算了 */ }
}

/** 读回状态文件 */
function readState() {
  try {
    return JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'state.json'), 'utf8')) || {};
  } catch {
    return {};
  }
}

module.exports = {
  readState,
  SESSION_FILE,
  CRED_FILE,
  saveCachedToken,
  readCachedToken,
  dropCachedToken,
  saveCredential,
  readCredential,
  dropCredential,
  saveState,
};
