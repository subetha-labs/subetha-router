#!/usr/bin/env node
/**
 * lab の `delivery` バイナリの**偽物**（試験基盤）。CLI の形（`main.rs`）だけを真似る: `verifier-serve` は addr-file を tmp → rename で公開し、
 * 環境変数の指示で record.json を書く／止まる／失敗する。`verifier-verify` は verify_result.json を書く。受け取った引数と env を `fake-args.<kind>.json` に残す。
 * 鍵も TLS も無い。
 */
import { existsSync, mkdirSync, openSync, writeSync, closeSync, renameSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

const [sub, ...rest] = process.argv.slice(2);
const kv = new Map();
const flags = [];
for (let i = 0; i < rest.length; i += 1) {
  const key = rest[i];
  if (key === "--require-external-gate") {
    flags.push(key);
    continue;
  }
  if (!key.startsWith("--")) {
    process.stderr.write(`unknown arg ${key}\n`);
    process.exit(2);
  }
  kv.set(key.slice(2), rest[i + 1]);
  i += 1;
}
const dir = kv.get("verifier-dir");
if (!dir) {
  process.stderr.write("missing --verifier-dir\n");
  process.exit(2);
}
mkdirSync(dir, { recursive: true });
function writeNew(file, bytes, mode = 0o644) {
  const fd = openSync(file, "wx", mode);
  writeSync(fd, bytes);
  closeSync(fd);
}
/**
 * 制御は env ではなく **作業ディレクトリの `fake-control.json`**（Router は子に最小の env しか渡さない）:
 * `{mode, delayMs, port, spamBytes, recordSrc, verifyResultSrc}`。無ければ record モード。
 */
let control = {};
for (const candidate of [path.join(dir, "fake-control.json"), path.join(path.dirname(dir), "fake-control.json")]) {
  try {
    control = JSON.parse(readFileSync(candidate, "utf8"));
    break;
  } catch {
    control = {};
  }
}
const mode = control.mode ?? "record";
const delayMs = Number(control.delayMs ?? 100);
writeFileSync(path.join(dir, `fake-args.${sub}.json`), JSON.stringify({ sub, kv: Object.fromEntries(kv), flags, env: { DELIVERY_SRS_DAT: process.env["DELIVERY_SRS_DAT"], RUST_LOG: process.env["RUST_LOG"], umask: process.umask().toString(8), keys: Object.keys(process.env).sort() }, pid: process.pid }));
process.stdout.write(`fake-delivery: ${sub} pid=${process.pid}\n`);
if (control.spamBytes) process.stderr.write("x".repeat(Number(control.spamBytes)));

/**
 * この購入に束縛された record（lab の `types.rs` `VerifierRecord` の形）を、作業ディレクトリの最終注文・intent・release から合成する。
 * 公開 prefix は lab の `request.rs` と同じ直列化。応答ヘッダは `control.receiptHeader`（{name, value}）を載せた 200。
 */
function boundRecord() {
  const sha256 = (b) => createHash("sha256").update(b).digest("hex");
  const order = JSON.parse(readFileSync(kv.get("order"), "utf8"));
  const intentBytes = readFileSync(kv.get("intent"));
  const releaseBytes = readFileSync(kv.get("release"));
  const release = JSON.parse(releaseBytes.toString("utf8"));
  const h = order?.request?.payment_header;
  if (!h || typeof h.name !== "string" || typeof h.value !== "string") return { fake: true, note: "order has no payment header; not a bound record" };
  const isGet = order.request.framing === "phase5-get-public-v1";
  const prefix = isGet
    ? `GET ${order.target.path} HTTP/1.1\r\nHost: ${order.target.host}\r\nConnection: close\r\n${h.name}: ${h.value}\r\n\r\n`
    : `${order.request.method} ${order.target.path} HTTP/1.1\r\nHost: ${order.target.host}\r\nContent-Type: ${order.request.content_type}\r\nContent-Length: ${order.request.body_len}\r\nConnection: close\r\n${h.name}: ${h.value}\r\n${order.request.executor_header}: `;
  const credLen = isGet ? 0 : 39;
  const bodyLen = Number(control.responseBodyLen ?? 196);
  const receipt = control.receiptHeader ?? { name: "PAYMENT-RESPONSE", value: "eyJmYWtlIjp0cnVlfQ" };
  const recv = `HTTP/1.1 ${control.statusLine ?? "200 OK"}\r\nContent-Type: application/json\r\nContent-Length: ${bodyLen}\r\n${receipt.name}: ${receipt.value}\r\nConnection: close\r\n\r\n`;
  const accept = Number(control.tlsAcceptUnixMs ?? Date.now());
  return {
    role: "verifier",
    pid: process.pid,
    listen_addr: "127.0.0.1:40001",
    peer_addr: "127.0.0.1:40002",
    order_id: order.order_id,
    target: order.target,
    trust: control.trust ?? "lab-fixture-ca",
    external_gate: control.trust === "mozilla-webpki-roots",
    server_name: order.target.host,
    committed_hash_hex: control.committedHash ?? "b".repeat(64),
    hash_alg: "SHA256",
    committed_range: [0, bodyLen],
    body_len: bodyLen,
    len_sent: Buffer.byteLength(prefix) + (isGet ? 0 : credLen + 4 + order.request.body_len),
    len_received: Buffer.byteLength(recv) + bodyLen,
    revealed_recv_headers: recv,
    http_framing: "content-length-identity-single-response",
    content_length: bodyLen,
    mpc_tls_ms: 1,
    session_wall_ms: Number(control.sessionWallMs ?? 10),
    order_digest: sha256(JSON.stringify(order)),
    order_fixed_unix_ms: accept - 1,
    tls_accept_unix_ms: accept,
    request: {
      framing: order.request.framing,
      spec: order.request,
      revealed_prefix: prefix,
      prefix_range: [0, Buffer.byteLength(prefix)],
      cred_range: [Buffer.byteLength(prefix), Buffer.byteLength(prefix) + credLen],
      sep_range: [Buffer.byteLength(prefix) + credLen, Buffer.byteLength(prefix) + credLen + 4],
      body_range: [Buffer.byteLength(prefix) + credLen + 4, Buffer.byteLength(prefix) + credLen + 4 + order.request.body_len],
      cred_len: credLen,
      sent_cred_hash_hex: control.sentCredHash ?? "c".repeat(64),
      sent_body_hash_hex: control.sentBodyHash ?? "d".repeat(64),
    },
    intent_binding: { intent_sha256: sha256(intentBytes), release_sha256: sha256(releaseBytes), header_sha256: sha256(h.value), inbound_tx: release.inbound.tx },
  };
}

if (sub === "verifier-serve") {
  for (const key of ["order", "listen", "addr-file", "expect-host", "expect-port", "expect-path", "trust", "timeout-secs", "intent", "release"]) {
    if (!kv.has(key)) {
      process.stderr.write(`missing --${key}\n`);
      process.exit(2);
    }
  }
  if (!String(kv.get("listen")).startsWith("127.0.0.1:")) process.exit(2);
  if (kv.get("expect-port") !== "443") process.exit(2);
  if (existsSync(path.join(dir, "record.json"))) {
    process.stderr.write("record.json exists; refusing to overwrite\n");
    process.exit(1);
  }
  if (!existsSync(kv.get("order")) || !existsSync(kv.get("intent")) || !existsSync(kv.get("release"))) process.exit(2);
  if (mode === "fail-before-addr") process.exit(1);
  const addr = kv.get("addr-file");
  const port = Number(control.port ?? 40001);
  writeNew(`${addr}.tmp`, `127.0.0.1:${port}`);
  renameSync(`${addr}.tmp`, addr);
  if (mode === "hang") {
    setInterval(() => {}, 1_000);
  } else if (mode === "fail") {
    setTimeout(() => process.exit(1), delayMs);
  } else {
    setTimeout(() => {
      const src = control.recordSrc;
      const bytes = src ? readFileSync(src) : Buffer.from(JSON.stringify(boundRecord()));
      writeNew(path.join(dir, "record.json"), bytes);
      process.exit(0);
    }, delayMs);
  }
} else if (sub === "verifier-verify") {
  for (const key of ["order", "bundle", "expect-host", "expect-port", "expect-path", "intent", "release"]) {
    if (!kv.has(key)) {
      process.stderr.write(`missing --${key}\n`);
      process.exit(2);
    }
  }
  if (mode === "hang") {
    setInterval(() => {}, 1_000);
  } else {
    setTimeout(() => {
      const src = control.verifyResultSrc;
      const result = src ? readFileSync(src) : Buffer.from(JSON.stringify({ ok: mode !== "verify-fail", error: mode === "verify-fail" ? "outer_consistency: fake" : null, verify_ms: 1, num_public_inputs: 774, verifier_vk_sha256: "fake", checks: mode === "verify-fail" ? [] : ["UltraHonk delivery proof verified", "request-binding proof verified"] }));
      writeNew(path.join(dir, "verify_result.json"), result);
      process.exit(mode === "verify-fail" ? 1 : 0);
    }, delayMs);
  }
} else {
  process.stderr.write(`unknown subcommand ${sub}\n`);
  process.exit(2);
}
