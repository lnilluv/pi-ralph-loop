import { basename } from "node:path";

const SECRET_PATH_SEGMENTS = new Set(["secret", "secrets", "credential", "credentials", ".aws", ".ssh"]);
const SECRET_BASENAMES = new Set([".npmrc", ".pypirc", ".netrc", "authorized_keys", "known_hosts", "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"]);
const SECRET_SUFFIXES = [".pem", ".key", ".crt", ".cer", ".der", ".p12", ".pfx", ".jks", ".keystore", ".asc"];

function toPosixPath(value: string): string {
  return value.replace(/\\/g, "/");
}

function isSecretBearingSegment(segment: string): boolean {
  return SECRET_PATH_SEGMENTS.has(segment) || segment.includes("secret") || segment.includes("credential");
}

export function isSecretBearingPath(relativePath: string): boolean {
  const normalizedPath = toPosixPath(relativePath).toLowerCase();
  if (!normalizedPath || normalizedPath.startsWith("..")) return false;

  const segments = normalizedPath.split("/").filter(Boolean);
  if (segments.some((segment) => isSecretBearingSegment(segment))) return true;

  const normalizedName = basename(normalizedPath);
  return (
    normalizedName.startsWith(".env") ||
    SECRET_BASENAMES.has(normalizedName) ||
    SECRET_SUFFIXES.some((suffix) => normalizedName.endsWith(suffix)) ||
    normalizedName.includes("secret") ||
    normalizedName.includes("credential")
  );
}

export function isSecretBearingTopLevelName(name: string): boolean {
  return isSecretBearingPath(name);
}

export function filterSecretBearingTopLevelNames(names: string[]): string[] {
  return names.filter((name) => !isSecretBearingTopLevelName(name));
}
