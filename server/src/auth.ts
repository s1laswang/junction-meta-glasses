// Optional shared access key (HOLDUP_KEY). When set, /api/* (except /api/health), /ingest/*, /live and /hud-ws
// need `?key=<k>` or an `x-holdup-key` header. Static files stay public. Unset = open (unchanged behaviour).
import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { NextFunction, Request, Response } from "express";
import { log } from "./log.ts";

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest();

export function authEnabled() { return !!process.env.HOLDUP_KEY; }

/** Constant-time comparison (hashing first makes lengths equal). */
export function keyOk(provided: string | null | undefined): boolean {
  const want = process.env.HOLDUP_KEY;
  if (!want) return true;
  if (typeof provided !== "string" || !provided) return false;
  return timingSafeEqual(sha(provided), sha(want));
}

function keyFrom(query: string | null | undefined, header: string | string[] | undefined) {
  return query ?? (Array.isArray(header) ? header[0] : header) ?? null;
}

export function requireKey(req: Request, res: Response, next: NextFunction) {
  const full = req.baseUrl + req.path; // mounted at /api and /ingest, so req.path alone is relative
  if (!authEnabled() || full === "/api/health") return next();
  const q = typeof req.query.key === "string" ? req.query.key : null;
  if (keyOk(keyFrom(q, req.headers["x-holdup-key"]))) return next();
  log("auth.rejected", { kind: "http", path: full.slice(0, 32), had_key: !!(q || req.headers["x-holdup-key"]) });
  res.status(401).json({ type: "error", code: "unauthorized", message: "access key required", recoverable: false });
}

export function wsKeyOk(req: IncomingMessage, url: URL): boolean {
  if (!authEnabled()) return true;
  const ok = keyOk(keyFrom(url.searchParams.get("key"), req.headers["x-holdup-key"]));
  if (!ok) log("auth.rejected", { kind: "ws", path: url.pathname, had_key: !!(url.searchParams.get("key") || req.headers["x-holdup-key"]) });
  return ok;
}
