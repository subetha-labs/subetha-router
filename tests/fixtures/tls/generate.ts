/**
 * 試験用の TLS 素材を**実行時に**作る（`openssl` CLI を使う。鍵も証明書も repo には置かない）。
 * SSRF 防御 A の transport 試験（設計 T-A12）で、証明書検証を有効のままにして固定した IP への HTTPS を確かめる。
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface TlsMaterial {
  readonly dir: string;
  /** 作った鍵と証明書を消す（試験の `afterAll`）。 */
  cleanup(): void;
  readonly ca: string;
  readonly provider: { readonly cert: Buffer; readonly key: Buffer };
  readonly other: { readonly cert: Buffer; readonly key: Buffer };
  readonly untrusted: { readonly cert: Buffer; readonly key: Buffer };
}

function openssl(dir: string, args: readonly string[]): void {
  execFileSync("openssl", [...args], { cwd: dir, stdio: ["ignore", "ignore", "pipe"] });
}

/** CA、CA 署名の `provider.test` / `other.test`、自己署名の `provider.test`（信頼されない）を作る。 */
export function generateTestTls(options: { readonly extraProviderNames?: readonly string[] } = {}): TlsMaterial {
  // `runtime/` の下に置く（リポジトリの外に鍵を残さない）。
  const runtimeRoot = path.resolve(import.meta.dirname, "../../../runtime");
  mkdirSync(runtimeRoot, { recursive: true });
  const dir = mkdtempSync(path.join(runtimeRoot, "test-tls-"));
  const ec = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes"];
  try {
    openssl(dir, ["req", "-x509", ...ec, "-keyout", "ca.key", "-out", "ca.pem", "-days", "2", "-subj", "/CN=subetha-router test CA (not for production)"]);
    for (const name of ["provider.test", "other.test"]) {
      openssl(dir, ["req", ...ec, "-keyout", `${name}.key`, "-out", `${name}.csr`, "-subj", `/CN=${name}`]);
      // 統合試験（T14）は 1 つの Router から複数の fixture（上流 2 つ・facilitator・RPC）へ出るので、両方の証明書に補助の名前も入れる。
      // `extraProviderNames`（任意）: provider の証明書に足す名前（本番の固定の URL のホスト名を fixture に向ける試験用）。
      const extra = name === "provider.test" ? (options.extraProviderNames ?? []).map((host) => `,DNS:${host}`).join("") : "";
      writeFileSync(path.join(dir, `${name}.ext`), `subjectAltName=DNS:${name},DNS:mpp.${name},DNS:facilitator.${name},DNS:rpc.${name},DNS:static.${name},DNS:arc.${name},DNS:sol.${name},DNS:solmpp.${name}${extra}\nbasicConstraints=CA:FALSE\n`);
      openssl(dir, ["x509", "-req", "-in", `${name}.csr`, "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", `${name}.pem`, "-days", "2", "-extfile", `${name}.ext`]);
    }
    openssl(dir, ["req", "-x509", ...ec, "-keyout", "untrusted.key", "-out", "untrusted.pem", "-days", "2", "-subj", "/CN=provider.test", "-addext", "subjectAltName=DNS:provider.test"]);
  } catch (error) {
    // 作りかけの鍵を残さない。
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  const read = (name: string): Buffer => readFileSync(path.join(dir, name));
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
    ca: read("ca.pem").toString("utf8"),
    provider: { cert: read("provider.test.pem"), key: read("provider.test.key") },
    other: { cert: read("other.test.pem"), key: read("other.test.key") },
    untrusted: { cert: read("untrusted.pem"), key: read("untrusted.key") },
  };
}
