"use strict";

// Only this plugin's data directory. Never read the host SecretStore.
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const MAX_BYTES = 256 * 1024;
const AAD = Buffer.from("subscription-quota/oauth/v1");

function storageError() {
  return Object.assign(new Error("无法读取或保存插件授权，请检查插件数据目录权限；不要删除宿主密钥库"), { code: "AUTH_STORAGE" });
}

function createAuthStore(getDataPath) {
  let location;
  async function paths() {
    if (!location) {
      const root = await getDataPath();
      if (typeof root !== "string" || !path.isAbsolute(root)) throw storageError();
      location = { root, key: path.join(root, "quota-oauth.key"), data: path.join(root, "quota-oauth.enc") };
    }
    return location;
  }
  async function read(file, max) {
    try {
      const info = await fs.lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > max) throw storageError();
      return await fs.readFile(file);
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw storageError();
    }
  }
  async function keyFor(p, create) {
    let key = await read(p.key, 32);
    if (!key && create) {
      key = crypto.randomBytes(32);
      try {
        await fs.writeFile(p.key, key, { flag: "wx", mode: 0o600 });
      } catch (error) {
        if (error.code !== "EEXIST") throw storageError();
        key = await read(p.key, 32);
      }
    }
    if (!key || key.length !== 32) throw storageError();
    return key;
  }
  return {
    async load() {
      try {
        const p = await paths();
        const bytes = await read(p.data, MAX_BYTES);
        if (!bytes) return {};
        if (bytes.length < 30 || bytes[0] !== 1) throw storageError();
        const key = await keyFor(p, false);
        const decipher = crypto.createDecipheriv("aes-256-gcm", key, bytes.subarray(1, 13));
        decipher.setAAD(AAD);
        decipher.setAuthTag(bytes.subarray(13, 29));
        const plaintext = Buffer.concat([decipher.update(bytes.subarray(29)), decipher.final()]);
        const value = JSON.parse(plaintext.toString("utf8"));
        plaintext.fill(0);
        if (!value || typeof value !== "object" || Array.isArray(value)) throw storageError();
        return value;
      } catch {
        throw storageError();
      }
    },
    async save(value) {
      let temp;
      try {
        const p = await paths();
        await fs.mkdir(p.root, { recursive: true, mode: 0o700 });
        // Reject existing symlink targets before replacement.
        await read(p.data, MAX_BYTES);
        const key = await keyFor(p, true);
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
        cipher.setAAD(AAD);
        const plaintext = Buffer.from(JSON.stringify(value));
        const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
        plaintext.fill(0);
        const bytes = Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), encrypted]);
        if (bytes.length > MAX_BYTES) throw storageError();
        temp = path.join(p.root, `quota-oauth.${crypto.randomUUID()}.tmp`);
        await fs.writeFile(temp, bytes, { flag: "wx", mode: 0o600 });
        await fs.rename(temp, p.data);
      } catch {
        throw storageError();
      } finally {
        if (temp) await fs.unlink(temp).catch(() => {});
      }
    },
  };
}

module.exports = { createAuthStore };
