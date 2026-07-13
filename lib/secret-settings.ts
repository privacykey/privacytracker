import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { dataDir, isBuildPhase } from "./db";

export const SECRET_SETTING_KEYS: ReadonlySet<string> = new Set([
  "ai_api_key",
  "notification_webhook_url",
]);

const PREFIX = "enc:v1:";
const KEY_PATH = path.join(dataDir, ".secret-key");
let cachedKey: Buffer | undefined;

function injectedKey(): string | undefined {
  const fromEnvironment = process.env.PRIVACYTRACKER_SECRET_KEY;
  if (fromEnvironment) {
    return fromEnvironment;
  }
  if (process.env.PRIVACYTRACKER_SECRET_KEY_STDIN === "1") {
    const value = fs.readFileSync(0, "utf8").trim();
    if (!value) {
      throw new Error("Desktop credential channel was empty");
    }
    return value;
  }
}

function encryptionKey(): Buffer {
  if (cachedKey) {
    return cachedKey;
  }

  const injected = injectedKey();
  if (injected) {
    cachedKey = /^[a-f\d]{64}$/i.test(injected)
      ? Buffer.from(injected, "hex")
      : createHash("sha256").update(injected).digest();
    delete process.env.PRIVACYTRACKER_SECRET_KEY;
    delete process.env.PRIVACYTRACKER_SECRET_KEY_STDIN;
    return cachedKey;
  }

  if (isBuildPhase) {
    cachedKey = randomBytes(32);
    return cachedKey;
  }

  try {
    cachedKey = fs.readFileSync(KEY_PATH);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    const generated = randomBytes(32);
    try {
      fs.writeFileSync(KEY_PATH, generated, { flag: "wx", mode: 0o600 });
      cachedKey = generated;
    } catch (writeError) {
      if ((writeError as NodeJS.ErrnoException).code !== "EEXIST") {
        throw writeError;
      }
      cachedKey = fs.readFileSync(KEY_PATH);
    }
  }

  if (cachedKey.length !== 32) {
    throw new Error(`Invalid secret key at ${KEY_PATH}`);
  }
  if (process.platform !== "win32") {
    fs.chmodSync(KEY_PATH, 0o600);
  }
  return cachedKey;
}

export function isEncryptedSecret(value: string): boolean {
  return value.startsWith(PREFIX);
}

export function encryptSecret(key: string, value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  cipher.setAAD(Buffer.from(key));
  const encrypted = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  return `${PREFIX}${iv.toString("base64url")}.${cipher
    .getAuthTag()
    .toString("base64url")}.${encrypted.toString("base64url")}`;
}

export function decryptSecret(key: string, value: string): string {
  const [ivRaw, tagRaw, encryptedRaw, extra] = value
    .slice(PREFIX.length)
    .split(".");
  if (!(ivRaw && tagRaw && encryptedRaw) || extra !== undefined) {
    throw new Error("Invalid encrypted setting");
  }

  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
    Buffer.from(ivRaw, "base64url")
  );
  decipher.setAAD(Buffer.from(key));
  decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedRaw, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
