import { createPublicClient, http, parseAbi, hashTypedData, keccak256, toHex, encodeAbiParameters, zeroAddress, getAddress } from "viem";
const chains = [
  ["robinhood", 46630, "https://rpc.testnet.chain.robinhood.com", "0x7E955252E15c84f5768B83c41a71F9eba181802F"],
  ["arb-sepolia", 421614, "https://sepolia-rollup.arbitrum.io/rpc", "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d"],
  ["hyperevm-testnet", 998, "https://rpc.hyperliquid-testnet.xyz/evm", "0x2B3370eE501B4a559b57D449569354196457D8Ab"],
  ["eth-sepolia", 11155111, "https://ethereum-sepolia-rpc.publicnode.com", "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238"],
];
const abi = parseAbi([
  "function name() view returns (string)", "function symbol() view returns (string)", "function decimals() view returns (uint8)",
  "function version() view returns (string)", "function DOMAIN_SEPARATOR() view returns (bytes32)",
  "function eip712Domain() view returns (bytes1,string,string,uint256,address,bytes32,uint256[])",
  "function authorizationState(address,bytes32) view returns (bool)",
  "function TRANSFER_WITH_AUTHORIZATION_TYPEHASH() view returns (bytes32)",
  "function RECEIVE_WITH_AUTHORIZATION_TYPEHASH() view returns (bytes32)",
  "function totalSupply() view returns (uint256)",
  "function transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)",
  "function transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,bytes)",
]);
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const OZ_LEGACY = "0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3"; // zeppelinos impl slot (Circle FiatTokenProxy)
for (const [label, id, url, token] of chains) {
  const c = createPublicClient({ transport: http(url, { timeout: 15000 }) });
  const out = { label, chainId: await c.getChainId(), token };
  const code = await c.getCode({ address: token }); out.codeBytes = code ? (code.length - 2) / 2 : 0;
  for (const slot of [IMPL_SLOT, OZ_LEGACY]) { const v = await c.getStorageAt({ address: token, slot }); if (v && BigInt(v) !== 0n) out["impl@" + slot.slice(0, 8)] = "0x" + v.slice(-40); }
  const call = async (fn, args = []) => { try { return await c.readContract({ address: token, abi, functionName: fn, args }); } catch (e) { return "ERR:" + (e.shortMessage ?? e.message).split("\n")[0].slice(0, 90); } };
  for (const fn of ["name", "symbol", "decimals", "version", "DOMAIN_SEPARATOR", "eip712Domain", "TRANSFER_WITH_AUTHORIZATION_TYPEHASH", "RECEIVE_WITH_AUTHORIZATION_TYPEHASH", "totalSupply"]) out[fn] = await call(fn);
  out.authorizationState = await call("authorizationState", [zeroAddress, "0x" + "11".repeat(32)]);
  // recompute domain separator from name/version
  if (typeof out.name === "string") {
    for (const v of [out.version, "1", "2"].filter((x) => typeof x === "string" && !x.startsWith("ERR"))) {
      const ds = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
        [keccak256(toHex("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")), keccak256(toHex(out.name)), keccak256(toHex(v)), BigInt(id), getAddress(token)]));
      if (ds === out.DOMAIN_SEPARATOR) out.domainMatches = { name: out.name, version: v };
    }
  }
  // simulate transferWithAuthorization (v,r,s) with junk sig: revert reason tells if function exists
  try { await c.simulateContract({ address: token, abi, functionName: "transferWithAuthorization", args: ["0x000000000000000000000000000000000000dEaD", "0x000000000000000000000000000000000000bEEF", 1n, 0n, 2n ** 40n, "0x" + "22".repeat(32), 27, "0x" + "33".repeat(32), "0x" + "44".repeat(32)], account: "0x000000000000000000000000000000000000c0DE" }); out.twaSim = "no revert?!"; } catch (e) { out.twaSim = (e.shortMessage ?? e.message).split("\n").slice(0, 3).join(" | ").slice(0, 200); }
  console.log(JSON.stringify(out, (k, v) => typeof v === "bigint" ? v.toString() : v, 1));
}
