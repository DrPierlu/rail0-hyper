import { createHmac } from "node:crypto";

export function hmacHeaders(secret: string, body: string): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return {
    "Content-Type": "application/json",
    "X-Rail0-Timestamp": timestamp,
    "X-Rail0-Signature": signature,
  };
}
