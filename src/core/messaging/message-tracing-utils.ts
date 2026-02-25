import { randomUUID } from "node:crypto";

export function generateTraceId(): string {
  return `t_${randomUUID().slice(0, 8)}`;
}

export function generateSlashRequestId(): string {
  return `sr_${randomUUID().slice(0, 8)}`;
}
