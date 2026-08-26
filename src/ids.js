import crypto from "node:crypto";

export function makeId(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString("hex")}`;
}
