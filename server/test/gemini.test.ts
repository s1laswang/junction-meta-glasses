import http from "node:http";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ProxyAwareHttpsAgent,
  Semaphore,
  backoffMs,
  classify,
  shouldBypassProxy,
  sleep,
  type ErrKind,
} from "../src/gemini.ts";

test("shouldBypassProxy handles loopback hosts and ports", () => {
  assert.equal(shouldBypassProxy("localhost", ""), true);
  assert.equal(shouldBypassProxy("LOCALHOST:8787", ""), true);
  assert.equal(shouldBypassProxy("app.localhost", ""), true);
  assert.equal(shouldBypassProxy("127.0.0.1", ""), true);
  assert.equal(shouldBypassProxy("127.0.0.1:8787", ""), true);
  assert.equal(shouldBypassProxy("::1", ""), true);
  assert.equal(shouldBypassProxy("[::1]", ""), true);
  assert.equal(shouldBypassProxy("[::1]:8787", ""), true);
  assert.equal(shouldBypassProxy("", ""), true);
  assert.equal(shouldBypassProxy("generativelanguage.googleapis.com", ""), false);
});

test("shouldBypassProxy matches domain, suffix, wildcard, CIDR, and env NO_PROXY / no_proxy", () => {
  const list = "example.com, .corp.internal, *.svc.local, 10.11.0.0/16";
  assert.equal(shouldBypassProxy("example.com", list), true);
  assert.equal(shouldBypassProxy("api.example.com:443", list), true);
  assert.equal(shouldBypassProxy("badexample.com", list), false);
  assert.equal(shouldBypassProxy("corp.internal", list), true);
  assert.equal(shouldBypassProxy("deep.sub.corp.internal", list), true);
  assert.equal(shouldBypassProxy("auth.svc.local", list), true);
  assert.equal(shouldBypassProxy("10.11.42.9", list), true);
  assert.equal(shouldBypassProxy("10.12.0.1", list), false);
  assert.equal(shouldBypassProxy("generativelanguage.googleapis.com", "*"), true);

  const prevUpper = process.env.NO_PROXY;
  const prevLower = process.env.no_proxy;
  try {
    process.env.NO_PROXY = "internal.upper";
    delete process.env.no_proxy;
    assert.equal(shouldBypassProxy("api.internal.upper"), true);
    assert.equal(shouldBypassProxy("generativelanguage.googleapis.com"), false);

    delete process.env.NO_PROXY;
    process.env.no_proxy = ".internal.lower";
    assert.equal(shouldBypassProxy("svc.internal.lower"), true);
    assert.equal(shouldBypassProxy("generativelanguage.googleapis.com"), false);
  } finally {
    if (prevUpper === undefined) delete process.env.NO_PROXY;
    else process.env.NO_PROXY = prevUpper;
    if (prevLower === undefined) delete process.env.no_proxy;
    else process.env.no_proxy = prevLower;
  }
});

test("ProxyAwareHttpsAgent delegates local hosts to directAgent and external hosts to proxyAgent", () => {
  const proxyUrl = "http:\x2f\x2f127.0.0.1:3128";
  const agent = new ProxyAwareHttpsAgent(proxyUrl);
  const calls: { target: "direct" | "proxy"; opts: Record<string, unknown> }[] = [];

  (agent.directAgent as any).addRequest = (_req: http.ClientRequest, opts: Record<string, unknown>) => {
    calls.push({ target: "direct", opts });
  };
  (agent.proxyAgent as any).addRequest = (_req: http.ClientRequest, opts: Record<string, unknown>) => {
    calls.push({ target: "proxy", opts });
  };

  const fakeReq = {} as http.ClientRequest;
  agent.addRequest(fakeReq, { host: "localhost", port: 8787 });
  agent.addRequest(fakeReq, { hostname: "127.0.0.1", port: 8787 });
  agent.addRequest(fakeReq, { host: "generativelanguage.googleapis.com", port: 443 });

  assert.equal(calls.length, 3);
  assert.equal(calls[0].target, "direct");
  assert.equal(calls[1].target, "direct");
  assert.equal(calls[2].target, "proxy");
  assert.equal(calls[2].opts.secureEndpoint, true);
  agent.destroy();
});

test("Semaphore enforces concurrency cap and releases slots on error", async () => {
  const sem = new Semaphore(2);
  let active = 0;
  let peak = 0;

  const results = await Promise.all(
    [1, 2, 3, 4, 5, 6].map((n) =>
      sem.run(async () => {
        active++;
        if (active > peak) peak = active;
        await sleep(15);
        active--;
        return n * 2;
      }),
    ),
  );

  assert.equal(peak, 2);
  assert.equal(active, 0);
  assert.deepEqual(results, [2, 4, 6, 8, 10, 12]);

  await assert.rejects(
    sem.run(async () => {
      throw new Error("boom");
    }),
    /boom/,
  );

  const afterError = await sem.run(async () => "recovered");
  assert.equal(afterError, "recovered");
});

test("classify maps errors to all ErrKind categories", () => {
  const cases: [unknown, ErrKind][] = [
    [{ status: 429, message: "Too Many Requests" }, "quota"],
    [new Error("RESOURCE_EXHAUSTED: quota exceeded"), "quota"],
    [{ status: 404, message: "Not Found" }, "not_found"],
    [new Error("Model is no longer available"), "not_found"],
    [Object.assign(new Error("aborted"), { name: "AbortError" }), "timeout"],
    [new Error("Request timed out after 8000ms"), "timeout"],
    [new Error("empty reply"), "empty"],
    [{ status: 400, message: "Bad Request" }, "bad_request"],
    [new Error("INVALID_ARGUMENT: invalid schema"), "bad_request"],
    [{ status: 503, message: "Service Unavailable" }, "server"],
    [new Error("500 INTERNAL error"), "server"],
    [new Error("getaddrinfo ENOTFOUND generativelanguage.googleapis.com"), "network"],
    ["ECONNRESET", "network"],
  ];

  for (const [err, expected] of cases) {
    assert.equal(classify(err), expected);
  }
});

test("backoffMs stays within jitter bounds and respects cap", () => {
  for (let i = 0; i < 100; i++) {
    const b0 = backoffMs(0, 500, 8000);
    assert.ok(Number.isInteger(b0) && b0 >= 0 && b0 <= 500);

    const b2 = backoffMs(2, 500, 8000);
    assert.ok(Number.isInteger(b2) && b2 >= 0 && b2 <= 2000);

    const b10 = backoffMs(10, 500, 8000);
    assert.ok(Number.isInteger(b10) && b10 >= 0 && b10 <= 8000);
  }
});
