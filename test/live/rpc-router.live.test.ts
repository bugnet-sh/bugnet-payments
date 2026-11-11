/**
 * Mainnet smoke test of the local RPC list (spec 12.3). It moves no money. Every URL of
 * BUGNET_SOLANA_RPC_URLS, named by position, gets the boot checks with the recipient's own USDC
 * history as the probe, the 2021 history as a printed note, a listing with minContextSlot and
 * until together, and readLanding through the router. Every HTTP call is counted, against a cap
 * of 10 + 30 per URL. It runs only with the founder's go (spec 14 step 2.3).
 *
 * No line, assertion or error it prints holds a URL: endpoints are named by position, and a
 * failed call is reduced to its code, status or reason.
 */
import {
    address,
    createDefaultRpcTransport,
    createSolanaRpcFromTransport,
    mainnet,
    type RpcTransport,
    type RpcTransportMainnet,
    signature,
} from "@solana/kit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { formatRpcProbe, probeFails } from "../../src/cli.ts";
import { secretValues } from "../../src/config.ts";
import { jsonLog } from "../../src/log.ts";
import { usdcAta } from "../../src/solana/accounts.ts";
import { readLanding } from "../../src/solana/landing.ts";
import {
    type CheckReport,
    domainOf,
    endpointName,
    type HistoryProbe,
    MAINNET_HISTORY_PROBE,
} from "../../src/solana/router/index.ts";
import {
    createRouterRpc,
    type RoutedRpc,
    rpcErrorFields,
    type SolanaRpc,
} from "../../src/solana/rpc.ts";
import { liveRpcSettings } from "./helpers.ts";

// Spec 12.3: about 55 expected for three URLs
const CAP_BASE = 10;
const CAP_PER_URL = 30;
// A later signature for the address-index check, in another slot well after oldest
const LATER_SLOTS = 150n;
const PAGE = 1_000;

// Vitest's agent reporter drops the console output of passing tests, a direct write always shows
function printLine(line: string): void {
    process.stdout.write(`${line}\n`);
}

// A failed call as its code, status or reason only: a fetch error's cause can name the host
function failure(err: unknown): string {
    const f = rpcErrorFields(err);
    return [f.err, f.code, f.status, f.reason, f.cause].filter((v) => v !== undefined).join(" ");
}

async function outcome(call: Promise<unknown>): Promise<string> {
    try {
        await call;
        return "ok";
    } catch (err) {
        return failure(err);
    }
}

describe("the RPC list on mainnet", () => {
    const { settings, urls, recipient, rpcTimeoutMs } = liveRpcSettings(process.env);
    const log = jsonLog("rpc-router-live", { secrets: secretValues(process.env) });
    let calls = 0;
    const counted = (url: string): RpcTransport => {
        const inner = createDefaultRpcTransport({ url: mainnet(url) });
        return ((config: Parameters<RpcTransport>[0]) => {
            calls += 1;
            return inner(config);
        }) as RpcTransport;
    };
    // Each endpoint on its own, for the per-endpoint calls outside the router
    const direct: SolanaRpc[] = urls.map((url) =>
        createSolanaRpcFromTransport(counted(url) as RpcTransportMainnet),
    );
    let routed: RoutedRpc;
    let recipientAta: string;
    let probe: HistoryProbe;
    let newest: string;
    let report: CheckReport;
    const consistent: Record<string, string> = {};

    beforeAll(async () => {
        recipientAta = await usdcAta(address(recipient));
        // The error is rethrown without its cause, which can name the host
        const listed = await direct[0]!
            .getSignaturesForAddress(address(recipientAta), {
                commitment: "confirmed",
                limit: PAGE,
            })
            .send()
            .then(
                (page) => ({ page, failed: null }),
                (err: unknown) => ({ page: [], failed: failure(err) }),
            );
        if (listed.failed !== null) {
            throw new Error(`rpc1 could not list the recipient's USDC account: ${listed.failed}`);
        }
        // Newest first; oldest is the oldest one that succeeded, so readLanding can find it landed
        const { page } = listed;
        const landed = page.filter((e) => e.err === null);
        const oldest = landed.at(-1);
        if (oldest === undefined) {
            throw new Error("the recipient's USDC account has no payment yet");
        }
        const later = landed.findLast((e) => e.slot >= oldest.slot + LATER_SLOTS);
        probe = {
            address: recipientAta,
            oldest: oldest.signature,
            later: later?.signature ?? null,
        };
        newest = page[0]!.signature;

        routed = createRouterRpc(settings, urls, {
            log,
            now: () => Date.now(),
            random: Math.random,
            transportFor: (_name, url) => counted(url),
            historyProbe: async () => probe,
        });
        report = await routed.router.check();
        for (const e of routed.router.snapshot().endpoints) consistent[e.name] = e.consistent;
    }, 60_000);

    afterAll(async () => {
        await routed?.router.stop();
    });

    it("the list passes the probe's rule", () => {
        const ready = new Set<string>();
        report.endpoints.forEach((c, i) => {
            if (c.history === "ok" && consistent[c.name] === "yes") ready.add(domainOf(urls[i]!));
        });
        const quorum =
            routed.router.mode === "single"
                ? null
                : { ready: ready.size, needed: routed.router.snapshot().absenceQuorum };
        for (const line of formatRpcProbe(report, consistent, quorum)) printLine(line);
        expect(probeFails(report, consistent, quorum)).toBe(false);
    });

    it("the 2021 history is a printed note", async () => {
        const sig = signature(MAINNET_HISTORY_PROBE.signature);
        for (const [i, rpc] of direct.entries()) {
            let note: string;
            try {
                const { value } = await rpc
                    .getSignatureStatuses([sig], { searchTransactionHistory: true })
                    .send();
                const tx = await rpc
                    .getTransaction(sig, {
                        encoding: "base64",
                        commitment: "confirmed",
                        maxSupportedTransactionVersion: 0,
                    })
                    .send();
                note = value[0] != null && tx !== null ? "found" : "missing";
            } catch (err) {
                note = `error ${failure(err)}`;
            }
            printLine(`${endpointName(i)}  2021 history: ${note}`);
        }
    });

    it("minContextSlot with until is accepted", async () => {
        const answers: Record<string, string> = {};
        for (const [i, c] of report.endpoints.entries()) {
            if (consistent[c.name] !== "yes") continue;
            answers[c.name] =
                c.slot === null
                    ? "no confirmed slot from the checks"
                    : await outcome(
                          direct[i]!.getSignaturesForAddress(address(recipientAta), {
                              commitment: "confirmed",
                              minContextSlot: c.slot,
                              until: signature(newest),
                              limit: 10,
                          }).send(),
                      );
            printLine(`${c.name}  minContextSlot with until: ${answers[c.name]}`);
        }
        expect(Object.keys(answers).length).toBeGreaterThan(0);
        expect(Object.values(answers).filter((a) => a !== "ok")).toEqual([]);
    });

    it("readLanding through the router finds the landed payment", async () => {
        const landing = await readLanding(routed.rpc, probe.oldest, 0n, rpcTimeoutMs).then(
            (r) => r.landing,
            (err: unknown) => failure(err),
        );
        printLine(`readLanding of the oldest payment: ${landing}`);
        expect(landing).toBe("landed");
    });

    it("the smoke test spends at most 10 + 30 calls per URL", () => {
        const cap = CAP_BASE + CAP_PER_URL * urls.length;
        printLine(`calls: ${calls} of at most ${cap}`);
        expect(calls).toBeLessThanOrEqual(cap);
    });
});
